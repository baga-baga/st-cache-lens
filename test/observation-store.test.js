import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationStore } from '../adapters/observation-store.js';
import { redactedExport, importEvidence } from '../adapters/reporting.js';

function memoryStorage() {
    const items = new Map();
    return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
}
const record = (id, extra = {}) => ({ id, model: 'claude-opus-5-5', provider: 'claude', interfaceType: 'anthropic', purpose: 'main', observationLevel: 'frontend', startedAt: '2026-11-12T07:00:00.000Z', status: 'complete', usage: { input_tokens: 30, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 5 }, latencyMs: 2500, ...extra });
const mockLocks = { request: async (_name, _options, callback) => callback() };
const make = (storage, extra = {}) => createObservationStore({ storage, key: 'account:a:observations', locks: mockLocks, ...extra });

test('archive reload preserves redacted metadata and same-id completion updates deduplicate', async () => {
    const storage = memoryStorage(), store = make(storage);
    await store.upsert([record('cl-1-1', { status: 'pending', usage: null })]);
    await store.upsert([record('cl-1-1')]);
    const loaded = await make(storage).read();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'cl-1-1');
    assert.equal(loaded[0].usage.cache_read_input_tokens, 200);
    assert.equal(loaded[0].status, 'complete');
    assert.equal(loaded[0].observationLevel, 'frontend');
    assert.equal(loaded[0].imported, false);
    loaded[0].usage.input_tokens = 999;
    assert.equal((await store.read())[0].usage.input_tokens, 30);
});

test('metadata-only archive omits prompts, source names, excerpts, headers, endpoint, reasons and credential-looking ids', async () => {
    const storage = memoryStorage(), store = make(storage);
    await store.upsert([record('api_key=SECRET_ID', {
        body: { system: 'SECRET_STORY' }, sources: [{ name: 'SECRET_BOOK' }], headers: { authorization: 'SECRET_KEY' }, endpoint: 'https://private.invalid/SECRET_ENDPOINT', reason: 'SECRET_REASON',
        usage: { input_tokens: 3, arbitrary: 'SECRET_USAGE', input_tokens_details: { cached_tokens: 2, name: 'SECRET_NAME' } },
        platformBill: { amount: 1.2, currency: 'USD', note: 'SECRET_BILL' },
        diagnostic: { stablePrefixCharacters: 300, firstDifference: { currentPath: 'messages[0].content', kind: 'content', currentExcerpt: 'SECRET_EXCERPT' }, findings: [{ code: 'CONTEXT_PREFIX_CHANGED', severity: 'notice', source: 'SECRET_SOURCE' }, { code: 'SECRET_DIAGNOSTIC', severity: 'error' }] },
    })]);
    const serialized = storage.items.values().next().value;
    assert.equal(serialized.includes('SECRET'), false);
    assert.equal(serialized.includes('private.invalid'), false);
    const [saved] = await store.read();
    assert.match(saved.id, /^hashed:[a-f0-9]{64}$/);
    assert.equal(saved.diagnostic.firstDifference.path, 'messages[0].content');
    assert.equal(saved.diagnostic.findings.length, 1);
    assert.deepEqual(saved.platformBill, { amount: 1.2, currency: 'USD', evidence: 'user-imported-platform-bill' });
    await store.upsert([record('api_key=SECRET_ID')]);
    assert.equal((await store.read()).length, 1);
});

