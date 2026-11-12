import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfile, createOptimizationState, previewProposal, validateProposal, applyProposal, rollback, commitProposal, stableStringify, hasBalancedTags, estimateProfileInput } from '../core/optimizer.js';

const profile = () => createProfile({ mode: 'preview', blocks: [
    { id: 'a', content: '<fact>Alice exists {{char}}</fact>', role: 'system', scope: 's', approvedIndependent: true, stable: true, cacheable: true, exactTokens: 600, source: { kind: 'preset' } },
    { id: 'b', content: '<rules>Keep secrets until revealed.</rules>', role: 'system', scope: 's', approvedIndependent: true, stable: true, cacheable: true, exactTokens: 600, source: { kind: 'worldbook' } },
], limits: { maxInputTokens: 10000, contextTokens: 20000, outputReserveTokens: 2048 } });
const plan = (p = profile()) => ({ schemaVersion: 1, expectedVersion: p.version, reason: 'Stable independent facts before independent dynamic rules', sources: ['preset:a'], operations: [{ type: 'reorder_blocks', scope: 's', role: 'system', ids: ['b', 'a'] }] });
const context = { byteLevelTokenizer: true, otherInputUpperBound: 100 };

test('reorder approved sibling blocks preserves every character, fact, role, and macro', () => {
    const p = profile(), result = previewProposal(p, plan(p), context);
    assert.equal(result.ok, true, result.errors?.join());
    assert.deepEqual(result.after.blocks, [p.blocks[1], p.blocks[0]]);
    assert.equal(result.impact.predictionOnly, true);
    assert.equal(result.impact.realCacheSavings, null);
    assert.equal(p.blocks[0].id, 'a');
});

test('Agent cannot edit protected facts, tags, macros, roles or arbitrary files', () => {
    for (const operation of [
        { type: 'write_file', path: '/etc/passwd', value: 'x' },
        { type: 'replace_content', id: 'a', content: 'Alice never existed' },
        { type: 'reorder_blocks', scope: 's', role: 'system', ids: ['b', 'a'], content: '</fact>' },
        { type: 'set_budget', maxInputTokens: 999999999 },
        { type: 'set_world_constant', all: true },
    ]) {
        const result = validateProposal(profile(), { ...plan(), operations: [operation] }, context);
        assert.equal(result.ok, false);
    }
});

test('cross-role, cross-scope, unapproved, history and partial permutations blocked', () => {
    for (const alter of [
        p => { p.blocks[1].role = 'user'; },
        p => { p.blocks[1].scope = 'other'; },
        p => { p.blocks[1].approvedIndependent = false; },
        p => { p.blocks[1].source.kind = 'history'; },
        p => { p.blocks[0].content = '<rules>'; p.blocks[1].content = '</rules>'; },
    ]) {
        const p = profile(); alter(p);
        assert.equal(previewProposal(p, plan(p), context).ok, false);
    }
    const proposal = plan(); proposal.operations[0].ids = ['a'];
    assert.equal(validateProposal(profile(), proposal, context).ok, false);
});

test('tag pairs cannot cross blocks and malformed nesting is rejected', () => {
    assert.equal(hasBalancedTags('<a><b>x</b></a>'), true);
    assert.equal(hasBalancedTags('<a><b>x</a></b>'), false);
    assert.equal(hasBalancedTags('<a>{{variable}}</a>'), true);
    assert.equal(hasBalancedTags('<a>'), false);
});

test('1.5 million token input and unknown tokenizer fail closed; explicit limits required', () => {
    assert.match(previewProposal(profile(), plan(), { exactInputTokens: 1500000 }).errors[0], /exceeds/);
    assert.equal(previewProposal(profile(), plan(), {}).ok, false);
    const p = profile(); delete p.limits.maxInputTokens;
    assert.equal(previewProposal(p, plan(p), context).ok, false);
    assert.equal(estimateProfileInput(profile(), { byteLevelTokenizer: true }).method, 'missing-other-input-bound');
});

test('apply requires fresh preview, mode and idle request; state immutable on failure', () => {
    const p = profile(), state = createOptimizationState(p), proposal = plan(p), preview = previewProposal(p, proposal, context);
    const original = JSON.stringify(state);
    assert.throws(() => applyProposal(state, proposal, { ...context, expectedPreview: preview, inFlight: true }), /progress/);
    assert.throws(() => applyProposal(state, proposal, context), /preview/);
    state.profile.blocks[0].content += 'external edit';
    assert.throws(() => applyProposal(state, proposal, { ...context, expectedPreview: preview }), /Concurrent/);
    state.profile.blocks[0].content = p.blocks[0].content;
    assert.equal(JSON.stringify(state), original);
    const applied = applyProposal(state, proposal, { ...context, expectedPreview: preview });
    assert.equal(applied.profile.version, 1);
    assert.equal(state.profile.version, 0);
    assert.equal(applied.history.length, 1);
    assert.equal(applied.history[0].reason, proposal.reason);
});

test('rollback restores linked settings and content in a new revision', () => {
    const p = profile(), state = createOptimizationState(p), proposal = plan(p);
    proposal.operations.push({ type: 'set_memory_policy', adapter: 'cache-lens', appendOnly: true, compactAfterEvents: 100 });
    const preview = previewProposal(p, proposal, context);
    const applied = applyProposal(state, proposal, { ...context, expectedPreview: preview });
    assert.equal(applied.profile.memory.compactAfterEvents, 100);
    const restored = rollback(applied, { expectedVersion: 1, expectedProfile: applied.profile });
    assert.deepEqual({ ...restored.profile, version: 0 }, p);
    assert.equal(restored.profile.version, 2);
    assert.throws(() => rollback(applied, { expectedVersion: 0 }), /conflict/);
    assert.throws(() => rollback(applied, { expectedVersion: 1, inFlight: true }), /progress/);
});

