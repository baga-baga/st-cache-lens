import { adapterRegistry } from './registry.js';

export const VERIFIED_ST = Object.freeze({ version: '1.19.0', commit: '06bde939fb1e9c4c8d8641d810f0a916b5bce127' });
const ENDPOINT = '/api/backends/chat-completions/generate';
const SAFE_KEYS = new Set(['model', 'messages', 'system', 'prompt', 'input', 'instructions', 'prompt_cache_options', 'context_management', 'tools', 'tool_choice', 'functions', 'function_call', 'thinking', 'output_config', 'response_format', 'json_schema', 'cache_control', 'prompt_cache_key', 'prompt_cache_retention', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'frequency_penalty', 'stop', 'seed', 'reasoning_effort', 'chat_completion_source', 'use_sysprompt', 'claude_use_sysprompt', 'claude_prefill', 'claude_assistant_prefill', 'claude_assistant_postfill', 'custom_prompt_post_processing', 'group_names', 'user_name', 'char_name', 'post_processing', 'enable_web_search']);
const WI_KEYS = ['uid', 'world', 'comment', 'content', 'constant', 'vectorized', 'key', 'keysecondary', 'selective', 'selectiveLogic', 'disable', 'order', 'position', 'depth', 'role', 'ignoreBudget', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'probability', 'useProbability', 'group', 'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'sticky', 'cooldown', 'delay', 'triggers', 'automationId', 'outletName'];
const clone = value => value === undefined ? undefined : structuredClone(value);
const safeCall = (fn, ...args) => { try { return fn?.(...args); } catch { return undefined; } };
function pick(object, keys) { return Object.fromEntries(Object.entries(object || {}).filter(([key]) => keys.has ? keys.has(key) : keys.includes(key)).map(([key, value]) => [key, clone(value)])); }
export function sanitizeRequest(body) { return pick(body, SAFE_KEYS); }
export function detectInterface(body) {
    const source = body?.chat_completion_source;
    if (source === 'claude') return 'anthropic';
    if (source === 'deepseek') return 'deepseek';
    if (['openai', 'custom', 'openrouter', 'azure', 'mistralai', 'groq', 'nanogpt', 'electronhub', 'chutes', 'ai21', 'aimlapi', 'perplexity', 'xai', 'pollinations', 'fireworks', 'moonshotai', 'cohere'].includes(source)) return 'openai';
    return 'unknown';
}
function sourceType(id) {
    if (id === '1_memory') return { kind: 'history-summary', identityConfidence: 'verified-builtin' };
    return { kind: 'extension', identityConfidence: 'extension-key-only' };
}
export function collectContextSources(context, activated = [], registry = adapterRegistry) {
    const result = [];
    const add = (id, kind, text, metadata = {}) => {
        if (typeof text === 'string' && text.length) result.push({ id, kind, text, content: text, access: 'read-only', ...metadata });
    };
    for (const p of context?.chatCompletionSettings?.prompts || []) {
        add(`preset:${p.identifier}`, 'preset', p.content, { name: p.name, role: p.role, marker: p.marker, depth: p.injection_depth, position: p.injection_position, order: p.injection_order, requiresMacroExpansion: /\{\{/.test(p.content || '') });
    }
    for (const [id, p] of Object.entries(context?.extensionPrompts || {})) {
        add(`extension:${id}`, sourceType(id).kind, p?.value, { ...sourceType(id), name: id, role: p.role, depth: p.depth, position: p.position, scan: p.scan, provenance: 'getContext.extensionPrompts' });
    }
    for (const [index, m] of (context?.chat || []).entries()) {
        add(`history:${index}`, 'history', m.mes, { role: m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'), messageIndex: index, name: m.name, provenance: 'getContext.chat' });
    }
    for (const entry of activated) {
        add(`world:${entry.world ?? '?'}:${entry.uid ?? '?'}`, 'world-info', entry.content, { name: entry.comment, entry: pick(entry, WI_KEYS), provenance: 'WORLD_INFO_ACTIVATED', requiresMacroExpansion: /\{\{/.test(entry.content || '') });
    }
    result.push(...registry.readSources(context));
    return result;
}
function mergeUsage(a, b) {
    if (!b || typeof b !== 'object') return a;
    const next = { ...(a || {}) };
    for (const [key, value] of Object.entries(b)) {
        if (typeof value === 'number' && Number.isFinite(value)) next[key] = value;
        else if (value && typeof value === 'object' && !Array.isArray(value)) next[key] = mergeUsage(next[key], value);
    }
    return next;
}
export async function observeResponse(response, { maxBytes = 4 * 1024 * 1024, onUsage = () => {} } = {}) {
    let usage = null;
    const accept = value => {
        const patch = value?.usage ?? value?.message?.usage ?? value?.response?.usage;
        if (patch) { usage = mergeUsage(usage, patch); safeCall(onUsage, clone(usage)); }
    };
    const stream = /text\/event-stream/i.test(response.headers?.get('content-type') || '');
    if (!response.body?.getReader) return { usage, observation: 'body-unavailable' };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', bytes = 0;
    const parseEvent = event => {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') return;
        try { accept(JSON.parse(data)); } catch { /* incomplete or non-JSON event */ }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) { void reader.cancel(); return { usage, observation: 'response-observation-truncated' }; }
            buffer += decoder.decode(value, { stream: true });
            if (stream) {
                let match;
                while ((match = /\r?\n\r?\n/.exec(buffer))) {
                    parseEvent(buffer.slice(0, match.index));
                    buffer = buffer.slice(match.index + match[0].length);
                }
            }
        }
        buffer += decoder.decode();
        if (stream) parseEvent(buffer); else if (buffer) { try { accept(JSON.parse(buffer)); } catch { return { usage, observation: 'non-json-response' }; } }
        return { usage, observation: usage ? 'usage-observed' : 'usage-not-returned' };
    } finally { reader.releaseLock(); }
}
function isTarget(input, init, base) {
    try {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, base);
        const origin = new URL(base).origin;
        return url.origin === origin && url.pathname === ENDPOINT && (init?.method || input?.method || 'GET').toUpperCase() === 'POST';
    } catch { return false; }
}
function contentIdentity(message) {
    const value = clone(message);
    if (Array.isArray(value.content)) for (const b of value.content) if (b && typeof b === 'object') delete b.cache_control;
    return JSON.stringify(value);
}
/** Defense in depth. Only whole adjacent same-role messages or whole system blocks may move. */
export function assertSafeTransform(before, after, { validatedStructuralContent = false } = {}) {
    if (!after || typeof after !== 'object') throw new Error('Transform must return a request object');
    const mutable = new Set(['messages', 'system', 'cache_control', 'prompt_cache_key', 'prompt_cache_retention']);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!mutable.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error(`Transform changed protected field: ${key}`);
    }
    if (Array.isArray(before.messages)) {
        if (!Array.isArray(after.messages) || before.messages.length !== after.messages.length) throw new Error('Transform inserted or removed messages');
        for (let start = 0; start < before.messages.length;) {
            const role = before.messages[start].role;
            let end = start + 1;
            while (end < before.messages.length && before.messages[end].role === role) end++;
            if (after.messages.slice(start, end).some(m => m.role !== role)) throw new Error('Transform changed role or role scope');
            const original = before.messages.slice(start, end).map(contentIdentity).sort();
            const altered = after.messages.slice(start, end).map(contentIdentity).sort();
            if (!validatedStructuralContent && JSON.stringify(original) !== JSON.stringify(altered)) throw new Error('Transform changed message content or metadata');
            if (validatedStructuralContent) {
                for (let i = start; i < end; i++) {
                    const a = clone(before.messages[i]), b = clone(after.messages[i]);
                    delete a.content; delete b.content;
                    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Transform changed message metadata or scope');
                }
            }
            start = end;
        }
    } else if (JSON.stringify(before.messages) !== JSON.stringify(after.messages)) throw new Error('Transform replaced messages');
    const systemIdentity = value => Array.isArray(value) ? value.map(b => { const c = clone(b); delete c.cache_control; return JSON.stringify(c); }).sort() : value;
    if (!validatedStructuralContent && JSON.stringify(systemIdentity(before.system)) !== JSON.stringify(systemIdentity(after.system))) throw new Error('Transform changed protected system content');
    if (validatedStructuralContent && (typeof before.system !== typeof after.system || Array.isArray(before.system) !== Array.isArray(after.system))) throw new Error('Transform changed system representation');
}

export function installSTAdapter({ getContext = () => globalThis.SillyTavern?.getContext?.(), fetchHost = globalThis, onRecord, onSources, onInFlight, onError, resolvePurpose, transform, validateTransform, readWorldSettings, registry = adapterRegistry, maxRequestBytes = 16 * 1024 * 1024, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
    if (typeof fetchHost.fetch !== 'function') throw new Error('fetch is unavailable');
    const initial = getContext();
    if (!initial?.eventSource || !initial?.eventTypes) throw new Error('SillyTavern extension context is unavailable');
    const originalFetch = fetchHost.fetch;
    const eventSource = initial.eventSource;
    const eventTypes = initial.eventTypes;
    const listeners = [];
    let enabled = true, inFlight = 0, generation = null, activeEntries = [], loadedEntries = [], loadedEntriesKnown = false, activationEventSeen = false, scan = null, promptStage = null, settingsStage = null, nextPurpose = null, serial = 0;
    const makeId = () => `cl-${Date.now()}-${++serial}`;
    const baseURL = fetchHost.location?.href || 'http://localhost/';
    const notifyError = code => safeCall(onError, code);
    const listen = (name, handler) => {
        if (!eventTypes[name]) return;
        eventSource.on(eventTypes[name], handler);
        listeners.push([eventTypes[name], handler]);
    };
    const getSources = () => collectContextSources(getContext(), activeEntries, registry);
    const getSnapshot = () => ({ activeEntries: clone(activeEntries), activationEventSeen, loadedEntries: clone(loadedEntries), loadedEntriesKnown, budgetTokens: scan?.budget ?? null, activationEvidence: activeEntries.length ? 'activation-event-content-match-required' : 'no-confirmed-active-entries', scan: clone(scan), generation: clone(generation), sourceAdapters: registry.list(), inFlight });
    listen('GENERATION_STARTED', (type, options, dryRun) => {
        if (dryRun) return;
        generation = { type, startedAt: Date.now(), dryRun: false };
        activeEntries = []; loadedEntries = []; loadedEntriesKnown = false; activationEventSeen = false; scan = null; promptStage = null; settingsStage = null;
    });
    const clearGeneration = () => { generation = null; activeEntries = []; loadedEntries = []; loadedEntriesKnown = false; activationEventSeen = false; scan = null; promptStage = null; settingsStage = null; safeCall(onSources, getSources(), getSnapshot()); };
    listen('GENERATION_ENDED', clearGeneration);
    listen('GENERATION_STOPPED', clearGeneration);
    listen('CHAT_CHANGED', clearGeneration);
    listen('WORLDINFO_ENTRIES_LOADED', data => { loadedEntriesKnown = true; loadedEntries = Object.values(data || {}).filter(Array.isArray).flat().map(e => pick(e, WI_KEYS)); });
    listen('WORLDINFO_SCAN_DONE', data => {
        scan = { budget: Number.isFinite(data?.budget?.current) ? data.budget.current : null, overflowed: Boolean(data?.budget?.overflowed), scanAt: Date.now(), loopCount: data?.state?.loopCount, correlation: 'scan-event-may-include-dry-run' };
    });
    listen('WORLD_INFO_ACTIVATED', entries => {
        activationEventSeen = true;
        activeEntries = Array.isArray(entries) ? entries.map(e => pick(e, WI_KEYS)) : [];
        safeCall(onSources, getSources(), getSnapshot());
    });
    listen('CHAT_COMPLETION_PROMPT_READY', data => {
        if (data?.dryRun) return;
        promptStage = { observedAt: Date.now(), messages: clone(data?.chat || []), stage: 'prompt-ready-event', timing: 'other-event-listeners-may-modify-later' };
        safeCall(onSources, getSources(), getSnapshot());
    });
    listen('CHAT_COMPLETION_SETTINGS_READY', data => { settingsStage = { observedAt: Date.now(), body: sanitizeRequest(data), stage: 'settings-ready-event', timing: 'other-event-listeners-may-modify-later' }; });
    function purposeFor(body, context) {
        if (nextPurpose) { const p = nextPurpose; nextPurpose = null; return { purpose: p, purposeEvidence: 'explicit-next-request-annotation' }; }
        const configured = safeCall(resolvePurpose, body, { context, generation: clone(generation) });
        if (['main', 'summary', 'agent'].includes(configured)) return { purpose: configured, purposeEvidence: 'user-configured-request-rule' };
        const classified = registry.classifyRequest(body, context);
        if (classified) return { purpose: classified.purpose, purposeEvidence: `verified-adapter:${classified.adapter}` };
        // Quiet/raw auxiliary requests can overlap main generation. Its event is context, not per-request provenance.
        return { purpose: 'unknown', purposeEvidence: 'no-purpose-adapter-or-explicit-rule' };
    }
    async function observeUnparsed(input, init, owner, reason) {
        const record = { id: makeId(), model: 'unknown', provider: 'unknown', interfaceType: 'unknown', purpose: 'unknown', observationLevel: 'frontend', observationNotice: '仅观察到前端请求；请求体超出采集限额或不可读取', body: null, sources: [], usage: null, status: 'pending', timestamp: Date.now(), startedAt: new Date().toISOString(), observation: reason, optimizationSkipped: true };
        inFlight++; safeCall(onInFlight, inFlight); safeCall(onRecord, clone(record));
        let finished = false;
        const finish = patch => {
            if (finished) return;
            finished = true;
            inFlight--; safeCall(onInFlight, inFlight);
            safeCall(onRecord, { ...record, ...patch, finishedAt: new Date().toISOString(), latencyMs: Date.now() - record.timestamp });
        };
        try {
            const response = await originalFetch.call(owner, input, init);
            try { void observeResponse(response.clone(), { maxBytes: maxResponseBytes }).then(result => finish({ ...result, status: response.ok ? 'complete' : 'http-error', httpStatus: response.status })).catch(() => finish({ status: 'observation-error' })); }
            catch { finish({ status: 'observation-error' }); }
            return response;
        } catch (error) { finish({ status: 'request-error', errorCode: error?.name || 'Error' }); throw error; }
    }
    const wrappedFetch = async function(input, init) {
        if (!enabled || !isTarget(input, init, baseURL)) return originalFetch.call(this, input, init);
        let text, raw;
        try {
            text = typeof init?.body === 'string' ? init.body : (typeof input?.clone === 'function' ? await input.clone().text() : null);
            if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > maxRequestBytes) {
                notifyError('request-not-observed-body-unavailable-or-over-limit');
                return observeUnparsed(input, init, this, 'body-unavailable-or-over-limit');
            }
            raw = JSON.parse(text);
        } catch { notifyError('request-not-observed-invalid-json'); return observeUnparsed(input, init, this, 'invalid-json-body'); }
        const context = getContext();
        const sources = getSources();
        const purpose = purposeFor(raw, context);
        const interfaceType = detectInterface(raw);
        let outgoing = raw;
        if (transform) {
            outgoing = await transform(clone(raw), { sources: clone(sources), ...purpose, interfaceType, chatId: String(safeCall(context.getCurrentChatId) ?? context.chatId ?? ''), model: raw.model || 'unknown', provider: raw.chat_completion_source || 'unknown', snapshot: getSnapshot() }) || raw;
            const validatedStructuralContent = validateTransform ? (await validateTransform(clone(raw), clone(outgoing), { sources: clone(sources), ...purpose, interfaceType })) === true : false;
            assertSafeTransform(raw, outgoing, { validatedStructuralContent });
        }
        const transformed = JSON.stringify(outgoing) !== JSON.stringify(raw);
        const record = { id: makeId(), model: raw.model || 'unknown', chatId: String(safeCall(context.getCurrentChatId) ?? context.chatId ?? ''), provider: raw.chat_completion_source || 'unknown', interfaceType, ...purpose, observationLevel: 'frontend', observationNotice: '仅观察到前端请求；酒馆服务端转换与中转内部路由不可见', startedAt: new Date().toISOString(), timestamp: Date.now(), body: sanitizeRequest(outgoing), sources, world: getSnapshot(), frontendStages: { prompt: clone(promptStage), settings: clone(settingsStage) }, transformed, usage: null, status: 'pending' };
        // Consume event stages once. A raw auxiliary request must not inherit a previous main stage.
        promptStage = null; settingsStage = null;
        inFlight++; safeCall(onInFlight, inFlight); safeCall(onRecord, clone(record));
        let finished = false;
        const finish = patch => {
            if (finished) return;
            finished = true;
            Object.assign(record, patch, { finishedAt: new Date().toISOString(), latencyMs: Date.now() - record.timestamp });
            inFlight--; safeCall(onInFlight, inFlight); safeCall(onRecord, clone(record));
        };
        try {
            let requestInput = input, requestInit = init;
            if (transformed) {
                if (typeof input?.clone === 'function') requestInput = new Request(input, { ...init, body: JSON.stringify(outgoing) });
                else requestInit = { ...init, body: JSON.stringify(outgoing) };
            }
            const response = await originalFetch.call(this, requestInput, requestInit);
            record.httpStatus = response.status;
            record.timeToHeadersMs = Date.now() - record.timestamp;
            try {
                void observeResponse(response.clone(), { maxBytes: maxResponseBytes }).then(result => finish({ ...result, status: response.ok ? 'complete' : 'http-error', usageEvidence: result.usage ? 'returned-through-st-backend' : 'unavailable' })).catch(() => finish({ status: 'observation-error', usageEvidence: 'unavailable' }));
            } catch { finish({ status: 'observation-error', usageEvidence: 'unavailable' }); }
            return response;
        } catch (error) { finish({ status: 'request-error', errorCode: error?.name || 'Error' }); throw error; }
    };
    fetchHost.fetch = wrappedFetch;
    return {
        getSources,
        getSnapshot,
        annotateNextRequest(purpose) {
            if (!['main', 'summary', 'agent'].includes(purpose)) throw new Error('Unknown request purpose');
            nextPurpose = purpose;
        },
        async inspectWorldBook(name) {
            const context = getContext();
            const names = context.getWorldInfoNames?.() || [];
            if (!names.includes(name)) throw new Error('World book must be selected from the current named book list');
            const data = await context.loadWorldInfo(name);
            let globalSettings = null;
            try {
                if (typeof readWorldSettings === 'function') globalSettings = clone(await readWorldSettings());
                else if (typeof document !== 'undefined') {
                    const worldModule = await import('/scripts/world-info.js');
                    if (typeof worldModule.getWorldInfoSettings === 'function') globalSettings = clone(worldModule.getWorldInfoSettings());
                }
            } catch { /* Older or forked versions remain read-only, with global defaults explicitly unknown. */ }
            return { name, access: 'read-only', globalSettings, data: clone(data), entries: Object.values(data?.entries || {}).map(e => ({ ...pick(e, WI_KEYS), world: name })), observation: 'whole-book-not-necessarily-sent', budgetTokens: scan?.budget ?? null };
        },
        dispose() {
            enabled = false;
            for (const [event, fn] of listeners) (eventSource.removeListener || eventSource.off)?.call(eventSource, event, fn);
            // Preserve wrappers installed after ours; our disabled wrapper remains a transparent pass-through.
            if (fetchHost.fetch === wrappedFetch) fetchHost.fetch = originalFetch;
        },
    };
}