test('read applies the privacy allowlist to persisted records and preserves known evidence layers', async () => {
    const storage = memoryStorage(), store = make(storage);
    await store.upsert([record('relay:one', { observationLevel: 'server-relay', status: 200, completion: 'complete', synthetic: true })]);
    const envelope = JSON.parse(storage.items.get('account:a:observations'));
    envelope.records[0].body = { system: 'INJECTED_STORY' };
    envelope.records[0].endpoint = 'https://private.invalid';
    envelope.records[0].diagnostic.firstDifference = { path: 'SECRET_PATH', kind: 'SECRET_KIND', excerpt: 'SECRET_EXCERPT' };
    storage.items.set('account:a:observations', JSON.stringify(envelope));
    const [saved] = await store.read();
    assert.equal(saved.body, undefined);
    assert.equal(saved.endpoint, undefined);
    assert.equal(saved.diagnostic.firstDifference.path, null);
    assert.equal(saved.diagnostic.firstDifference.kind, null);
    assert.equal(saved.observationLevel, 'server-relay');
    assert.equal(saved.status, 200);
    assert.equal(saved.synthetic, true);
});

test('account-specific storage keys remain isolated, including clear', async () => {
    const storage = memoryStorage();
    const a = make(storage), b = make(storage, { key: 'account:b:observations' });
    await a.upsert([record('same-id')]);
    await b.upsert([record('same-id', { purpose: 'summary' })]);
    assert.equal((await a.read())[0].purpose, 'main');
    assert.equal((await b.read())[0].purpose, 'summary');
    await a.clear();
    assert.deepEqual(await a.read(), []);
    assert.equal((await b.read()).length, 1);
});

test('corrupt archives fail closed and are never overwritten until explicit clear', async () => {
    const storage = memoryStorage(), store = make(storage);
    storage.items.set('account:a:observations', '{broken JSON');
    await assert.rejects(store.read(), { code: 'OBSERVATION_ARCHIVE_CORRUPT' });
    await assert.rejects(store.upsert([record('new')]), { code: 'OBSERVATION_ARCHIVE_CORRUPT' });
    assert.equal(storage.items.get('account:a:observations'), '{broken JSON');
    await store.clear();
    await store.upsert([record('new')]);
    assert.equal((await store.read()).length, 1);
});

test('quota, read and clear failures are surfaced; failed write does not actively delete old archive', async () => {
    const storage = memoryStorage(), store = make(storage);
    await store.upsert([record('old')]);
    const original = storage.items.get('account:a:observations');
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    await assert.rejects(store.upsert([record('new')]), { code: 'OBSERVATION_STORAGE_WRITE_FAILED' });
    assert.equal(storage.items.get('account:a:observations'), original);
    storage.getItem = () => { throw new Error('denied'); };
    await assert.rejects(store.read(), { code: 'OBSERVATION_STORAGE_READ_FAILED' });
    storage.removeItem = () => { throw new Error('denied'); };
    await assert.rejects(store.clear(), { code: 'OBSERVATION_STORAGE_CLEAR_FAILED' });
});

test('record and UTF-8 byte bounds evict oldest observations', async () => {
    const storage = memoryStorage(), store = make(storage, { maxRecords: 2 });
    await store.upsert([record('new', { startedAt: '2026-11-12T09:00:00Z' }), record('old', { startedAt: '2026-11-12T07:00:00Z' }), record('middle', { startedAt: '2026-11-12T08:00:00Z' })]);
    assert.deepEqual((await store.read()).map(r => r.id), ['middle', 'new']);
    const tiny = make(storage, { key: 'account:a:tiny', maxBytes: 1300 });
    await tiny.upsert([record('one'), record('two'), record('three')]);
    assert.ok(new TextEncoder().encode(storage.items.get('account:a:tiny')).byteLength <= 1300);
    const retained = await tiny.read();
    assert.ok(retained.length < 3);
    if (retained.length) assert.equal(retained.at(-1).id, 'three');
});

test('simultaneous stores with same storage/key merge without losing observations; supplied lock is used', async () => {
    const storage = memoryStorage(), calls = [];
    const locks = { request: async (name, options, callback) => { calls.push({ name, options }); return callback(); } };
    const a = make(storage, { locks }), b = make(storage, { locks });
    await Promise.all([a.upsert([record('one')]), b.upsert([record('two')]), a.upsert([record('three')])]);
    assert.equal((await b.read()).length, 3);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(c => c.name === 'cache-lens-observation:account:a:observations' && c.options.mode === 'exclusive'));
});

