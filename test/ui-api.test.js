import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCacheLens } from '../index.js';
import { hasObservedContext, normalizeUISources, worldSummary } from '../adapters/ui-data.js';
import { eligibleSources } from '../adapters/pipeline.js';
import { sanitizeRequest } from '../adapters/st.js';

test('UI module imports without DOM side effects; usage-only and null-body evidence cannot optimize', () => {
    assert.equal(typeof mountCacheLens, 'function');
    assert.equal(hasObservedContext(null), false);
    assert.equal(hasObservedContext({ body: null, usage: { input_tokens: 99 } }), false);
    assert.equal(hasObservedContext({ body: {} }), false);
    assert.equal(hasObservedContext({ body: { messages: [] } }), true);
    assert.equal(hasObservedContext({ body: { input: 'Responses text' } }), true);
});

test('UI source bridge keeps exact whitespace and maps only known same-message world/preset candidates', () => {
    const sources = normalizeUISources([
        { id: 'world:a:1', kind: 'world-info', name: 'world', content: '资料含有\u200b不可见字符', entry: { world: 'a', uid: 1 } },
        { id: 'extension:unknown', kind: 'extension', content: '未明确支持的插件' },
    ]);
    assert.equal(sources[0].text, '资料含有\u200b不可见字符');
    assert.equal(sources[0].type, 'world-info');
    const body = { messages: [{ role: 'user', content: sources[0].text + '\n' + sources[1].text }] };
    const candidates = eligibleSources(body, sources);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].role, 'user');
    assert.equal(candidates[0].scope, 'messages.0.content');
    assert.equal(candidates[0].approvedIndependent, false);
});

test('world UI separates budget of 1.5 million from actual sent usage and unknown activated quantity', () => {
    const result = worldSummary({ body: null, interfaceType: 'anthropic', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20, output_tokens: 4 }, world: { budgetTokens: 1500000, activeEntries: [], loadedEntries: [] } });
    assert.equal(result.budget.value, 1500000);
    assert.equal(result.finalSent.value, 1030);
    assert.equal(result.wholeBook.value, null);
    assert.equal(result.activated.value, null);
    assert.equal(result.worldInfoFinalSentTokens, null);
    assert.match(result.finalSentScope, /整个请求/);
});

test('selected book inspection does not mix other book activations or treat total book size as sent', () => {
    const record = { body: { messages: [] }, world: { budgetTokens: 25000, activationEventSeen: true, activeEntries: [{ world: 'a', uid: 1, content: 'alpha' }, { world: 'b', uid: 1, content: 'beta' }] } };
    const book = { name: 'a', entries: [{ world: 'a', uid: 1, content: 'alpha' }, { world: 'a', uid: 2, content: 'not activated' }], budgetTokens: 999 };
    const result = worldSummary(record, { book });
    assert.equal(result.entryCount, 2);
    assert.equal(result.activeEntryCount, 1);
    assert.equal(result.budget.value, 25000);
    assert.equal(result.finalSent.value, null);
    assert.equal(result.wholeBookScope.name, 'a');
});

test('explicit empty loaded event is zero loaded, absence of an event remains unknown', () => {
    assert.equal(worldSummary({ world: { loadedEntries: [], loadedEntriesKnown: true } }).wholeBook.value, 0);
    assert.equal(worldSummary({ world: { loadedEntries: [] } }).wholeBook.value, null);
});

test('sanitizer preserves Responses context/cache evidence but omits transport secrets', () => {
    const body = { model: 'model', input: [{ role: 'user', content: [{ type: 'input_text', text: 'immutable' }] }], instructions: 'fixed rules', prompt_cache_options: { retention: '12h' }, context_management: [{ type: 'compaction', compact_threshold: 10000 }], api_key: 'do-not-save', reverse_proxy: 'https://private.invalid' };
    const result = sanitizeRequest(body);
    assert.deepEqual(result.input, body.input);
    assert.deepEqual(result.context_management, body.context_management);
    assert.deepEqual(result.prompt_cache_options, body.prompt_cache_options);
    assert.equal(result.instructions, body.instructions);
    assert.equal(result.api_key, undefined);
    assert.equal(result.reverse_proxy, undefined);
});
