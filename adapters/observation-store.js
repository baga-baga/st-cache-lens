/** Bounded local metadata archive. Narrative context and transport details never enter storage. */
import { redactedExport, compactDiagnostic, numericUsage, observationLayer } from './reporting.js';

const FORMAT = 'cache-lens-redacted-observations';
const VERSION = 1;
const queues = new WeakMap();
const MAX_PARSE_BYTES = 32 * 1024 * 1024;
const statusNames = new Set(['unknown', 'pending', 'reserved', 'complete', 'completed', 'observed', 'imported', 'http-error', 'network-error', 'stream-error', 'request-error', 'observation-error', 'failed', 'error', 'ok', 'cancelled', 'aborted', 'sent']);
const completionNames = new Set(['pending', 'complete', 'client-disconnected', 'error']);
const diagnosticCodes = new Set(['SUMMARY_POSITION_MOVED', 'SUMMARY_REWRITE', 'SUMMARY_TEXT_CHANGED', 'RELATIVE_TIME_TEXT_CHANGED', 'REQUEST_CONFIGURATION_CHANGED', 'INCOMPARABLE_REQUEST_GROUP', 'CONTEXT_PREFIX_CHANGED', 'STABLE_EXPLICIT_BREAKPOINT', 'EXACT_DUPLICATE_BLOCK', 'EXACT_DUPLICATE_SOURCE', 'LARGE_BOOK_TOTAL', 'ACTIVATED_OVER_BUDGET', 'SENT_INPUT_OVER_LIMIT', 'ACTIVATED_INPUT_OVER_LIMIT']);
const severities = new Set(['info', 'notice', 'warning', 'error']);
const kinds = new Set(['structure', 'content', 'append', 'removal']);
const priceKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite30m', 'cacheWrite12h'];
const pathPattern = /^(?:tools|system|messages|input|prompt|instructions)(?:(?:\[(?:0|[1-9]\d{0,7})\])|\.(?:content|text))*$/;
const suspiciousId = /(?:sk-[a-z0-9_-]{8,}|bearer|api[_-]?key|access[_-]?token|authorization|password|secret)/i;
const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const safeStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : statusNames.has(value) ? value : null;
const archiveError = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const byteLength = value => new TextEncoder().encode(value).byteLength;

async function safeId(value) {
    if (typeof value !== 'string' || !value) throw archiveError('OBSERVATION_ID_REQUIRED', '观察记录缺少有效内部 ID，未保存。');
    if (value.length <= 180 && /^[A-Za-z0-9/:._-]+$/.test(value) && !suspiciousId.test(value)) return value;
    if (!globalThis.crypto?.subtle) throw archiveError('OBSERVATION_HASH_UNAVAILABLE', '当前浏览器缺少安全散列接口，无法脱敏记录 ID；未保存。');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return 'hashed:' + Array.from(new Uint8Array(digest), part => part.toString(16).padStart(2, '0')).join('');
}

function sanitizeDiagnostic(value) {
    const raw = value && typeof value === 'object' ? value : {};
    // Older compact versions used `path`; keep repeat read/write cycles idempotent.
    const first = raw.firstDifference;
    const normalized = compactDiagnostic({ ...raw, firstDifference: first ? { ...first, currentPath: first.currentPath ?? first.path } : null });
    const difference = normalized.firstDifference;
    const path = difference?.path ?? difference?.currentPath;
    const diagnostic = {
        stablePrefixCharacters: finiteNonnegative(normalized.stablePrefixCharacters) ? normalized.stablePrefixCharacters : null,
        appendOnly: normalized.appendOnly === true,
        ...(typeof normalized.equal === 'boolean' ? { equal: normalized.equal } : {}),
        ...(typeof normalized.comparable === 'boolean' ? { comparable: normalized.comparable } : {}),
        firstDifference: difference ? {
            path: typeof path === 'string' && pathPattern.test(path) ? path : null,
            kind: kinds.has(difference.kind) ? difference.kind : null,
            ...(Number.isSafeInteger(difference.offset) && difference.offset >= 0 ? { offset: difference.offset } : {}),
        } : null,
        findings: (Array.isArray(normalized.findings) ? normalized.findings : []).slice(0, 64).filter(item => diagnosticCodes.has(item?.code)).map(item => ({ code: item.code, severity: severities.has(item.severity) ? item.severity : 'notice' })),
        needsAnotherRequest: normalized.needsAnotherRequest === true || raw.needsAnotherRequest === true,
        observation: 'local-diagnostic-not-cache-hit-proof',
    };
    if (normalized.comparison && typeof normalized.comparison === 'object') {
        diagnostic.comparison = { previousStartedAt: isoTime(normalized.comparison.previousStartedAt), previousStatus: safeStatus(normalized.comparison.previousStatus) };
    }
    return diagnostic;
}

