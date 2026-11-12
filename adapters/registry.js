/** Explicit, read-only extension adapters. Never evaluate user/chat text as code. */
const PURPOSES = new Set(['main', 'summary', 'agent', 'unknown']);
export class AdapterRegistry {
    #adapters = new Map();
    register(adapter) {
        if (!adapter || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(adapter.id || '') || typeof adapter.readSources !== 'function') {
            throw new Error('Adapter requires a stable id and readSources(context) function');
        }
        if (this.#adapters.has(adapter.id)) throw new Error('Duplicate adapter id');
        if (adapter.write || adapter.apply || adapter.execute || adapter.tools) throw new Error('Registry supports read-only adapters; writing requires a separately verified integration');
        this.#adapters.set(adapter.id, Object.freeze({ id: adapter.id, version: String(adapter.version || 'unspecified'), readSources: adapter.readSources, classifyRequest: adapter.classifyRequest }));
        return () => this.#adapters.delete(adapter.id);
    }
    list() { return Array.from(this.#adapters.values(), a => ({ id: a.id, version: a.version, mode: 'read-only' })); }
    readSources(context) {
        const sources = [];
        for (const adapter of this.#adapters.values()) {
            try {
                const result = adapter.readSources(context);
                if (!Array.isArray(result)) continue; // synchronous reads only: never race an in-flight prompt
                for (const source of result.slice(0, 10000)) {
                    if (!source || typeof (source.text ?? source.content) !== 'string' || !source.id) continue;
                    sources.push({ ...source, id: `${adapter.id}:${source.id}`, adapter: adapter.id, adapterVersion: adapter.version, access: 'read-only', text: source.text ?? source.content });
                }
            } catch { /* A failing third-party diagnostic cannot stop the user's generation. */ }
        }
        return sources;
    }
    classifyRequest(body, context) {
        const votes = [];
        for (const adapter of this.#adapters.values()) {
            try {
                const purpose = adapter.classifyRequest?.(body, context);
                if (PURPOSES.has(purpose) && purpose !== 'unknown') votes.push({ purpose, adapter: adapter.id });
            } catch { /* unknown */ }
        }
        if (new Set(votes.map(v => v.purpose)).size !== 1) return null;
        return votes[0] || null;
    }
}
export const adapterRegistry = new AdapterRegistry();
