/** Read-only summaries of already-recorded Agent failures. No network or generation. */
import { safeAuditFailure } from './agent-audit.js';
import { numericUsage } from './reporting.js';
import { networkDiagnosticText, isTransportFailureCode } from '../core/network-diagnostics.js';

const MAX_HISTORY = 200;
const MAX_FAILURES = 10;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const guards = new Set(['usage-priced', 'reservation-retained-usage-unknown']);
function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}
function boundedUsage(value) {
    const clean = numericUsage(value);
    if (!clean) return null;
    const walk = source => Object.fromEntries(Object.entries(source).flatMap(([key, item]) => {
        if (typeof item === 'number') return amount(item) === null ? [] : [[key, item]];
        const nested = walk(item);
        return Object.keys(nested).length ? [[key, nested]] : [];
    }));
    const result = walk(clean);
    return Object.keys(result).length ? result : null;
}

/** History is evidence from the service, not a match to any particular audit file. */
export function sanitizeAgentHistory(records, status) {
    const input = Array.isArray(records) ? records : [];
    const inspected = input.slice(-MAX_HISTORY);
    const failures = inspected.filter(record => object(record) && record.status === 'failed');
    const ledger = status?.ledger;
    const validLedger = object(ledger) && integer(ledger.calls) !== null && amount(ledger.chargedOrReserved) !== null && currency(ledger.currency) !== null;
    return {
        scope: 'recent-agent-server-records',
        correlatedToAudit: false,
        serverBusy: bool(status?.busy),
        ledger: validLedger ? { calls: ledger.calls, chargedOrReserved: ledger.chargedOrReserved, currency: ledger.currency } : null,
        recordsInspected: inspected.length,
        historyTruncated: input.length > inspected.length,
        totalFailureRecords: failures.length,
        recentFailures: failures.slice(-MAX_FAILURES).reverse().map(record => {
            const result = {
                time: timestamp(record.time), status: 'failed',
                failure: safeAuditFailure({ code: record.error, network: record.network }, { stage: 'server-record' }),
                usage: boundedUsage(record.usage),
                actualCost: amount(record.actualCost), reservedCost: amount(record.reservedCost),
                currency: currency(record.currency),
                spendGuard: guards.has(record.spendGuard) ? record.spendGuard : null,
                latencyMs: integer(record.latencyMs),
            };
            if (typeof record.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id)) result.id = record.id;
            return result;
        }),
        note: 'Recent history is not automatically linked to this audit; no model request was made.',
    };
}

