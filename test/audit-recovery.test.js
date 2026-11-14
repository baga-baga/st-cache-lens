import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAgentHistory, auditFailureMessage, agentHistorySummary } from '../adapters/audit-recovery.js';

const sample = (index, overrides = {}) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, time: new Date(Date.UTC(2026, 10, 13, 0, 0, index)).toISOString(), status: 'failed', error: 'AGENT_PROPOSAL_NOT_JSON', currency: 'USD', reservedCost: 0.04, actualCost: null, spendGuard: 'reservation-retained-usage-unknown', latencyMs: 320, ...overrides });

test('recent failure recovery is bounded, newest first, and never claims audit correlation', () => {
    const records = Array.from({ length: 14 }, (_, index) => sample(index));
    records.push({ status: 'completed', error: 'SHOULD_NOT_INCLUDE' }, { status: 'reserved' });
    const history = sanitizeAgentHistory(records, { busy: true, ledger: { calls: 16, chargedOrReserved: 0.6, currency: 'USD', apiKey: 'private' } });
    assert.equal(history.correlatedToAudit, false);
    assert.equal(history.serverBusy, true);
    assert.equal(history.recentFailures.length, 10);
    assert.equal(history.totalFailureRecords, 14);
    assert.equal(history.recentFailures[0].time, sample(13).time);
    assert.equal(history.recentFailures[9].time, sample(4).time);
    assert.deepEqual(history.ledger, { calls: 16, chargedOrReserved: 0.6, currency: 'USD' });
    assert.equal(history.recentFailures[0].failure.stage, 'server-record');
    assert.equal(history.recentFailures[0].failure.retryAttempted, false);
    assert.match(agentHistorySummary(history), /未新增模型调用/);
    assert.match(agentHistorySummary(history), /仍有 Agent 请求进行中/);
});

test('unknown errors, arbitrary model/body/IDs and secret strings never enter history exports or summaries', () => {
    const secret = 'sk-private-example-abcdef1234567890';
    const history = sanitizeAgentHistory([sample(0, { id: secret, error: `PRIVATE_${secret}`, time: '2026-11-13T00:00:00.000Z?api_key=' + secret, model: secret, response: { text: 'private story' }, apiKey: secret, extra: { password: secret }, usage: { prompt_tokens: 22, output_tokens: 4, api_key: secret, unknown: 33, prompt_tokens_details: { cached_tokens: 7, story: secret } } })], { busy: 'yes', ledger: { calls: 1, chargedOrReserved: 0.02, currency: secret } });
    const serialized = JSON.stringify(history);
    assert.doesNotMatch(serialized, /sk-private|private story|api_key|password|PRIVATE_/);
    assert.equal(history.ledger, null);
    assert.equal(history.serverBusy, null);
    assert.equal(history.recentFailures[0].time, null);
    assert.equal(history.recentFailures[0].id, undefined);
    assert.equal(history.recentFailures[0].failure.code, 'AUDIT_UNKNOWN_ERROR');
    assert.deepEqual(history.recentFailures[0].usage, { prompt_tokens: 22, output_tokens: 4, prompt_tokens_details: { cached_tokens: 7 } });
    assert.doesNotMatch(agentHistorySummary(history), /sk-private|private story/);
    assert.doesNotMatch(auditFailureMessage({ code: secret, message: secret, stage: secret }), /sk-private/);
});

test('invalid numbers, timestamps and unrecognized billing guards are discarded without changing original evidence', () => {
    const input = sample(0, { time: '2026-02-30T00:00:00.000Z', actualCost: -1, reservedCost: Infinity, latencyMs: 1.2, spendGuard: 'raw-private-value', currency: 'USD-private', usage: { prompt_tokens: 1e100, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: -2 } } });
    const before = structuredClone(input);
    const record = sanitizeAgentHistory([input], { ledger: { calls: 1.2, chargedOrReserved: 0, currency: 'USD' } }).recentFailures[0];
    assert.equal(record.time, null); assert.equal(record.actualCost, null); assert.equal(record.reservedCost, null); assert.equal(record.latencyMs, null); assert.equal(record.currency, null); assert.equal(record.spendGuard, null);
    assert.deepEqual(record.usage, { completion_tokens: 4 });
    assert.deepEqual(input, before);
});

test('known HTTP and proposal errors explain limitations without inventing an upstream root cause', () => {
    const record = sanitizeAgentHistory([sample(0, { error: 'AGENT_HTTP_429' })]).recentFailures[0];
    assert.equal(record.failure.upstreamHttpStatus, 429);
    assert.match(auditFailureMessage(record.failure), /无法区分/);
    assert.match(auditFailureMessage({ code: 'AGENT_HTTP_401' }), /密钥/);
    assert.match(auditFailureMessage({ code: 'AGENT_HTTP_502' }), /502/);
    assert.match(auditFailureMessage({ code: 'AGENT_PROPOSAL_NOT_JSON' }), /仅凭此错误不能确定/);
    assert.match(auditFailureMessage({ code: 'LOCAL_OPERATION_TIMEOUT' }), /可能继续完成并计费/);
    assert.match(auditFailureMessage({ code: 'UNAUTHORIZED_AUDIT_OPERATION' }), /阻止/);
});

test('billing summary distinguishes usage-derived cost, reservation and unknown; empty history does not assert free', () => {
    const history = sanitizeAgentHistory([
        sample(0, { actualCost: 0.012, usage: { prompt_tokens: 20 }, spendGuard: 'usage-priced' }),
        sample(1), sample(2, { currency: null, actualCost: null, reservedCost: null }),
    ]);
    const summary = agentHistorySummary(history);
    assert.match(summary, /按 usage 与配置价格计算：0.012 USD；不是平台账单/);
    assert.match(summary, /保留预留 0.04 USD；不代表实际扣款/);
    assert.match(summary, /不能按零计算/);
    assert.match(agentHistorySummary(sanitizeAgentHistory([])), /不证明此前请求没有计费/);
});

test('recovery caps untrusted input history and performs no fetch or generation', () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('No network allowed'); };
    try {
        const history = sanitizeAgentHistory(Array.from({ length: 205 }, (_, index) => sample(index)));
        assert.equal(history.recordsInspected, 200);
        assert.equal(history.historyTruncated, true);
        assert.equal(history.totalFailureRecords, 200);
        assert.equal(history.recentFailures.length, 10);
        assert.match(agentHistorySummary(history), /免费读取/);
    } finally { globalThis.fetch = oldFetch; }
});
