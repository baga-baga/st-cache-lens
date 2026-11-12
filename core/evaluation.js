/** Compare observed play windows without promoting a replay or a fingerprint into cache evidence. */
import { normalizeUsage, calculateCost } from './usage.js';

const OBSERVED = new Set(['frontend', 'server-relay', 'agent-server', 'imported-server', 'imported-provider']);
const nonnegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const rank = r => r.observationLevel === 'server-relay' ? 3 : r.observationLevel === 'agent-server' ? 2 : 1;
function deduplicate(records) {
    const map = new Map();
    for (const [index, record] of records.entries()) {
        // Explicit correlation only. Similar content is not proof that requests are identical.
        const key = record.correlationId ?? record.requestKey ?? record.id ?? 'unkeyed-' + index;
        if (!map.has(key) || rank(record) > rank(map.get(key))) map.set(key, record);
    }
    return [...map.values()];
}
function readWindow(records, priceTable) {
    const items = deduplicate(records), currencies = new Set(), groups = new Map();
    let total = 0, unknownCosts = 0, unknownUsage = 0, invalidEvidence = 0, unknownPurpose = 0;
    let totalInput = 0, cacheRead = 0, cacheWrite = 0, ordinaryInput = 0, output = 0, maxInput = 0;
    const latencies = [], costMethods = new Set(), mainKinds = new Map();
    for (const record of items) {
        const model = record.model ?? record.body?.model ?? 'unknown';
        const provider = record.provider ?? record.interfaceType ?? 'unknown';
        const purpose = record.purpose ?? 'unknown';
        if (!['main', 'summary', 'agent'].includes(purpose)) unknownPurpose++;
        if (!OBSERVED.has(record.observationLevel) || record.synthetic || record.replay || record.predicted || record.evidence === 'offline-preview') invalidEvidence++;
        const normalized = record.normalizedUsage ?? normalizeUsage(record.usage, record.interfaceType ?? provider);
        if (!normalized.complete) unknownUsage++;
        else {
            totalInput += normalized.totalInput; cacheRead += normalized.cacheRead; cacheWrite += normalized.cacheWrite;
            ordinaryInput += normalized.ordinaryInput; output += normalized.output; maxInput = Math.max(maxInput, normalized.totalInput);
        }
        const rates = record.prices ?? priceTable[`${provider}:${model}`] ?? priceTable[model] ?? {};
        const bill = record.platformBill;
        const cost = bill && nonnegative(bill.amount) && typeof bill.currency === 'string' && bill.currency
            ? { amount: bill.amount, currency: bill.currency, complete: true, evidence: 'user-imported-platform-bill' }
            : calculateCost(normalized, rates);
        if (!cost.complete || !nonnegative(cost.amount) || !cost.currency) unknownCosts++;
        else { total += cost.amount; currencies.add(cost.currency); costMethods.add(cost.evidence); }
        if (nonnegative(record.latencyMs)) latencies.push(record.latencyMs);
        const key = JSON.stringify([purpose, provider, model, cost.currency]);
        if (!groups.has(key)) groups.set(key, { purpose, provider, model, currency: cost.currency, requests: 0, knownCost: 0, unknownCostRequests: 0 });
        const group = groups.get(key); group.requests++;
        if (cost.complete) group.knownCost += cost.amount; else group.unknownCostRequests++;
        if (purpose === 'main') {
            const kind = JSON.stringify([provider, model, record.interfaceType ?? provider]);
            mainKinds.set(kind, (mainKinds.get(kind) ?? 0) + 1);
        }
    }
    const mixedObservations = new Set(items.filter(r => r.purpose !== 'agent').map(r => r.observationLevel));
    const unresolvedMixedCapture = mixedObservations.has('frontend') && mixedObservations.has('server-relay');
    return {
        requests: items.length, mainRequests: [...mainKinds.values()].reduce((a, b) => a + b, 0), mainKinds: Object.fromEntries(mainKinds),
        totalCost: unknownCosts || currencies.size !== 1 ? null : total, knownCost: total,
        currency: currencies.size === 1 ? [...currencies][0] : null, currencies: [...currencies],
        unknownCosts, unknownUsage, unknownPurpose, invalidEvidence, unresolvedMixedCapture,
        groups: [...groups.values()], costMethods: [...costMethods],
        usage: { totalInput, cacheRead, cacheWrite, ordinaryInput, output, maxInput, completeRequestsOnly: true,
            cacheReadRatio: totalInput > 0 ? cacheRead / totalInput : null, ratioDenominator: 'cacheRead / totalInput, only complete provider usage' },
        meanLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    };
}

/**
 * baseline/candidate: actual observation records using usage.js shapes.
 * agentCosts: additional actual Agent request records attributed to the candidate (same IDs deduped).
 * quality: 'pass' | 'fail' | 'unknown' from a human checking story continuity, facts, secrets and variables.
 * Limits constrain extra paid tests; passive observation remains available without these limits.
 */
