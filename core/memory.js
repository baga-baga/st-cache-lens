/** Append-only memory owned by Cache Lens. Third-party memory stays read-only. */
import { stableStringify } from './optimizer.js';
const clone = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
function validDate(value) {
    if (typeof value !== 'string') return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const date = new Date(value + 'T00:00:00.000Z');
        return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === value;
    }
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && validDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));
}
function checkedEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Memory entry must be JSON data');
    const allowed = ['id', 'occurredAt', 'text', 'originalTimeText', 'source', 'protectedFacts'];
    if (Object.keys(entry).some(k => !allowed.includes(k))) throw new Error('Unknown memory entry field');
    if (!validId(entry.id) || typeof entry.text !== 'string' || !entry.text.trim()) throw new Error('Memory entry requires ID and original text');
    if (!validDate(entry.occurredAt)) throw new Error('Supply an explicit, valid ISO story date; relative dates are not guessed');
    if (entry.originalTimeText !== undefined && typeof entry.originalTimeText !== 'string') throw new Error('Original time text must be a string');
    if (entry.protectedFacts !== undefined && (!Array.isArray(entry.protectedFacts) || entry.protectedFacts.some(f => typeof f !== 'string' || !f || !entry.text.includes(f)))) throw new Error('Protected facts must be exact substrings of original event text');
    if (entry.source !== undefined && typeof entry.source !== 'string') throw new Error('Source must be a string');
    return clone(entry);
}
export function createMemoryLedger({ compactAfterEvents = 50 } = {}) {
    if (!Number.isInteger(compactAfterEvents) || compactAfterEvents < 2) throw new Error('Invalid compaction threshold');
    return { schemaVersion: 1, adapter: 'cache-lens', version: 0, compactAfterEvents, baseSummary: '', entries: [], archives: [] };
}
export function appendMemory(ledger, entry, { expectedVersion = ledger.version } = {}) {
    if (ledger.adapter !== 'cache-lens') throw new Error('Unknown memory adapter is read-only');
    if (expectedVersion !== ledger.version) throw new Error('Memory version conflict');
    const next = checkedEntry(entry);
    const existing = [...ledger.entries, ...ledger.archives.flatMap(a => a.entries)];
    const prior = existing.find(e => e.id === next.id);
    if (prior) {
        if (stableStringify(prior) === stableStringify(next)) return clone(ledger); // replay is idempotent
        throw new Error('Existing memory is immutable; add a dated correction event');
    }
    return { ...clone(ledger), version: ledger.version + 1, entries: [...clone(ledger.entries), next] };
}
/** No heading contains a mutable count or a relative date: old rendered prefix remains exact. */
export function renderMemory(ledger) {
    const base = ledger.baseSummary ? ledger.baseSummary + '\n\n' : '';
    return base + ledger.entries.map(e => '[' + e.occurredAt + '] ' + e.text + (e.originalTimeText ? '\n原始时间表述：' + e.originalTimeText : '') + '\n\n').join('');
}
export function memoryStatus(ledger) {
    return {
        adapter: ledger.adapter,
        immutableEvents: ledger.entries.length,
        archivedEvents: ledger.archives.reduce((n, a) => n + a.entries.length, 0),
        compactionDue: ledger.entries.length >= ledger.compactAfterEvents,
        automaticSemanticCompaction: false,
        text: renderMemory(ledger),
    };
}
/**
 * Optional high-impact operation, deliberately separate from structural Agent proposals.
 * Exact preservation checks are necessary but do not establish semantic equivalence.
 * The UI must obtain an explicit reviewedSummary opt-in for each submitted compacted text.
 */
export function compactMemory(ledger, { expectedVersion, count, summary, semanticOptIn = false, reviewedSummary = false, preserveDates = true } = {}) {
    if (ledger.adapter !== 'cache-lens') throw new Error('Unknown memory adapter is read-only');
    if (!semanticOptIn || !reviewedSummary) throw new Error('Semantic compaction requires independent opt-in and reviewed summary');
    if (expectedVersion !== ledger.version) throw new Error('Memory version conflict');
    if (!Number.isInteger(count) || count < 2 || count > ledger.entries.length) throw new Error('Invalid compaction event count');
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('Reviewed summary is required');
    if (preserveDates !== true) throw new Error('Exact story dates must be retained');
    const selected = ledger.entries.slice(0, count);
    const facts = selected.flatMap(e => e.protectedFacts || []);
    if (facts.some(f => !summary.includes(f))) throw new Error('Protected fact removed from compacted summary');
    if (selected.some(e => !summary.includes(e.occurredAt))) throw new Error('Exact story date removed from compacted summary');
    const archive = { previousVersion: ledger.version, previousBaseSummary: ledger.baseSummary, entries: clone(selected), reviewedSummary: summary };
    return {
        ...clone(ledger), version: ledger.version + 1,
        baseSummary: (ledger.baseSummary ? ledger.baseSummary + '\n\n' : '') + summary,
        entries: clone(ledger.entries.slice(count)), archives: [...clone(ledger.archives), archive],
    };
}
export function restoreLastCompaction(ledger, { expectedVersion } = {}) {
    if (expectedVersion !== ledger.version) throw new Error('Memory version conflict');
    if (!ledger.archives.length) throw new Error('No compaction to restore');
    const last = ledger.archives.at(-1);
    return {
        ...clone(ledger), version: ledger.version + 1, baseSummary: last.previousBaseSummary,
        entries: [...clone(last.entries), ...clone(ledger.entries)], archives: clone(ledger.archives.slice(0, -1)),
    };
}

/** Adapters are registered by trusted application code, never by model output. */
export class ReadOnlyAdapterRegistry {
    #adapters = new Map();
    register({ id, read, documentation }) {
        if (!validId(id) || typeof read !== 'function' || typeof documentation !== 'string' || !documentation) throw new Error('A documented public read adapter is required');
        if (this.#adapters.has(id)) throw new Error('Adapter already registered');
        this.#adapters.set(id, { read, documentation });
        return () => this.#adapters.delete(id);
    }
    list() { return [...this.#adapters].map(([id, a]) => ({ id, documentation: a.documentation, access: 'read-only' })); }
    async read(id) {
        const adapter = this.#adapters.get(id);
        if (!adapter) throw new Error('Unknown adapter');
        const value = await adapter.read();
        // Explicit projection: plugin callbacks cannot add mutating tools to the Agent.
        return { adapter: id, access: 'read-only', documentation: adapter.documentation, data: clone(value) };
    }
}