test('manual purpose, trust taints, known usage and historical Agent prices survive stale refresh', async () => {
    const storage = memoryStorage(), store = make(storage);
    const prices = { input: 0.1, output: 0.2, cacheRead: 0.01, currency: 'USD', source: 'https://prices.example/table?api_key=SECRET_PRICE', updatedAt: '2026-11-12', note: 'SECRET_NOTE' };
    await store.upsert([record('agent:one', { purpose: 'summary', manualPurpose: true, observationLevel: 'agent-server', synthetic: true, prices })]);
    await store.upsert([record('agent:one', { purpose: 'agent', observationLevel: 'agent-server', usage: null, status: 'pending' })]);
    const [saved] = await make(storage).read();
    assert.equal(saved.purpose, 'summary');
    assert.equal(saved.manualPurpose, true);
    assert.equal(saved.synthetic, true);
    assert.equal(saved.usage.input_tokens, 30);
    assert.equal(saved.status, 'complete');
    assert.equal(saved.prices.input, 0.1);
    assert.equal(saved.prices.source, 'https://prices.example/table');
    assert.equal(JSON.stringify(saved).includes('SECRET'), false);
});

test('invalid schema and missing IDs fail without creating a record or falling back to an unscoped key', async () => {
    const storage = memoryStorage();
    assert.throws(() => createObservationStore({ storage }), /key/);
    assert.throws(() => make(storage, { maxBytes: 1 }), /bounds/);
    const store = make(storage);
    await assert.rejects(store.upsert([{}]), { code: 'OBSERVATION_ID_REQUIRED' });
    assert.equal(storage.items.size, 0);
    storage.items.set('account:a:observations', JSON.stringify({ records: [] }));
    await assert.rejects(store.read(), { code: 'OBSERVATION_ARCHIVE_CORRUPT' });
});

test('compact difference offset and prior-request comparison survive repeated archive reads', async () => {
    const storage = memoryStorage(), store = make(storage);
    const diagnostic = { stablePrefixCharacters: 12345, appendOnly: false, equal: false, comparable: true, firstDifference: { currentPath: 'messages[12].content[1].text', kind: 'content', offset: 876 }, comparison: { previousStartedAt: '2026-11-12T06:59:00.000Z', previousStatus: 'complete', previousBody: 'SECRET_PREVIOUS' }, needsAnotherRequest: false };
    await store.upsert([record('diff-one', { diagnostic })]);
    const first = await store.read();
    await store.upsert(first);
    const [second] = await make(storage).read();
    assert.equal(second.diagnostic.firstDifference.path, 'messages[12].content[1].text');
    assert.equal(second.diagnostic.firstDifference.offset, 876);
    assert.equal(second.diagnostic.comparison.previousStartedAt, '2026-11-12T06:59:00.000Z');
    assert.equal(second.diagnostic.comparison.previousStatus, 'complete');
    assert.equal(second.diagnostic.comparable, true);
    assert.equal(second.diagnostic.equal, false);
    assert.equal(JSON.stringify(second).includes('SECRET'), false);
});


test('missing Web Locks permits reads but fails closed on every write and clear without overwriting', async () => {
    const storage = memoryStorage();
    await make(storage).upsert([record('existing')]);
    const original = storage.items.get('account:a:observations');
    const readonly = make(storage, { locks: null });
    assert.equal((await readonly.read())[0].id, 'existing');
    await assert.rejects(readonly.upsert([record('new')]), { code: 'OBSERVATION_LOCKS_REQUIRED' });
    await assert.rejects(readonly.clear(), { code: 'OBSERVATION_LOCKS_REQUIRED' });
    assert.equal(storage.items.get('account:a:observations'), original);
});

