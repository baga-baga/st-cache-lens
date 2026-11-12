import { stableStringify } from '../core/optimizer.js';

/**
 * Browser-origin private durable state. Writes use Web Locks plus an exact-snapshot
 * compare-and-swap; no extension or request secrets belong in this store.
 * If locking is unavailable, read-only diagnostics remain possible and writes fail closed.
 */
export function createBrowserStateStore({ key, storage = globalThis.localStorage, locks = globalThis.navigator?.locks, maxBytes = 3_000_000 } = {}) {
    if (typeof key !== 'string' || !key.startsWith('cache-lens:') || key.length > 300) throw new Error('A scoped Cache Lens storage key is required');
    if (!storage?.getItem || !storage?.setItem) throw new Error('Durable browser storage is unavailable');
    const lockName = 'write:' + key;
    const encode = value => {
        const serialized = stableStringify(value);
        if (new TextEncoder().encode(serialized).length > maxBytes) throw new Error('优化副本与历史超过 3MB 保存限制；缩小候选范围或导出旧历史。');
        return serialized;
    };
    function read() {
        const value = storage.getItem(key);
        return value === null ? null : JSON.parse(value);
    }
    async function exclusive(operation) {
        if (typeof locks?.request !== 'function') throw new Error('浏览器缺少 Web Locks；为避免多窗口覆盖，当前只允许诊断。请使用 localhost 或 HTTPS 打开酒馆。');
        return locks.request(lockName, { mode: 'exclusive' }, operation);
    }
    return {
        key, durable: true,
        read,
        async initialize(initial) {
            return exclusive(() => {
                const existing = read();
                if (existing !== null) return existing;
                const serialized = encode(initial);
                storage.setItem(key, serialized); // atomic per Web Storage; quota errors leave old value intact
                return JSON.parse(serialized);
            });
        },
        async compareAndSwap(expectedSnapshot, next, { guard = () => {} } = {}) {
            const serialized = encode(next);
            return exclusive(() => {
                if (stableStringify(read()) !== expectedSnapshot) return false;
                guard(); // request may have started while waiting for another tab's lock
                storage.setItem(key, serialized);
                return true;
            });
        },
        matches(expectedSnapshot) { return stableStringify(read()) === expectedSnapshot; },
    };
}
