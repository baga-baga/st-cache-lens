import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLedger, appendMemory, renderMemory, memoryStatus, compactMemory, restoreLastCompaction, ReadOnlyAdapterRegistry } from '../core/memory.js';
const event = (id, date = '2026-11-01') => ({ id, occurredAt: date, text: 'Alice found the key.', originalTimeText: '5天前', protectedFacts: ['Alice found the key.'], source: 'user-confirmed-story' });

test('append-only memory keeps exact previous rendered prefix and time expressions', () => {
    let ledger = appendMemory(createMemoryLedger(), event('a'));
    const prior = renderMemory(ledger);
    ledger = appendMemory(ledger, { ...event('b', '2026-11-02'), originalTimeText: '上周二' });
    assert.ok(renderMemory(ledger).startsWith(prior));
    assert.match(renderMemory(ledger), /2026-11-01/);
    assert.match(renderMemory(ledger), /5天前/);
    assert.equal(memoryStatus(ledger).automaticSemanticCompaction, false);
});

test('old summary rewrite blocked; idempotent replay and explicit correction events supported', () => {
    const ledger = appendMemory(createMemoryLedger(), event('a'));
    assert.deepEqual(appendMemory(ledger, event('a')), ledger);
    assert.throws(() => appendMemory(ledger, { ...event('a'), text: 'A different fact', protectedFacts: [] }), /immutable/);
    assert.throws(() => appendMemory(ledger, event('b'), { expectedVersion: 0 }), /conflict/);
});

test('relative date cannot silently be guessed or rewritten', () => {
    assert.throws(() => appendMemory(createMemoryLedger(), event('a', 'last Tuesday')), /ISO/);
    assert.throws(() => appendMemory(createMemoryLedger(), event('a', '2026-02-30')), /ISO/);
    assert.throws(() => appendMemory(createMemoryLedger(), event('a', '2026-02-30T12:00:00Z')), /ISO/);
});

test('semantic compaction is separate opt-in, preserves protected facts and dates, fully reversible', () => {
    let ledger = createMemoryLedger({ compactAfterEvents: 2 });
    ledger = appendMemory(ledger, event('a'));
    ledger = appendMemory(ledger, event('b', '2026-11-02'));
    assert.equal(memoryStatus(ledger).compactionDue, true);
    assert.throws(() => compactMemory(ledger, { expectedVersion: 2, count: 2, summary: 'x' }), /opt-in/);
    assert.throws(() => compactMemory(ledger, { expectedVersion: 2, count: 2, summary: 'Alice found the key.', semanticOptIn: true, reviewedSummary: true }), /date/);
    const compacted = compactMemory(ledger, { expectedVersion: 2, count: 2, summary: '2026-11-01 and 2026-11-02: Alice found the key.', semanticOptIn: true, reviewedSummary: true });
    assert.equal(compacted.entries.length, 0);
    assert.equal(compacted.archives[0].entries.length, 2);
    const restored = restoreLastCompaction(compacted, { expectedVersion: 3 });
    assert.equal(renderMemory(restored), renderMemory(ledger));
});

test('unknown third-party memory read-only; registry exposes data not mutation tools', async () => {
    assert.throws(() => appendMemory({ ...createMemoryLedger(), adapter: 'unknown-plugin' }, event('a')), /read-only/);
    const registry = new ReadOnlyAdapterRegistry();
    registry.register({ id: 'known-export', documentation: 'Public JSON export read-only contract', read: async () => ({ snapshot: 'x' }) });
    assert.equal(registry.list()[0].access, 'read-only');
    assert.deepEqual((await registry.read('known-export')).data, { snapshot: 'x' });
    await assert.rejects(registry.read('unconfirmed-cache-plugin'), /Unknown/);
});