export function evaluateTrial({ baseline = [], candidate = [], agentCosts = [], priceTable = {}, quality = 'unknown',
    limits = {}, paidTestCount = 0, paidTestCost = null, minimumSavingsFraction = 0.01, completed = true } = {}) {
    if (!Array.isArray(baseline) || !Array.isArray(candidate) || !Array.isArray(agentCosts)) throw new Error('Observation windows must be arrays');
    if (!['pass', 'fail', 'unknown'].includes(quality)) throw new Error('Quality must be pass, fail or unknown');
    if (!nonnegative(minimumSavingsFraction) || minimumSavingsFraction > 1) throw new Error('Invalid minimum savings threshold');
    const before = readWindow(baseline, priceTable), after = readWindow([...candidate, ...agentCosts], priceTable);
    const reasons = [], stopReasons = [];
    if (!before.mainRequests || !after.mainRequests) reasons.push('Both windows need observed main-story requests');
    if (before.mainRequests !== after.mainRequests) reasons.push('Main-story request counts differ; compare equal-turn windows');
    if (JSON.stringify(Object.entries(before.mainKinds).sort()) !== JSON.stringify(Object.entries(after.mainKinds).sort())) reasons.push('Main model/provider/interface workload differs');
    if (before.unknownPurpose || after.unknownPurpose) reasons.push('Unclassified request purpose prevents complete main/summary/agent accounting');
    if (before.invalidEvidence || after.invalidEvidence) reasons.push('Synthetic, replay, predicted or unverified observations cannot establish real savings');
    if (before.unknownUsage || after.unknownUsage) reasons.push('Some provider usage is missing or incomplete');
    if (before.totalCost === null || after.totalCost === null) reasons.push('Some costs or a single comparison currency are unavailable');
    if (before.currency !== after.currency) reasons.push('Currencies differ; no implicit exchange-rate conversion');
    if (before.unresolvedMixedCapture || after.unresolvedMixedCapture) reasons.push('Mixed frontend/server captures need explicit correlation to avoid double-counting');
    if (!completed) reasons.push('Observation window is not complete');
    if (quality === 'unknown') reasons.push('Human story-quality review is pending');
    if (quality === 'fail') stopReasons.push('Story quality or protected facts regressed');

    const budgetConfigured = Number.isSafeInteger(limits.maxPaidTestCalls) && limits.maxPaidTestCalls > 0
        && nonnegative(limits.maxPaidTestCost) && limits.maxPaidTestCost > 0 && typeof limits.currency === 'string' && !!limits.currency;
    if (!budgetConfigured) stopReasons.push('Extra paid testing is disabled until both call and cost budgets are configured');
    if (budgetConfigured && (!Number.isSafeInteger(paidTestCount) || paidTestCount < 0 || paidTestCount >= limits.maxPaidTestCalls)) stopReasons.push('Paid test call budget is exhausted or unknown');
    if (budgetConfigured && (!paidTestCost || !nonnegative(paidTestCost.amount) || paidTestCost.currency !== limits.currency)) stopReasons.push('Paid test spend is unknown or in a different currency');
    else if (budgetConfigured && paidTestCost.amount >= limits.maxPaidTestCost) stopReasons.push('Paid test cost budget is exhausted');
    if (Number.isSafeInteger(limits.maxInputTokens) && limits.maxInputTokens > 0 && after.usage.maxInput > limits.maxInputTokens) stopReasons.push('Observed input exceeds the user limit');

    const costsComparable = reasons.filter(r => r !== 'Human story-quality review is pending').length === 0;
    const delta = costsComparable ? before.totalCost - after.totalCost : null;
    const savingsFraction = costsComparable && before.totalCost > 0 ? delta / before.totalCost : null;
    let decision = 'inconclusive';
    if (quality === 'fail') decision = 'rollback';
    else if (costsComparable && delta < 0) { decision = 'rollback'; stopReasons.push('Observed total cost regressed'); }
    else if (costsComparable && (savingsFraction === null || savingsFraction < minimumSavingsFraction)) {
        decision = 'no-improvement'; stopReasons.push('No continued cost improvement in the observed window');
    } else if (costsComparable && quality === 'pass') decision = 'keep';
    else if (costsComparable && quality === 'unknown') decision = 'await-quality-review';
    if (!completed) decision = quality === 'fail' ? 'rollback' : 'observe';
    return {
        decision, baseline: before, candidate: after, reasons, stopReasons,
        shouldStopPaidTests: stopReasons.length > 0, mayContinuePaidTests: stopReasons.length === 0,
        savings: { amount: delta, fraction: savingsFraction, currency: costsComparable ? before.currency : null,
            includesMainSummaryAgent: true, evidence: 'observed-windows-with-configured-rates-or-imported-bills' },
        quality, prediction: false, causalClaim: false,
        limitation: 'Observed windows are not a controlled causal experiment. Different story content, response length, TTL gaps and upstream routing can explain differences. A local prefix match is never cache-read evidence.',
    };
}