function sanitizePrices(prices) {
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return undefined;
    const snapshot = redactedExport({ prices: { snapshot: prices } }).prices.snapshot;
    if (!/^[A-Z]{3}$/.test(snapshot.currency)) return undefined;
    const result = { currency: snapshot.currency };
    if (snapshot.source && /^https?:\/\//.test(snapshot.source)) result.source = snapshot.source;
    result.sourceProvided = snapshot.sourceProvided === true || prices.sourceProvided === true;
    if (typeof snapshot.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(snapshot.updatedAt) && Number.isFinite(Date.parse(snapshot.updatedAt))) result.updatedAt = snapshot.updatedAt;
    for (const key of priceKeys) if (finiteNonnegative(snapshot[key])) result[key] = snapshot[key];
    return result;
}

async function sanitizeRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw archiveError('OBSERVATION_RECORD_INVALID', '观察记录格式无效，未保存。');
    const base = redactedExport({ records: [record], diagnosticFor: item => item.diagnostic || {} }).records[0];
    const layer = observationLayer(record);
    const result = {
        id: await safeId(record.id),
        model: base.model,
        provider: base.provider,
        interfaceType: base.interfaceType,
        purpose: base.purpose,
        observationLevel: { frontend: 'frontend', relay: 'server-relay', agent: 'agent-server', import: 'imported' }[layer],
        startedAt: isoTime(base.startedAt),
        latencyMs: finiteNonnegative(base.latencyMs) ? base.latencyMs : null,
        usage: numericUsage(base.usage),
        status: safeStatus(record.status),
        transformed: record.transformed === true,
        manualPurpose: record.manualPurpose === true,
        imported: record.imported === true || layer === 'import',
        synthetic: record.synthetic === true || record.replay === true || record.predicted === true || record.evidence === 'offline-preview',
        platformBill: base.platformBill,
        diagnostic: sanitizeDiagnostic(record.diagnostic),
    };
    if (completionNames.has(record.completion)) result.completion = record.completion;
    if (result.imported && safeStatus(record.reportedStatus) !== null) result.reportedStatus = safeStatus(record.reportedStatus);
    const prices = sanitizePrices(record.prices);
    if (prices) result.prices = prices;
    return result;
}

/**
 * Callers MUST supply an account-specific key and the desired storage surface.
 * read/upsert return fresh, redacted metadata arrays. No prompt context is persisted.
 * Corrupt input or quota errors throw; a corrupt archive is never silently replaced.
 * Writes require Web Locks for cross-tab serialization; without them only read() is available.
 */