/** Fixed messages only. Do not render upstream prose, local exception text or keys. */
export function auditFailureMessage(failure) {
    const safe = safeAuditFailure({ code: failure?.code, httpStatus: failure?.httpStatus, network: failure?.network }, { stage: failure?.stage });
    const code = safe.code;
    if (safe.network && isTransportFailureCode(code)) return networkDiagnosticText(safe.network);
    const messages = {
        AGENT_HTTP_400: '服务商返回 400，未接受生成请求；具体原因未包含在这份记录中。连接检查通过不代表生成请求可用。',
        AGENT_HTTP_401: '生成接口拒绝密钥（401）。请核对已保存的接口和密钥；这不是缓存或世界书问题。',
        AGENT_HTTP_403: '生成接口拒绝访问（403）。需核对当前账号、模型与生成权限；不能仅凭此记录确定具体限制。',
        AGENT_HTTP_404: '生成接口或模型未找到（404）。请核对已保存的完整接口地址与模型 ID。',
        AGENT_HTTP_429: '生成请求被限制（429）；可能是速率或可用额度限制，单凭状态码无法区分。先核对服务商记录。',
        AGENT_PROPOSAL_NOT_JSON: '服务端未取得可解析的 JSON；可能涉及输出截断或返回格式，仅凭此错误不能确定。先保留记录，不要重复付费重试。',
        AGENT_PROPOSAL_INVALID_SCHEMA: '模型返回的 JSON 不符合方案结构，已阻止应用；需要检查返回格式适配。',
        INVALID_AGENT_RESPONSE: '服务商响应不是可解析的接口 JSON，未形成方案；具体原因尚未确认。',
        INVALID_AUDIT_RESPONSE: '模型返回不符合本次检查要求，已停止且未应用。',
        UNAUTHORIZED_AUDIT_OPERATION: '模型提出越权修改，已阻止应用；不会执行文件或角色卡中的命令。',
        AGENT_BUDGET_EXHAUSTED: '本插件累计调用次数或费用预留已达到上限，后续生成被阻止；不是服务商余额结论。',
        AGENT_NOT_ENABLED: '尚未保存并启用 Agent 配置与预算，未开始生成。',
        AGENT_BUSY: '服务端已有 Agent 请求进行中，未并发发起新的生成。',
        DIAGNOSTICS_TOO_LARGE: '本次诊断数据超出服务端传输上限，未继续生成。',
        PAYLOAD_TOO_LARGE: '请求超过酒馆服务端接收上限，需要调整诊断分页。',
        RESPONSE_TOO_LARGE: '接口响应超过本插件读取上限，已停止读取；此前请求仍可能计费。',
        LOCAL_OPERATION_TIMEOUT: '前端等待超时，后续调用已停止；服务端此前的请求仍可能继续完成并计费。',
        UPSTREAM_TIMEOUT: '服务端等待上游响应超时；不能据此判断上游是否已经计费。',
        UPSTREAM_ABORTED: '服务端上游请求已停止；已发送的请求仍可能计费，未自动重试。',
        PROXY_TIMEOUT: '本机代理连接或响应超时；未自动重试。',
        LOCAL_OPERATION_ABORTED: '本次前端等待已停止；已经发出的请求仍可能计费。',
        PROXY_ABORTED: '本机代理请求已停止；是否计费需看服务端记录。',
        CLIENT_NETWORK_ERROR: '浏览器与酒馆服务端之间的请求失败；不能据此断定上游是否收到请求。',
        SERVER_RESPONSE_INVALID_JSON: '酒馆服务端返回内容无法解析；未形成可应用方案。',
        UPSTREAM_CONNECTION_FAILED: '酒馆服务端连接上游失败；此记录没有保留具体网络原因。',
        UPSTREAM_DNS_FAILED: '酒馆服务端未能解析 API 域名，尚不能据此确认代理或 DNS 的具体原因。',
        PRIVATE_ENDPOINT_FORBIDDEN: '插件拦截了 API 的非公网目标地址；不是检查你的公网出口 IP。请核对服务端版本和目标解析范围。',
        UPSTREAM_REDIRECT_FORBIDDEN: '上游要求重定向，插件未携带密钥跟随新地址。请核对完整接口地址。',
        PROXY_CONNECTION_FAILED: '无法连接已配置的本机代理；若沿用设备现有网络，请检查是否仍保存了手动代理选项。',
        PROXY_TLS_FAILED: '通过本机代理建立的 HTTPS 连接未通过证书或域名验证，未跳过验证。',
        PROXY_AUTH_REQUIRED: '本机代理要求认证，当前代理入口不支持此配置。',
        PROXY_CONNECT_REJECTED: '已配置的本机代理拒绝了连接；尚不能确认具体代理规则。',
        PROXY_URL_INVALID: '保存或检查的本机代理地址格式无效。',
        PROXY_LOOPBACK_REQUIRED: '手动代理只接受明确的本机回环地址。',
        PROXY_OPENAI_ONLY: '手动代理选项仅支持官方 OpenAI HTTPS 地址。',
        AGENT_INTERNAL_ERROR: '服务端处理 Agent 响应时发生内部错误；原始异常未导出。',
        AUDIT_SYNTHESIS_TOO_LARGE: '检查汇总超过传输上限，已停止后续生成。',
    };
    if (messages[code]) return messages[code];
    if (/^AGENT_HTTP_5\d{2}$/.test(code)) return `服务商返回 ${safe.upstreamHttpStatus} 错误，已停止后续调用；是否计费需看服务商记录。`;
    if (/^AGENT_HTTP_4\d{2}$/.test(code)) return `服务商拒绝生成请求（${safe.upstreamHttpStatus}），具体原因未包含在这份记录中。`;
    return code === 'AUDIT_UNKNOWN_ERROR'
        ? '未取得可安全导出的具体错误；不能据此判断是余额、网络还是模型返回格式问题。'
        : `本次操作被阻止（${code}）；尚未取得更具体原因，不会自动重试。`;
}

export function agentHistorySummary(history) {
    const failures = Array.isArray(history?.recentFailures) ? history.recentFailures.slice(0, MAX_FAILURES) : [];
    const lines = ['免费读取了已有 Agent 服务端记录，未新增模型调用。历史记录未自动关联到某一份检查报告。'];
    if (history?.serverBusy === true) lines.push('服务端仍有 Agent 请求进行中；先等待已有请求，不要重复发起检查。');
    if (!failures.length) lines.push('最近记录中没有已完成的失败记录；记录可能尚未写入或已被清理，这不证明此前请求没有计费。');
    for (const [index, record] of failures.entries()) {
        const time = timestamp(record?.time);
        const failure = safeAuditFailure({ code: record?.failure?.code, network: record?.failure?.network }, { stage: 'server-record' });
        lines.push(`${index + 1}. ${time || '时间未知'} · ${failure.code}\n${auditFailureMessage(failure)}`);
        const cost = amount(record?.actualCost), reserved = amount(record?.reservedCost), unit = currency(record?.currency);
        if (cost !== null && unit) lines.push(`按 usage 与配置价格计算：${cost} ${unit}；不是平台账单。`);
        else if (reserved !== null && unit) lines.push(`费用未知，插件保留预留 ${reserved} ${unit}；不代表实际扣款。`);
        else lines.push('费用证据不足，不能按零计算。');
    }
    return lines.join('\n\n');
}
