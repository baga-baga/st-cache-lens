import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { mountCacheLens } from '../index.js';

const realTimeout = globalThis.setTimeout;
const pause = ms => new Promise(resolve => realTimeout(resolve, ms));
async function waitFor(predicate, label, attempts = 80) {
    for (let i = 0; i < attempts; i++) { if (predicate()) return; await pause(5); }
    assert.fail(`Timed out waiting for ${label}`);
}
function fixture(suffix = 'a', purpose = 'main') {
    const book = `book-${suffix}`, dynamicText = `<lore>召回人物 ${suffix} 的完整事实。</lore>`, stableText = `<lore>基础世界 ${suffix} 的稳定设定。</lore>`;
    const source = (uid, text, constant) => ({ id: `world:${book}:${uid}`, kind: 'world-info', name: `${constant ? '固定' : '召回'}资料 ${suffix}`, provenance: 'WORLD_INFO_ACTIVATED', text, content: text, entry: { uid, world: book, content: text, constant, key: constant ? [] : ['角色'], position: 0, depth: 4, role: 0, order: 100, disable: false } });
    const sources = [source(1, dynamicText, false), source(2, stableText, true)];
    const record = { id: `request-${suffix}`, chatId: `chat-${suffix}`, characterId: `character-${suffix}`, groupId: null, model: 'test-story-model', provider: 'claude', interfaceType: 'anthropic', purpose, observationLevel: 'frontend', status: 'complete', startedAt: '2026-11-13T08:00:00.000Z', usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }, sources,
        body: { model: 'test-story-model', chat_completion_source: 'claude', messages: [{ role: 'system', content: `<world_info>\n${dynamicText}\n${stableText}\n</world_info>` }, { role: 'user', content: '继续剧情' }] } };
    const setup = { schemaVersion: 1, compatibility: { version: '1.19.0', verifiedSource: true }, binding: { chatId: record.chatId, characterId: record.characterId, groupId: null, provider: record.provider, model: record.model, purpose: 'main' }, books: [{ id: 'book-1', name: book, boundBy: ['character-primary'], loaded: true, entries: sources.map(s => structuredClone(s.entry)), entryKeys: ['1', '2'], options: {} }], worldSettings: { world_info_budget: 25, world_info_budget_cap: 30000, world_info_recursive: true }, preset: { prompts: [], order: [], orderStrategy: 'global', settings: {} }, extensionSources: [], snapshot: { activeEntries: sources.map(s => structuredClone(s.entry)), activationEventSeen: true, budgetTokens: 30000 }, counts: { booksExpected: 1, booksLoaded: 1, books: 1, entries: 2 }, complete: true, truncated: false, optimizationBlocked: false, coverageUnknown: [], warnings: [], revision: { algorithm: 'SHA-256', fingerprint: `fixture-revision-${suffix}`, requiresRecaptureBeforeApply: true } };
    return { record, setup, dynamicText, stableText };
}
let harnessSerial = 0;
async function harness({ current = fixture(), collector } = {}) {
    const dom = new JSDOM('<div id="extensions_settings2"></div>', { url: 'http://localhost:8000' });
    const descriptors = {}, fetches = [], locks = { request: async (_name, options, callback) => (callback || options)() };
    const globals = { document: dom.window.document, window: dom.window, localStorage: dom.window.localStorage, navigator: { locks }, setTimeout: (fn, ms, ...args) => realTimeout(fn, ms === 600 ? 20 : ms, ...args), fetch: async (...args) => { fetches.push(args); throw new Error('Unexpected network / paid call in batch UI test'); } };
    for (const [key, value] of Object.entries(globals)) { descriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
    const eventSource = new EventEmitter(), eventTypes = Object.fromEntries(['CHAT_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'WORLDINFO_SETTINGS_UPDATED', 'CHARACTER_EDITED'].map(key => [key, key]));
    const context = { chatId: current.record.chatId, characterId: current.record.characterId, groupId: null, extensionSettings: {}, saveSettingsDebounced() {}, getWorldInfoNames: () => [], eventSource, eventTypes };
    let setup = structuredClone(current.setup), hooks, collectionCount = 0, adapterDisposed = false, snapshot = {};
    const panel = mountCacheLens({ context, storageNamespace: `batch-dom-${++harnessSerial}`, locks, setupCollector: async args => { collectionCount++; return collector ? collector({ args, count: collectionCount, setup: structuredClone(setup), context }) : structuredClone(setup); }, adapterFactory: value => { hooks = value; return { dispose() { adapterDisposed = true; }, getSnapshot: () => snapshot, getSources: () => [], inspectWorldBook: async () => ({}) }; } });
    await panel.ready;
    const root = document.getElementById('cache-lens-panel'), q = selector => root.querySelector(selector);
    const click = async name => { q(`[data-action="${name}"]`).click(); await pause(25); };
    const set = (id, value) => { q(`[data-id="${id}"]`).value = value; };
    const toggleFollow = async enabled => { const element = q('[data-id="batchFollow"]'); element.checked = enabled; element.dispatchEvent(new dom.window.Event('change')); await pause(25); };
    return { dom, context, root, q, set, click, toggleFollow, panel, hooks, fetches, get collectionCount() { return collectionCount; }, get adapterDisposed() { return adapterDisposed; },
        setSetup(next) { setup = structuredClone(next); context.chatId = next.binding.chatId; context.characterId = next.binding.characterId; }, setSnapshot(next) { snapshot = next; },
        emit(record = current.record) { hooks.onRecord(structuredClone(record)); },
        async close() { panel.dispose(); await panel.flushObservations(); dom.window.close(); for (const [key, descriptor] of Object.entries(descriptors)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
    };
}

test('mounted batch scan is free, automatically exposes all bound entries and refuses zero-budget Agent', async () => {
    const h = await harness();
    try {
        h.emit(); await h.click('batch-scan');
        assert.equal(h.collectionCount, 1);
        assert.equal(h.panel.getBatchReport().counts.entries, 2);
        assert.equal(h.panel.getBatchReport().safety.noPaidRequests, true);
        assert.equal(h.context.extensionSettings.cache_lens.batchFollow, true);
        assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
        await h.click('batch-agent');
        assert.match(h.q('[data-id="status"]').textContent, /预算/);
        assert.equal(h.fetches.length, 0);
        assert.equal(h.context.extensionSettings.cache_lens.batchHistory.length, 0);
    } finally { await h.close(); }
});

test('mounted enable applies current-request sorting without per-entry selection, blocks manual apply, and restores linked state', async () => {
    const f = fixture(), h = await harness({ current: f });
    try {
        h.emit(); await h.click('batch-scan'); await h.toggleFollow(false);
        const native = JSON.stringify(f.setup.books);
        await h.click('batch-enable');
        const settings = h.context.extensionSettings.cache_lens;
        assert.equal(settings.batchPolicy.enabled, true, h.q('[data-id="status"]').textContent);
        assert.equal(settings.mode, 'preview'); assert.equal(settings.batchFollow, true);
        assert.deepEqual(settings.baselineIds, ['request-a']);
        const meta = { ...f.record, sources: structuredClone(f.record.sources), snapshot: { activationEventSeen: true, generation: { type: 'normal', dryRun: false } } }; delete meta.body;
        const sorted = await h.hooks.transform(structuredClone(f.record.body), meta);
        assert.equal(sorted.messages[0].content, `<world_info>\n${f.stableText}\n${f.dynamicText}\n</world_info>`);
        assert.equal(meta.batchResult.applied, true);
        assert.equal(JSON.stringify(f.setup.books), native);
        await h.click('apply'); assert.match(h.q('[data-id="status"]').textContent, /批量排序已启用/);
        await h.click('batch-rollback');
        assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
        assert.equal(h.context.extensionSettings.cache_lens.mode, 'diagnose');
        assert.equal(h.context.extensionSettings.cache_lens.batchFollow, false);
        assert.deepEqual(h.context.extensionSettings.cache_lens.baselineIds, []);
        assert.equal(h.context.extensionSettings.cache_lens.batchHistory[0].rollback, true);
        const original = await h.hooks.transform(structuredClone(f.record.body), { ...f.record });
        assert.deepEqual(original, f.record.body);
        assert.equal(h.fetches.length, 0);
    } finally { await h.close(); }
});

test('batch enable refuses a stale scan revision without committing a policy or history', async () => {
    const h = await harness({ collector: ({ count, setup }) => { if (count > 1) setup.revision.fingerprint = 'changed-since-preview'; return setup; } });
    try {
        h.emit(); await h.click('batch-scan'); await h.click('batch-enable');
        assert.match(h.q('[data-id="status"]').textContent, /已改变|重新扫描/);
        assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
        assert.equal(h.context.extensionSettings.cache_lens.batchHistory.length, 0);
        assert.equal(h.fetches.length, 0);
    } finally { await h.close(); }
});

test('batch enable refuses concurrent settings edits during recheck and preserves the other edit', async () => {
    let release;
    const h = await harness({ collector: ({ count, setup }) => count === 2 ? new Promise(resolve => { release = () => resolve(setup); }) : setup });
    try {
        h.emit(); await h.click('batch-scan');
        h.q('[data-action="batch-enable"]').click(); await waitFor(() => !!release, 'enable recheck');
        h.context.extensionSettings.cache_lens.maxInputTokens = 77777;
        release(); await waitFor(() => /其他窗口|插件改变|并发/.test(h.q('[data-id="status"]').textContent), 'concurrent-edit refusal');
        assert.equal(h.context.extensionSettings.cache_lens.maxInputTokens, 77777);
        assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
        assert.equal(h.context.extensionSettings.cache_lens.batchHistory.length, 0);
    } finally { await h.close(); }
});

test('explicit current-connection classification changes only unknown purpose, preserving summary model accounting', async () => {
    const f = fixture('a', 'unknown'), h = await harness({ current: f });
    try {
        h.emit();
        h.emit({ ...f.record, id: 'deepseek-summary', provider: 'deepseek', interfaceType: 'deepseek', model: 'deepseek-chat', purpose: 'summary' });
        h.emit({ ...f.record, id: 'claude-summary', purpose: 'summary' });
        await h.click('batch-scan');
        assert.equal(h.q('[data-action="batch-mark-main"]').hidden, false);
        await h.click('batch-enable'); assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
        await h.click('batch-mark-main');
        assert.equal(h.panel.getRecords().find(r => r.id === 'request-a').purpose, 'main');
        assert.equal(h.panel.getRecords().find(r => r.id === 'deepseek-summary').purpose, 'summary');
        assert.equal(h.panel.getRecords().find(r => r.id === 'claude-summary').purpose, 'summary');
        assert.equal(h.hooks.resolvePurpose({ chat_completion_source: 'claude', model: f.record.model }), 'main');
        assert.equal(h.hooks.resolvePurpose({ chat_completion_source: 'deepseek', model: 'deepseek-chat' }), undefined);
        assert.equal(h.q('[data-action="batch-mark-main"]').hidden, true);
        assert.equal(h.fetches.length, 0);
    } finally { await h.close(); }
});

test('follow mode invalidates switched-card report, rescans for free and sorts only the new request content', async () => {
    const f = fixture('a'), next = fixture('b'), h = await harness({ current: f });
    try {
        h.emit(); await h.click('batch-scan'); await h.click('batch-enable');
        h.setSetup(next.setup); h.context.eventSource.emit('CHAT_CHANGED');
        assert.equal(h.panel.getBatchReport(), null);
        assert.match(h.q('[data-id="batchDetails"]').textContent, /已失效/);
        await waitFor(() => h.panel.getBatchReport()?.books?.[0]?.name === 'book-b', 'followed new card');
        const meta = { ...next.record, sources: structuredClone(next.record.sources), snapshot: { activationEventSeen: true, generation: { type: 'normal', dryRun: false } } }; delete meta.body;
        const changed = await h.hooks.transform(structuredClone(next.record.body), meta);
        assert.ok(changed.messages[0].content.indexOf(next.stableText) < changed.messages[0].content.indexOf(next.dynamicText));
        assert.equal(changed.messages[0].content.includes(f.dynamicText), false);
        const summary = await h.hooks.transform(structuredClone(next.record.body), { ...meta, purpose: 'summary' });
        assert.deepEqual(summary, next.record.body);
        assert.equal(h.fetches.length, 0);
        const count = h.collectionCount;
        await h.toggleFollow(false); h.context.eventSource.emit('OAI_PRESET_CHANGED_AFTER');
        await pause(45); assert.equal(h.collectionCount, count);
    } finally { await h.close(); }
});

test('linked mode, baseline and follow edits make batch rollback refuse to overwrite current choices', async t => {
    for (const change of ['mode', 'baseline', 'follow']) await t.test(change, async () => {
        const h = await harness();
        try {
            h.emit(); await h.click('batch-scan'); await h.click('batch-enable');
            assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, true);
            if (change === 'mode') { h.set('mode', 'automatic'); await h.click('save'); }
            if (change === 'baseline') { h.emit({ ...fixture().record, id: 'later-observation' }); await h.click('baseline'); }
            if (change === 'follow') await h.toggleFollow(false);
            const settingsBefore = structuredClone(h.context.extensionSettings.cache_lens);
            await h.click('batch-rollback');
            assert.match(h.q('[data-id="status"]').textContent, /关联模式|跟随设置|未强行覆盖/);
            assert.deepEqual(h.context.extensionSettings.cache_lens, settingsBefore);
            assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, true);
        } finally { await h.close(); }
    });
});

test('follow scan waits for active generation and resumes from adapter completion without paid calls', async () => {
    const h = await harness();
    try {
        h.emit(); await h.click('batch-scan');
        const before = h.collectionCount;
        h.setSnapshot({ generation: { type: 'normal' }, inFlight: 1 }); h.hooks.onInFlight(1);
        h.context.eventSource.emit('WORLDINFO_SETTINGS_UPDATED'); await pause(45);
        assert.equal(h.collectionCount, before);
        h.setSnapshot({}); h.hooks.onInFlight(0);
        await waitFor(() => h.collectionCount > before, 'deferred scan after request');
        assert.equal(h.fetches.length, 0);
    } finally { await h.close(); }
});


test('a delayed scan from the previous card is discarded after invalidation and followed by one fresh scan', async () => {
    let releaseOld, releaseNew;
    const next = fixture('b');
    const h = await harness({ collector: ({ count, setup }) => {
        if (count === 2) return new Promise(resolve => { releaseOld = () => resolve(setup); });
        if (count === 3) return new Promise(resolve => { releaseNew = () => resolve(setup); });
        return setup;
    } });
    try {
        h.emit(); await h.click('batch-scan');
        h.context.eventSource.emit('OAI_PRESET_CHANGED_AFTER');
        await waitFor(() => !!releaseOld, 'old scan in flight');
        h.setSetup(next.setup); h.context.eventSource.emit('CHAT_CHANGED');
        assert.equal(h.panel.getBatchReport(), null);
        releaseOld();
        await waitFor(() => !!releaseNew, 'replacement scan after epoch change');
        assert.equal(h.panel.getBatchReport(), null, 'old completed scan must never replace invalidation state');
        assert.match(h.q('[data-id="batchDetails"]').textContent, /已失效/);
        releaseNew();
        await waitFor(() => h.panel.getBatchReport()?.books?.[0]?.name === 'book-b', 'fresh new-card report');
        assert.equal(h.collectionCount, 3);
        assert.equal(h.fetches.length, 0);
    } finally { if (releaseOld) releaseOld(); if (releaseNew) releaseNew(); await h.close(); }
});

test('full restore disables batch policy and restores its original linked baseline and follow setting',async()=>{
 const h=await harness();
 try{
  h.emit();await h.click('batch-scan');await h.toggleFollow(false);await h.click('batch-enable');
  assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled,true);
  h.set('mode','automatic');await h.click('save');
  await h.click('restore');
  const s=h.context.extensionSettings.cache_lens;
  assert.equal(s.batchPolicy.enabled,false);assert.equal(s.mode,'diagnose');assert.equal(s.batchFollow,false);assert.deepEqual(s.baselineIds,[]);assert.ok(s.batchHistory.every(tx=>tx.rollback));
  assert.equal(h.fetches.length,0);
 }finally{await h.close();}
});
