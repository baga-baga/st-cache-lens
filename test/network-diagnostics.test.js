import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeNetworkDiagnostic, networkDiagnosticText } from '../core/network-diagnostics.js';
import { safeAuditFailure } from '../adapters/agent-audit.js';
import { sanitizeAgentHistory, agentHistorySummary, auditFailureMessage } from '../adapters/audit-recovery.js';

const network = { version: 1, reason: 'ECONNRESET', phase: 'wait-headers', route: 'direct', requestMayHaveBeenSent: true, responseHeadersReceived: false, elapsedMs: 1234 };

test('network metadata excludes raw errors, IPs, request data and invalid values on every export boundary', () => {
    const secret = 'sk-synthetic-private-value';
    const input = { ...network, message: secret, address: '192.0.2.1', endpoint: 'https://private.invalid', stack: secret, headers: { authorization: secret } };
    assert.deepEqual(sanitizeNetworkDiagnostic(input), network);
    const failure = safeAuditFailure({ code: 'UPSTREAM_CONNECTION_FAILED', network: input }, { stage: 'page-call' });
    assert.deepEqual(failure.network, network);
    assert.doesNotMatch(JSON.stringify(failure), /sk-synthetic|192\.0\.2|private\.invalid|authorization|stack/);
    assert.deepEqual(sanitizeNetworkDiagnostic({ version: 1, reason: secret, phase: secret, route: secret, requestMayHaveBeenSent: secret, responseHeadersReceived: 1, elapsedMs: Infinity }), {
        version: 1, reason: 'UNKNOWN', phase: 'unknown', route: 'unknown', requestMayHaveBeenSent: null, responseHeadersReceived: null,
    });
    assert.equal(sanitizeNetworkDiagnostic({ ...network, version: 2 }), null);
    assert.equal(sanitizeNetworkDiagnostic(null), null);
    assert.equal(sanitizeNetworkDiagnostic({ ...network, elapsedMs: -1 }).elapsedMs, undefined);
});

test('network failure stays distinct from audit stage and never proves zero billing or a particular proxy failure', () => {
    const failure = safeAuditFailure({ code: 'UPSTREAM_CONNECTION_FAILED', network }, { stage: 'page-call', pageIndex: 0 });
    assert.equal(failure.stage, 'page-call');
    assert.equal(failure.network.phase, 'wait-headers');
    assert.equal(failure.retryAttempted, false);
    const text = auditFailureMessage(failure);
    assert.match(text, /ECONNRESET/);
    assert.match(text, /等待 API 响应/);
    assert.match(text, /不能仅凭此错误确定/);
    assert.match(text, /是否计费以 usage 和平台记录为准/);
    assert.doesNotMatch(text, /没有计费|未扣费|Clash 导致/);
    assert.match(networkDiagnosticText({ ...network, reason: 'ERR_TLS_CERT_ALTNAME_INVALID', phase: 'tls' }), /证书与 API 域名不匹配/);
    assert.match(auditFailureMessage({ code: 'PROXY_AUTH_REQUIRED', network }), /本机代理要求认证/);
    assert.match(auditFailureMessage({ code: 'UPSTREAM_REDIRECT_FORBIDDEN', network }), /重定向/);
    assert.match(auditFailureMessage({ code: 'PRIVATE_ENDPOINT_FORBIDDEN', network }), /非公网/);
});

test('free history preserves new network evidence while old records remain explicitly unknown', () => {
    const history = sanitizeAgentHistory([
        { status: 'failed', error: 'UPSTREAM_CONNECTION_FAILED' },
        { status: 'failed', error: 'UPSTREAM_CONNECTION_FAILED', network: { ...network, message: 'synthetic-private-error' } },
    ]);
    assert.deepEqual(history.recentFailures[0].failure.network, network);
    assert.equal(history.recentFailures[1].failure.network, undefined);
    const text = agentHistorySummary(history);
    assert.match(text, /ECONNRESET/);
    assert.match(text, /此记录没有保留具体网络原因/);
    assert.doesNotMatch(text, /synthetic-private-error/);
    assert.equal(history.correlatedToAudit, false);
});
