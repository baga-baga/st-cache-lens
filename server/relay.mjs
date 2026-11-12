import http from 'node:http';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openUpstream } from './network.mjs';
import { getInputSafetyBound } from './input-guard.mjs';

const VISIBILITY = 'Observed request body at the local relay after SillyTavern conversion; upstream internal routing and transformations remain invisible.';
const BODY_KEYS = new Set(['model', 'system', 'messages', 'tools', 'tool_choice', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k', 'stop', 'stop_sequences', 'stream', 'stream_options', 'cache_control', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'functions', 'function_call', 'thinking', 'output_config', 'output_format', 'response_format', 'reasoning', 'reasoning_effort', 'context_management', 'service_tier', 'input', 'instructions', 'previous_response_id', 'conversation', 'truncation', 'parallel_tool_calls', 'modalities', 'audio', 'prediction', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'n', 'store', 'include', 'user']);
const SECRET_KEYS = /^(api[-_]?key|authorization|x[-_]api[-_]key|access[-_]token|refresh[-_]token|password|secret|relayToken)$/i;
const TOKEN_MIN = 24;

function clone(value) { return structuredClone(value); }
function cleanKnownSecrets(value, depth = 0) {
    if (depth > 48) return '[depth limit]';
    if (Array.isArray(value)) return value.map(v => cleanKnownSecrets(v, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.test(key)).map(([key, val]) => [key, cleanKnownSecrets(val, depth + 1)]));
    }
    return value;
}
function projectBody(body) {
    const included = Object.fromEntries(Object.entries(body).filter(([key]) => BODY_KEYS.has(key)));
    return { body: clone(included), omittedRequestFields: Object.keys(body).filter(key => !BODY_KEYS.has(key)) };
}
function equalToken(candidate, expected) {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
function authorized(req, token) {
    const auth = req.headers.authorization;
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return equalToken(bearer, token) || equalToken(req.headers['x-api-key'], token);
}
function sendJson(res, code, data) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
}
function boundedInteger(value, fallback, min, max) {
    const n = Number(value ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid numeric relay limit (allowed ${min}..${max})`);
    return n;
}
function prepareConfig(input) {
    const config = { ...input };
    config.host = config.host ?? '127.0.0.1';
    if (!['127.0.0.1', '::1'].includes(config.host)) throw new Error('Relay must bind to loopback only');
    if (!['anthropic', 'openai'].includes(config.interfaceType)) throw new Error('interfaceType must be anthropic or openai');
    const url = new URL(config.upstreamBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid upstream base URL');
    config.upstreamBaseUrl = url.toString().replace(/\/$/, '');
    config.apiKey = config.apiKey ?? process.env[config.apiKeyEnv ?? 'CACHE_LENS_UPSTREAM_KEY'];
    config.relayToken = config.relayToken ?? process.env[config.relayTokenEnv ?? 'CACHE_LENS_RELAY_TOKEN'];
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0 || /[\r\n]/.test(config.apiKey)) throw new Error('Upstream API key is missing or invalid');
    if (typeof config.relayToken !== 'string' || Buffer.byteLength(config.relayToken) < TOKEN_MIN || /[\r\n]/.test(config.relayToken)) throw new Error('Local relay token must have at least 24 bytes');
    config.port = boundedInteger(config.port, 8937, 0, 65535);
    config.maxInputBytes = boundedInteger(config.maxInputBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024);
    config.maxRecords = boundedInteger(config.maxRecords, 20, 1, 100);
    config.maxStoredBytes = boundedInteger(config.maxStoredBytes, 32 * 1024 * 1024, 1024, 256 * 1024 * 1024);
    config.maxResponseBufferBytes = boundedInteger(config.maxResponseBufferBytes, 1024 * 1024, 1024, 4 * 1024 * 1024);
    config.timeoutMs = boundedInteger(config.timeoutMs, 180000, 1000, 900000);
    for (const key of ['maxInputTokens', 'contextTokens']) {
        config[key] = config[key] == null ? null : boundedInteger(config[key], null, 1, Number.MAX_SAFE_INTEGER);
    }
    config.outputReserveTokens = boundedInteger(config.outputReserveTokens, 0, 0, Number.MAX_SAFE_INTEGER);
    if (config.contextTokens != null && config.outputReserveTokens >= config.contextTokens) throw new Error('Output reserve must be smaller than the context ceiling');
    config.modelPurpose = config.modelPurpose ?? {};
    if (!config.modelPurpose || Array.isArray(config.modelPurpose) || typeof config.modelPurpose !== 'object') throw new Error('modelPurpose must be an object');
    for (const purpose of Object.values(config.modelPurpose)) if (!['main', 'summary', 'agent', 'unknown'].includes(purpose)) throw new Error('Unsupported purpose mapping');
    return config;
}
function inputGuardReport(body, config, pathname) {
    if (config.maxInputTokens == null && config.contextTokens == null) return { enabled: false, exact: false, note: 'No token/context ceiling configured; byte-size limit still applies.' };
    const safety = getInputSafetyBound(body, { interfaceType: pathname === '/v1/responses' ? 'openai-responses' : config.interfaceType });
    const report = { enabled: true, exact: false, method: 'UTF-8 bytes of complete JSON request + 4096; conservative bound, not exact tokens',
        maxInputTokens: config.maxInputTokens, contextTokens: config.contextTokens, configuredOutputReserveTokens: config.outputReserveTokens,
        supportedTextOnly: safety.supported, unsupportedReason: safety.reason ?? null, value: null, allowedInput: null, ok: false };
    const caps = ['max_tokens', 'max_output_tokens', 'max_completion_tokens'].filter(key => body[key] != null).map(key => body[key]);
    if (caps.some(value => !Number.isSafeInteger(value) || value < 0) || (config.contextTokens != null && !caps.length && config.outputReserveTokens <= 0)) {
        report.errorCode = 'output_reserve_unbounded'; return report;
    }
    const reserve = Math.max(config.outputReserveTokens, ...caps, 0);
    report.outputReserveTokens = reserve;
    report.allowedInput = Math.min(config.maxInputTokens ?? Number.MAX_SAFE_INTEGER, config.contextTokens == null ? Number.MAX_SAFE_INTEGER : config.contextTokens - reserve);
    if (!report.supportedTextOnly) { report.errorCode = 'input_bound_unavailable'; return report; }
    report.value = safety.upperBoundTokens;
    report.ok = report.value <= report.allowedInput;
    if (!report.ok) report.errorCode = 'input_token_bound_exceeded';
    return report;
}
function enforceInputGuard(record, body, config, pathname) {
    record.inputGuard = inputGuardReport(body, config, pathname);
    if (record.inputGuard.enabled && !record.inputGuard.ok) {
        const statusCode = record.inputGuard.errorCode === 'input_token_bound_exceeded' ? 413 : 422;
        throw Object.assign(new Error(record.inputGuard.errorCode), { statusCode, safeCode: record.inputGuard.errorCode });
    }
}

function finalUrl(base, path) {
    const url = new URL(base);
    const existing = url.pathname.replace(/\/$/, '');
    // Both provider roots and bases ending /v1 are supported. Preserve a fixed custom path prefix.
    url.pathname = `${existing}${existing.endsWith('/v1') ? path.slice(3) : path}`;
    return url;
}
async function readBody(req, limit) {
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > limit) throw Object.assign(new Error('Request exceeds maxInputBytes'), { statusCode: 413 });
    const chunks = []; let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error('Request exceeds maxInputBytes'), { statusCode: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
function mergeUsage(target, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return target;
    const result = { ...(target ?? {}) };
    for (const [key, val] of Object.entries(patch)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) result[key] = mergeUsage(result[key], val);
        else if (typeof val === 'number' && Number.isFinite(val) && val >= 0) result[key] = val;
    }
    return result;
}
export class UsageObserver {
    constructor({ sse = false, maxBytes = 1024 * 1024 } = {}) {
        this.sse = sse; this.maxBytes = maxBytes; this.decoder = new TextDecoder(); this.buffer = ''; this.usage = null;
        this.dataLines = []; this.dataBytes = 0; this.discardLine = false; this.discardFrame = false; this.truncated = false;
    }
    inspect(value) {
        const usage = value?.usage ?? value?.message?.usage ?? value?.response?.usage;
        if (usage) this.usage = mergeUsage(this.usage, usage);
    }
    line(line) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
            if (!this.discardFrame && this.dataLines.length) {
                const data = this.dataLines.join('\n');
                if (data !== '[DONE]') { try { this.inspect(JSON.parse(data)); } catch { /* Stream content is evidence, not executable text. */ } }
            }
            this.dataLines = []; this.dataBytes = 0; this.discardFrame = false;
        } else if (line.startsWith('data:') && !this.discardFrame) {
            const data = line.slice(5).replace(/^ /, '');
            this.dataBytes += Buffer.byteLength(data);
            if (this.dataBytes > this.maxBytes) { this.dataLines = []; this.discardFrame = true; this.truncated = true; }
            else this.dataLines.push(data);
        }
    }
    feed(chunk) {
        let text = this.decoder.decode(chunk, { stream: true });
        if (!this.sse) {
            if (!this.truncated && Buffer.byteLength(this.buffer) + Buffer.byteLength(text) <= this.maxBytes) this.buffer += text;
            else { this.buffer = ''; this.truncated = true; }
            return;
        }
        if (this.discardLine) {
            const i = text.indexOf('\n');
            if (i < 0) return;
            text = text.slice(i + 1); this.discardLine = false;
        }
        this.buffer += text;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1);
            if (Buffer.byteLength(line) > this.maxBytes) { this.truncated = true; this.discardFrame = true; }
            else this.line(line);
        }
        if (Buffer.byteLength(this.buffer) > this.maxBytes) {
            this.buffer = ''; this.discardLine = true; this.discardFrame = true; this.truncated = true;
        }
    }
    finish() {
        this.buffer += this.decoder.decode();
        if (this.sse) { if (this.buffer) this.line(this.buffer); this.line(''); }
        else if (!this.truncated) { try { this.inspect(JSON.parse(this.buffer)); } catch { /* No usable usage returned. */ } }
        this.buffer = ''; return this.usage;
    }
}

/** Return an unbound server. API secrets remain in this closure and are never returned by status/records. */
export function createRelay(input, { transformRequest, validateCachePolicy } = {}) {
    const config = prepareConfig(input);
    const records = []; let storedBytes = 0; let inFlight = 0; let policyVersion = randomUUID();
    config.cachePolicy = clone(config.cachePolicy ?? { enabled: false });
    function store(record) {
        const bytes = Buffer.byteLength(JSON.stringify(record));
        if (bytes > config.maxStoredBytes) {
            delete record.body; delete record.beforeBody;
            record.contextOmitted = 'Record exceeds the configured local memory cap; context was not retained.';
        }
        const actual = Buffer.byteLength(JSON.stringify(record));
        records.push({ record, bytes: actual }); storedBytes += actual;
        while (records.length > config.maxRecords || storedBytes > config.maxStoredBytes) storedBytes -= records.shift().bytes;
    }
    const server = http.createServer(async (req, res) => {
        // Reject requests carrying an unexpected Host header, in addition to token authentication.
        let host;
        try { host = new URL(`http://${req.headers.host}`).hostname; } catch { host = ''; }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { sendJson(res, 403, { error: 'loopback_host_required' }); return; }
        if (!authorized(req, config.relayToken)) { sendJson(res, 401, { error: 'relay_auth_required' }); return; }
        let pathname;
        try { const u = new URL(req.url, 'http://127.0.0.1'); if (u.search || u.hash) throw new Error(); pathname = u.pathname; }
        catch { sendJson(res, 400, { error: 'invalid_path' }); return; }
        if (req.method === 'GET' && pathname === '/__cache_lens/status') {
            sendJson(res, 200, { ready: true, interfaceType: config.interfaceType, retainedRecords: records.length, maxInputBytes: config.maxInputBytes, inputProtection: { maxInputTokens: config.maxInputTokens, contextTokens: config.contextTokens, outputReserveTokens: config.outputReserveTokens, method: 'conservative UTF-8 byte bound; not exact tokens' }, visibility: VISIBILITY, transformationEnabled: Boolean(transformRequest) || config.cachePolicy.enabled === true, inFlight, policyVersion, policyPersistence: 'memory-only-restart-restores-config' }); return;
        }
        if (req.method === 'GET' && pathname === '/__cache_lens/records') {
            sendJson(res, 200, { records: records.map(({ record }) => record), visibility: VISIBILITY, includesSensitiveContext: true }); return;
        }
        if (req.method === 'DELETE' && pathname === '/__cache_lens/records') { records.length = 0; storedBytes = 0; sendJson(res, 200, { cleared: true }); return; }
        if (req.method === 'GET' && pathname === '/__cache_lens/policy') {
            sendJson(res, 200, { policy: config.cachePolicy, version: policyVersion, inFlight }); return;
        }
        if (req.method === 'POST' && pathname === '/__cache_lens/policy') {
            try {
                const change = JSON.parse((await readBody(req, config.maxInputBytes)).toString('utf8'));
                if (inFlight) { sendJson(res, 409, { error: 'requests_in_flight' }); return; }
                if (typeof change.expectedVersion !== 'string' || change.expectedVersion !== policyVersion) { sendJson(res, 409, { error: 'policy_version_conflict' }); return; }
                const validate = validateCachePolicy ?? (await import('./transform.mjs')).validateCachePolicy;
                const result = await validate(change.policy);
                if (result === false || result?.ok === false) { sendJson(res, 422, { error: 'invalid_cache_policy' }); return; }
                // Validation may await: re-check both guards immediately before the single commit.
                if (inFlight || change.expectedVersion !== policyVersion) { sendJson(res, 409, { error: 'policy_version_conflict_or_busy' }); return; }
                config.cachePolicy = clone(change.policy); policyVersion = randomUUID();
                sendJson(res, 200, { policy: config.cachePolicy, version: policyVersion, inFlight });
            } catch { sendJson(res, 422, { error: 'invalid_cache_policy' }); }
            return;
        }
        const allowed = config.interfaceType === 'anthropic' ? ['/v1/messages'] : ['/v1/chat/completions', '/v1/responses'];
        if (req.method !== 'POST' || !allowed.includes(pathname)) { sendJson(res, 404, { error: 'unsupported_route' }); return; }
        inFlight += 1;
        const start = Date.now(); const controller = new AbortController(); let upstream; let record;
        const abortOnClose = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', abortOnClose);
        try {
            const raw = await readBody(req, config.maxInputBytes);
            let body;
            try { body = JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON request'), { statusCode: 400 }); }
            if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') throw Object.assign(new Error('Request model and object required'), { statusCode: 400 });
            record = {
                id: randomUUID(), time: new Date(start).toISOString(), timestamp: new Date(start).toISOString(),
                provider: config.interfaceType, transportInterfaceType: config.interfaceType, interfaceType: pathname === '/v1/responses' ? 'openai-responses' : config.interfaceType, model: body.model,
                purpose: config.modelPurpose[body.model] ?? 'unknown', observationLevel: 'server-relay',
                observation: 'server-relay', visibility: VISIBILITY, ...projectBody(body),
                bodyProjection: 'known-model-context-fields; omitted fields explicitly listed',
                requestBytes: raw.length, requestSha256: createHash('sha256').update(raw).digest('hex'),
                upstreamOrigin: new URL(config.upstreamBaseUrl).origin, path: pathname,
                usage: null, status: null, latencyMs: null, completion: 'pending', transmission: 'not-attempted', transformed: false,
            };
            enforceInputGuard(record, body, config, pathname);
            let payload = raw;
            const transformer = transformRequest ?? (config.cachePolicy.enabled === true ? (await import('./transform.mjs')).transformRequest : null);
            if (transformer) {
                const transformRecord = clone(record);
                let transformed;
                try {
                    transformed = await transformer(clone(body), { config: { interfaceType: config.interfaceType, modelPurpose: clone(config.modelPurpose), cachePolicy: clone(config.cachePolicy) }, record: transformRecord });
                } finally {
                    if (transformRecord.transformation) record.transformation = cleanKnownSecrets(transformRecord.transformation);
                }
                const next = transformed?.body && typeof transformed.body === 'object' ? transformed.body : transformed;
                if (!next || typeof next !== 'object' || Array.isArray(next)) throw Object.assign(new Error('Invalid transformer output'), { statusCode: 422 });
                if (JSON.stringify(next) !== JSON.stringify(body)) {
                    record.beforeBody = record.body; record.transformed = true; Object.assign(record, projectBody(next));
                    if (transformed?.metadata) record.transformation = cleanKnownSecrets(transformed.metadata);
                    payload = Buffer.from(JSON.stringify(next)); body = next;
                    record.sentBytes = payload.length; record.sentSha256 = createHash('sha256').update(payload).digest('hex');
                }
            }
            enforceInputGuard(record, body, config, pathname);
            if (payload.length > config.maxInputBytes) throw Object.assign(new Error('Transformed request exceeds maxInputBytes'), { statusCode: 413 });
            const headers = { 'content-type': 'application/json', 'content-length': String(payload.length) };
            if (config.interfaceType === 'anthropic') {
                headers['x-api-key'] = config.apiKey;
                headers['anthropic-version'] = String(req.headers['anthropic-version'] ?? '2023-06-01');
                if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta']);
            } else headers.authorization = `Bearer ${config.apiKey}`;
            record.transmission = 'attempted';
            upstream = await openUpstream(finalUrl(config.upstreamBaseUrl, pathname), { method: 'POST', headers, body: payload, allowLocal: config.allowLocalUpstream === true, timeoutMs: config.timeoutMs, signal: controller.signal });
            record.transmission = 'upstream-responded';
            record.status = upstream.statusCode; record.firstByteMs = Date.now() - start;
            if (upstream.statusCode >= 300 && upstream.statusCode < 400) { upstream.destroy(); throw Object.assign(new Error('Upstream redirect refused'), { statusCode: 502 }); }
            const sse = String(upstream.headers['content-type'] ?? '').includes('text/event-stream') || body.stream === true;
            const encoding = String(upstream.headers['content-encoding'] ?? 'identity').toLowerCase();
            const observableEncoding = encoding === 'identity';
            if (!observableEncoding) record.usageObservationUnavailable = `Response encoding ${encoding} is passed through without local decompression.`;
            const observer = new UsageObserver({ sse, maxBytes: config.maxResponseBufferBytes });
            const inspect = new Transform({ transform(chunk, _encoding, callback) { if (observableEncoding) observer.feed(chunk); callback(null, chunk); } });
            const responseHeaders = { 'Content-Type': upstream.headers['content-type'] ?? 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
            if (upstream.headers['retry-after']) responseHeaders['Retry-After'] = upstream.headers['retry-after'];
            if (upstream.headers['content-encoding']) responseHeaders['Content-Encoding'] = upstream.headers['content-encoding'];
            res.writeHead(upstream.statusCode ?? 502, responseHeaders);
            try { await pipeline(upstream, inspect, res, { signal: controller.signal }); }
            finally {
                record.usage = observer.finish(); record.usageObservationTruncated = observer.truncated;
                if (config.interfaceType === 'openai' && (Number.isFinite(record.usage?.prompt_cache_hit_tokens) || Number.isFinite(record.usage?.prompt_cache_miss_tokens))) { record.usageInterfaceType = 'deepseek'; record.interfaceType = 'deepseek'; }
                else record.usageInterfaceType = record.interfaceType;
            }
            record.completion = 'complete';
        } catch (error) {
            upstream?.destroy();
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
            if (record) { record.completion = controller.signal.aborted ? 'client-disconnected' : 'error'; record.errorCode = controller.signal.aborted ? 'client_disconnected' : error.safeCode ?? (status === 413 ? 'input_limit' : 'upstream_or_transform_error'); }
            // Never echo upstream bodies, URLs, secrets, or arbitrary transformer exception messages.
            sendJson(res, status, { error: error.safeCode ?? (status === 400 ? 'invalid_request' : status === 413 ? 'input_limit' : status === 422 ? 'transform_rejected' : 'upstream_request_failed') });
        } finally {
            inFlight -= 1;
            res.off('close', abortOnClose);
            if (record) { record.latencyMs = Date.now() - start; record.finishedAt = new Date().toISOString(); store(record); }
        }
    });
    server.requestTimeout = config.timeoutMs;
    server.headersTimeout = Math.min(config.timeoutMs, 60000);
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        if (!process.argv[2]) throw new Error('Config path is required');
        const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
        const server = createRelay(config);
        server.on('error', () => { console.error('Cache Lens relay could not start. Check its port and configuration.'); process.exitCode = 1; });
        server.listen(config.port ?? 8937, config.host ?? '127.0.0.1', () => console.log(`Cache Lens relay listening on loopback port ${server.address().port}; request bodies retained only in bounded memory.`));
    } catch { console.error('Cache Lens relay configuration failed. Check private config, upstream key environment variable and local token (24+ bytes).'); process.exitCode = 1; }
}
