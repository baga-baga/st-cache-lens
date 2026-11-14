/** Shared allowlist at server, browser and export boundaries. Never retain raw errors. */
export const NETWORK_REASONS = Object.freeze([
    'UNKNOWN', 'TIMEOUT', 'ABORTED', 'ALL_ADDRESSES_FAILED', 'EPROTO', 'ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
    'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN',
    'EADDRNOTAVAIL', 'EAI_AGAIN', 'ENOTFOUND', 'EAI_FAIL', 'EAI_NODATA',
    'ECONNABORTED', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_PREMATURE_CLOSE',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_REVOKED', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
    'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
    'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'ERR_SSL_UNEXPECTED_EOF_WHILE_READING',
]);
const reasons = new Set(NETWORK_REASONS);
const phases = new Set(['dns', 'connect', 'proxy-connect', 'tls', 'send', 'wait-headers', 'body']);
const routes = new Set(['direct', 'local-proxy']);
const transportCodes = new Set(['UPSTREAM_CONNECTION_FAILED', 'UPSTREAM_DNS_FAILED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ABORTED', 'PROXY_CONNECTION_FAILED', 'PROXY_TLS_FAILED', 'PROXY_TIMEOUT', 'PROXY_ABORTED', 'AGENT_CHECK_TIMEOUT', 'AGENT_CHECK_FAILED']);
export const isTransportFailureCode = code => transportCodes.has(code);

export function sanitizeNetworkDiagnostic(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
    const clean = {
        version: 1,
        reason: reasons.has(value.reason) ? value.reason : 'UNKNOWN',
        phase: phases.has(value.phase) ? value.phase : 'unknown',
        route: routes.has(value.route) ? value.route : 'unknown',
        requestMayHaveBeenSent: typeof value.requestMayHaveBeenSent === 'boolean' ? value.requestMayHaveBeenSent : null,
        responseHeadersReceived: typeof value.responseHeadersReceived === 'boolean' ? value.responseHeadersReceived : null,
    };
    if (Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 86400000) clean.elapsedMs = value.elapsedMs;
    return clean;
}

/** Explain observed transport facts without guessing a proxy rule or billing outcome. */
export function networkDiagnosticText(value) {
    const n = sanitizeNetworkDiagnostic(value);
    if (!n) return '';
    const labels = { dns: '解析域名', connect: '建立 TCP 连接', 'proxy-connect': '连接本机代理', tls: '建立加密连接', send: '发送请求', 'wait-headers': '等待 API 响应', body: '读取 API 响应', unknown: '阶段未知' };
    const route = n.route === 'direct' ? '设备现有网络' : n.route === 'local-proxy' ? '手动本机代理' : '网络路径未知';
    const detail = {
        ECONNRESET: '连接被中断；不能仅凭此错误确定是网络链路还是上游关闭连接。',
        ECONNREFUSED: '目标连接被拒绝。',
        ENETUNREACH: '当前运行酒馆的环境没有到目标地址的可用网络路径。',
        EHOSTUNREACH: '目标地址不可达。', EADDRNOTAVAIL: '当前环境无法使用所选网络地址。',
        EPIPE: '连接关闭后继续发送时失败。',
        EAI_AGAIN: '域名解析暂时失败。', ENOTFOUND: '域名未能解析。',
        TIMEOUT: '网络等待超时。', ETIMEDOUT: '网络连接超时。', ABORTED: '网络请求已停止。',
        ERR_STREAM_PREMATURE_CLOSE: 'API 响应尚未读完，连接就关闭了。',
        ERR_TLS_CERT_ALTNAME_INVALID: 'HTTPS 证书与 API 域名不匹配。',
        CERT_HAS_EXPIRED: 'HTTPS 证书已过期；也需检查设备时间。',
        CERT_NOT_YET_VALID: 'HTTPS 证书尚未生效；也需检查设备时间。',
    };
    const tlsReason = /CERT|SELF_SIGNED|ISSUER|SIGNATURE/.test(n.reason);
    const explanation = detail[n.reason] || (tlsReason ? 'HTTPS 证书未通过验证。' : n.reason.startsWith('ERR_SSL_') ? 'HTTPS 握手或加密连接失败。' : '具体网络原因尚未确认。');
    return `${route} · ${labels[n.phase]} · ${n.reason}${n.elapsedMs === undefined ? '' : ` · ${n.elapsedMs} ms`}\n${explanation}未自动重试；是否计费以 usage 和平台记录为准。`;
}
