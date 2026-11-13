/** Cost guard for a whole audit. No endpoint, key or narrative text is returned. */
export function auditBudget(packet, status, settings) {
    const config = status?.config, ledger = status?.ledger;
    if (!config?.enabled) throw new Error('先在“优化 Agent · 连接与模型设置”保存接口、模型、密钥和预算。');
    const valid = n => Number.isFinite(n) && n >= 0;
    if (!Number.isSafeInteger(settings?.maxTests) || settings.maxTests < 1 || !(settings.maxCost > 0)) throw new Error('未配置 Agent 付费预算；只完成本机检查，未调用模型。');
    if (!ledger || !Number.isSafeInteger(ledger.calls) || ledger.calls < 0 || !valid(ledger.chargedOrReserved)) throw new Error('无法核实 Agent 已用预算，未调用模型。');
    if (config.budget?.currency !== settings.currency || config.prices?.currency !== settings.currency || ledger.currency !== settings.currency) throw new Error('Agent 与本机预算币种不一致，请保存 Agent 配置。');
    if (!Number.isSafeInteger(config.budget.maxCalls) || !valid(config.budget.maxCost) || !Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 64 || config.maxOutputTokens > 8192 || !valid(config.prices.input) || !valid(config.prices.output)) throw new Error('Agent 预算或价格信息不完整，未调用模型。');
    const calls = packet.requiredCalls;
    if (!Number.isSafeInteger(calls) || calls < 2 || !valid(packet.totalBytes)) throw new Error('检查分页无效，未调用模型。');
    const remainingCalls = Math.max(0, Math.min(settings.maxTests, config.budget.maxCalls) - ledger.calls);
    const remainingCost = Math.max(0, Math.min(settings.maxCost, config.budget.maxCost) - ledger.chargedOrReserved);
    // The final synthesis is bounded to 18KB by the runner. JSON string wrapping
    // can at most double these encoded bytes; 6000/call covers the fixed server
    // system prompt, model envelope and its 2048-token reservation allowance.
    const inputBound = 2 * (packet.totalBytes + 18000) + calls * 6000;
    const rate = Math.max(config.prices.input, ...Object.entries(config.prices).filter(([k,v]) => k.startsWith('cache') && valid(v)).map(([,v]) => v));
    const reserveEstimate = (inputBound * rate + calls * config.maxOutputTokens * config.prices.output) / 1e6;
    const enoughCalls = remainingCalls >= calls, enoughCost = remainingCost >= reserveEstimate;
    return { ok: enoughCalls && enoughCost, requiredCalls: calls, remainingCalls, remainingCost, reserveEstimate, currency: settings.currency,
        reason: !enoughCalls ? `本次需 ${calls} 次 Agent 调用，剩余 ${remainingCalls} 次；请自行调整并保存预算后再运行。尚未调用模型。`
            : !enoughCost ? `本次保守费用预留约 ${reserveEstimate.toFixed(4)} ${settings.currency}，剩余上限 ${remainingCost.toFixed(4)}；尚未调用模型。`
                : `预计 ${calls} 次 Agent 调用，保守费用预留约 ${reserveEstimate.toFixed(4)} ${settings.currency}；不是平台实际账单。` };
}