export function createObservationStore({ storage, key, locks = globalThis.navigator?.locks, maxRecords = 1000, maxBytes = 2 * 1024 * 1024 } = {}) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') throw new TypeError('storage must provide getItem, setItem and removeItem');
    if (typeof key !== 'string' || !key || key.length > 512) throw new TypeError('An explicit account-specific storage key is required');
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000 || !Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > MAX_PARSE_BYTES) throw new RangeError('Invalid observation archive bounds');
    const lockName = `cache-lens-observation:${key}`;
    const encode = records => JSON.stringify({ schemaVersion: VERSION, kind: FORMAT, records });
    function bound(records) {
        const retained = records.map((record, index) => ({ record, index })).sort((a, b) => (Date.parse(a.record.startedAt || '') || 0) - (Date.parse(b.record.startedAt || '') || 0) || a.index - b.index).map(item => item.record).slice(-maxRecords);
        while (retained.length && byteLength(encode(retained)) > maxBytes) retained.shift();
        if (byteLength(encode(retained)) > maxBytes) throw archiveError('OBSERVATION_LIMIT_TOO_SMALL', '观察记录保存上限过小。');
        return retained;
    }
    async function load() {
        let serialized;
        try { serialized = await storage.getItem(key); } catch (error) { throw archiveError('OBSERVATION_STORAGE_READ_FAILED', '无法读取本地观察记录。', error); }
        if (serialized === null || serialized === undefined) return [];
        if (typeof serialized !== 'string' || byteLength(serialized) > MAX_PARSE_BYTES) throw archiveError('OBSERVATION_ARCHIVE_CORRUPT', '本地观察记录损坏或异常膨胀；请先导出或明确清空，未覆盖。');
        let envelope;
        try { envelope = JSON.parse(serialized); } catch (error) { throw archiveError('OBSERVATION_ARCHIVE_CORRUPT', '本地观察记录不是有效 JSON；未覆盖。', error); }
        if (!envelope || envelope.schemaVersion !== VERSION || envelope.kind !== FORMAT || !Array.isArray(envelope.records) || envelope.records.length > 10000) throw archiveError('OBSERVATION_ARCHIVE_CORRUPT', '本地观察记录版本或结构无效；未覆盖。');
        try {
            const sanitized = await Promise.all(envelope.records.map(sanitizeRecord));
            const unique = new Map();
            for (const record of sanitized) unique.set(record.id, record);
            return bound([...unique.values()]);
        } catch (error) {
            if (error.code === 'OBSERVATION_HASH_UNAVAILABLE') throw error;
            throw archiveError('OBSERVATION_ARCHIVE_CORRUPT', '本地观察记录包含无效条目；未覆盖。', error);
        }
    }
    function requireWriteLock() {
        if (typeof locks?.request !== 'function') throw archiveError('OBSERVATION_LOCKS_REQUIRED', '浏览器未提供 Web Locks；为避免多标签页覆盖，已禁止写入和清空存档。请通过 localhost 或 HTTPS 打开酒馆后重试。');
    }
    function serializedOperation(work) {
        let byKey = queues.get(storage);
        if (!byKey) { byKey = new Map(); queues.set(storage, byKey); }
        const previous = byKey.get(key) || Promise.resolve();
        const operation = previous.then(() => typeof locks?.request === 'function' ? locks.request(lockName, { mode: 'exclusive' }, work) : work());
        const settled = operation.then(() => undefined, () => undefined);
        byKey.set(key, settled);
        void settled.then(() => { if (byKey.get(key) === settled) byKey.delete(key); });
        return operation;
    }
    return {
        read() { return serializedOperation(load); },
        upsert(records) {
            return serializedOperation(async () => {
                requireWriteLock();
                if (!Array.isArray(records) || records.length > 10000) throw archiveError('OBSERVATION_RECORD_INVALID', '观察记录必须是有界数组。');
                const current = await load();
                const incoming = await Promise.all(records.map(sanitizeRecord));
                const byId = new Map(current.map(record => [record.id, record]));
                for (const [index, record] of incoming.entries()) {
                    const previous = byId.get(record.id);
                    if (previous) {
                        if (previous.manualPurpose && !record.manualPurpose) { record.purpose = previous.purpose; record.manualPurpose = true; }
                        // Metadata refreshes must not erase known usage, historical rates or trust taints.
                        if (!record.usage && previous.usage) record.usage = previous.usage;
                        if (!record.prices && previous.prices) record.prices = previous.prices;
                        if (!record.platformBill && previous.platformBill) record.platformBill = previous.platformBill;
                        if (!record.reportedStatus && previous.reportedStatus) record.reportedStatus = previous.reportedStatus;
                        if (!records[index].diagnostic) record.diagnostic = previous.diagnostic;
                        if (!record.startedAt) record.startedAt = previous.startedAt;
                        if (record.latencyMs === null) record.latencyMs = previous.latencyMs;
                        if (['pending', 'reserved', null].includes(record.status) && !['pending', 'reserved', null].includes(previous.status)) record.status = previous.status;
                        if (record.completion === 'pending' && previous.completion && previous.completion !== 'pending') record.completion = previous.completion;
                        record.synthetic ||= previous.synthetic;
                        record.imported ||= previous.imported;
                        if (record.imported) record.observationLevel = 'imported';
                    }
                    byId.set(record.id, record);
                }
                const retained = bound([...byId.values()]);
                try { await storage.setItem(key, encode(retained)); } catch (error) { throw archiveError('OBSERVATION_STORAGE_WRITE_FAILED', '本地观察记录保存失败（可能超出浏览器配额）；原记录未主动清空。', error); }
                return retained;
            });
        },
        clear() {
            return serializedOperation(async () => {
                requireWriteLock();
                try { await storage.removeItem(key); } catch (error) { throw archiveError('OBSERVATION_STORAGE_CLEAR_FAILED', '无法清空本地观察记录。', error); }
                return [];
            });
        },
    };
}