test('imported reported failure status is preserved separately without upgrading observation trust', async () => {
    const storage = memoryStorage(), store = make(storage);
    await store.upsert([record('import:1', { observationLevel: 'imported', imported: true, status: 'imported', reportedStatus: 'http-error' }), record('import:2', { imported: true, status: 'imported', reportedStatus: 'SECRET_LABEL' })]);
    const loaded = await store.read();
    assert.equal(loaded[0].status, 'imported');
    assert.equal(loaded[0].reportedStatus, 'http-error');
    assert.equal(loaded[0].observationLevel, 'imported');
    assert.equal(loaded[0].imported, true);
    assert.equal(loaded[1].reportedStatus, undefined);
    await store.upsert([record('import:1', { imported: true, status: 'imported' })]);
    assert.equal((await store.read())[0].reportedStatus, 'http-error');
});

test('replay, predicted and offline preview evidence remain synthetic through reload and stale refresh', async () => {
    const storage = memoryStorage(), store = make(storage);
    const taints = [{ replay: true }, { predicted: true }, { evidence: 'offline-preview' }];
    await store.upsert(taints.map((taint, i) => record(`taint:${i}`, taint)));
    await store.upsert(taints.map((_taint, i) => record(`taint:${i}`)));
    const loaded = await make(storage).read();
    assert.equal(loaded.length, 3);
    assert.ok(loaded.every(item => item.synthetic === true));
});

test('batch outcome survives reload, same-id stale refresh and redacted export without text or false usage evidence', async () => {
    const storage = memoryStorage(), store = make(storage);
    const expected = { algorithm: 'activated-world-info-stable-first-v1', policyVersion: 4, selectedEntries: 10, selectedGroups: 2, applied: true, input: { upperBound: 150000, ceiling: 180000, exact: false } };
    await store.upsert([record('batch-one', { usage: null, batchResult: { ...expected, reason: 'PRIVATE_REASON', names: ['PRIVATE_BOOK'], input: { ...expected.input, method: 'PRIVATE_METHOD', exact: true }, expectedImpact: { note: 'PRIVATE_IMPACT' } } })]);
    const [first] = await make(storage).read();
    assert.deepEqual(first.batchResult, expected);
    assert.equal(first.usage, null);
    assert.equal(JSON.stringify(first).includes('PRIVATE'), false);
    await store.upsert([record('batch-one', { usage: null, batchResult: { algorithm: 'UNKNOWN_PRIVATE' } })]);
    await store.upsert([record('batch-one', { usage: null })]);
    const [reloaded] = await make(storage).read();
    assert.deepEqual(reloaded.batchResult, expected);
    const exported = redactedExport({ records: [reloaded] });
    assert.deepEqual(exported.records[0].batchResult, expected);
    await make(storage, { key: 'account:a:imported' }).upsert(importEvidence(exported, { idPrefix: 'import:batch' }));
    const [imported] = await make(storage, { key: 'account:a:imported' }).read();
    assert.deepEqual(imported.batchResult, expected);
    assert.equal(imported.observationLevel, 'imported');
    assert.equal(imported.imported, true);
    assert.equal(imported.usage, null);
    assert.equal(JSON.stringify([...storage.items.values()]).includes('PRIVATE'), false);
});

test('batch archive permits valid unapplied zero counts and rejects malformed outcomes', async () => {
    const storage = memoryStorage(), store = make(storage);
    const skipped = { algorithm: 'activated-world-info-stable-first-v1', policyVersion: 0, selectedEntries: 0, selectedGroups: 0, applied: false };
    await store.upsert([record('skipped', { batchResult: skipped }), record('invalid', { batchResult: { ...skipped, selectedEntries: Infinity, reason: 'PRIVATE' } })]);
    const loaded = await make(storage).read();
    assert.deepEqual(loaded[0].batchResult, skipped);
    assert.equal(loaded[1].batchResult, undefined);
    assert.equal(JSON.stringify(loaded).includes('PRIVATE'), false);
});