test('complete baseline rollback with multiple transactions', () => {
    const initial = createOptimizationState(profile());
    let state = initial;
    for (const compactAfterEvents of [100, 200]) {
        const proposal = { ...plan(state.profile), operations: [{ type: 'set_memory_policy', adapter: 'cache-lens', appendOnly: true, compactAfterEvents }] };
        state = applyProposal(state, proposal, { ...context, expectedPreview: previewProposal(state.profile, proposal, context) });
    }
    const restored = rollback(state, { all: true, expectedVersion: 2, expectedProfile: state.profile });
    assert.deepEqual({ ...restored.profile, version: 0 }, initial.baseline);
});

test('atomic storage save failure and concurrent CAS do not partially apply', async () => {
    const state = createOptimizationState(profile()), proposal = plan(state.profile), preview = previewProposal(state.profile, proposal, context);
    const before = stableStringify(state);
    const store = { read: async () => state, compareAndSwap: async (expected, next) => { assert.equal(expected, before); assert.equal(next.profile.version, 1); return false; } };
    await assert.rejects(commitProposal(store, proposal, { ...context, expectedPreview: preview }), /no transaction committed/);
    assert.equal(stableStringify(state), before);
    store.compareAndSwap = async () => { throw new Error('disk full'); };
    await assert.rejects(commitProposal(store, proposal, { ...context, expectedPreview: preview }), /disk full/);
    assert.equal(stableStringify(state), before);
});

test('native worldbook reorder is isolated; trigger, fact and budget settings stay exact', () => {
    const p = profile();
    p.exports = [{ id: 'book', kind: 'worldbook', copyOnly: true, approvedIndependent: true, activationSelectionInvariant: true, entryIds: ['0', '1'], data: { entries: {
        '0': { uid: 0, content: '<x>Fact A</x>', order: 2, position: 0, constant: false, key: ['Alice'], probability: 100 },
        '1': { uid: 1, content: '<x>Fact B</x>', order: 1, position: 0, constant: false, key: ['Bob'], probability: 100 },
    } } }];
    const proposal = { ...plan(p), operations: [{ type: 'reorder_export', exportId: 'book', ids: ['1', '0'] }] };
    const preview = previewProposal(p, proposal, context);
    assert.equal(preview.ok, true, preview.errors?.join());
    assert.equal(preview.after.exports[0].data.entries['1'].order, 2);
    assert.equal(p.exports[0].data.entries['1'].order, 1);
    assert.equal(preview.after.exports[0].data.entries['0'].constant, false);
    p.exports[0].activationSelectionInvariant = false;
    assert.equal(previewProposal(p, proposal, context).ok, false);
});

test('cache config requires verified protocol rules, exact minimum and stable prefix', () => {
    const p = profile(), rules = { verified: true, protocol: 'anthropic-messages', source: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching', checkedAt: '2026-11-12', models: ['verified-test-model'], ttls: ['5m', '1h'], maxBreakpoints: 4, minTokens: 1024 };
    const proposal = { ...plan(p), operations: [{ type: 'set_cache', enabled: true, protocol: 'anthropic-messages', model: 'verified-test-model', ttl: '5m', blockIds: ['b'] }] };
    assert.equal(previewProposal(p, proposal, { ...context, providerRules: rules }).ok, true);
    assert.equal(previewProposal(p, proposal, context).ok, false);
    p.blocks[0].stable = false;
    assert.equal(previewProposal(p, proposal, { ...context, providerRules: rules }).ok, false);
});

test('prototype pollution and injected executable object rejected', () => {
    const proposal = JSON.parse('{"schemaVersion":1,"expectedVersion":0,"reason":"x","operations":[],"__proto__":{"polluted":true}}');
    assert.equal(validateProposal(profile(), proposal, context).ok, false);
    assert.equal({}.polluted, undefined);
});

test('successive rollback walks previous rounds rather than undoing the rollback itself', () => {
    let state = createOptimizationState(profile());
    for (const compactAfterEvents of [100, 200]) {
        const proposal = { ...plan(state.profile), operations: [{ type: 'set_memory_policy', adapter: 'cache-lens', appendOnly: true, compactAfterEvents }] };
        state = applyProposal(state, proposal, { ...context, expectedPreview: previewProposal(state.profile, proposal, context) });
    }
    state = rollback(state, { expectedVersion: state.profile.version });
    assert.equal(state.profile.memory.compactAfterEvents, 100);
    state = rollback(state, { expectedVersion: state.profile.version });
    assert.equal(state.profile.memory.compactAfterEvents, 50);
    assert.throws(() => rollback(state, { expectedVersion: state.profile.version }), /No changes/);
});

test('full rollback refuses external concurrent edits even with same version', () => {
    const state = createOptimizationState(profile()), proposal = plan(state.profile);
    const applied = applyProposal(state, proposal, { ...context, expectedPreview: previewProposal(state.profile, proposal, context) });
    applied.profile.memory.compactAfterEvents = 999;
    assert.throws(() => rollback(applied, { all: true, expectedVersion: applied.profile.version }), /outside transaction/);
});
