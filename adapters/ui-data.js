/** Pure UI evidence adapters; no I/O and no inferred service-side observations. */
import { diagnoseWorldInfo } from '../core/diagnostics.js';
import { normalizeUsage } from '../core/usage.js';

export function hasObservedContext(record) {
    const body = record?.body;
    return Boolean(body && typeof body === 'object' && ['messages', 'system', 'tools', 'input', 'instructions', 'prompt'].some(key => Object.hasOwn(body, key)));
}

export function normalizeUISources(sources) {
    return (Array.isArray(sources) ? sources : []).filter(source => source && typeof source === 'object').map(source => ({ ...source, type: source.type || source.kind || 'unknown', label: source.label || source.name || source.id || '', text: source.text ?? source.content }));
}

export function worldSummary(record, { book = null, maxInputTokens = null } = {}) {
    const snapshot = record?.world || {};
    const knownLoaded = snapshot.loadedEntriesKnown === true || (snapshot.loadedEntries || []).length > 0;
    const loaded = knownLoaded ? snapshot.loadedEntries : undefined;
    const confirmedActivation = snapshot.activationEventSeen === true || (snapshot.activeEntries || []).length > 0;
    let activeEntries = confirmedActivation ? snapshot.activeEntries : undefined;
    if (book && activeEntries) activeEntries = activeEntries.filter(entry => entry.world === book.name);
    const usage = normalizeUsage(record?.usage, record?.interfaceType || record?.provider);
    const sentTokens = Number.isFinite(usage.totalInput) ? { value: usage.totalInput, kind: 'provider-usage', method: '服务商 usage 返回的整个请求输入，包含世界书以外的内容；不是所选世界书的发送量。' } : null;
    const result = diagnoseWorldInfo({ entries: book?.entries ?? loaded, activeEntries, budgetTokens: snapshot.budgetTokens ?? book?.budgetTokens ?? null, sentTokens, maxInputTokens });
    return {
        ...result,
        globalSettings: book?.globalSettings ?? null,
        wholeBookScope: book ? { name: book.name, source: 'explicit-read-only-book-read' } : { names: [...new Set((loaded || []).map(entry => entry.world).filter(Boolean))], source: knownLoaded ? 'books-loaded-for-scan; may-contain-dry-run' : 'not-observed' },
        activatedScope: book ? `所选世界书：${book.name}` : '最近可关联的激活事件中的条目；以最终请求精确匹配进一步核实',
        finalSentScope: '整个请求的输入总量；世界书单独的最终发送 token 数仍未知',
        worldInfoFinalSentTokens: null,
        evidence: { activation: confirmedActivation ? snapshot.activationEvidence || 'activation-event' : '未取得可确认的激活事件；不能把未知记为 0', scan: snapshot.scan || null, requestHasContext: hasObservedContext(record) },
    };
}
