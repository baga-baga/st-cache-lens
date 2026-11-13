/**
 * Deterministic, request-local world-info batching. Native lorebook fields are never
 * written: selection/activation/budgeting has already happened in SillyTavern.
 * Structural checks do not establish semantic independence; one explicit bounded
 * batch authorization is still required, followed by actual story-quality review.
 */
import { createProfile, hasBalancedTags, previewProposal, profileFingerprint, stableStringify } from '../core/optimizer.js';
import { textSlots } from './pipeline.js';
import { hasUnsupportedContent } from '../core/providers.js';

const WORLD_KINDS = new Set(['world-info', 'world_info', 'worldbook']);
const ROLES = new Set(['system', 'user', 'assistant']);
const BYTE_TOKENIZER_INTERFACES = new Set(['anthropic', 'openai', 'openai-chat', 'openai-responses', 'deepseek']);
// Literal pseudo-XML labels used by lorebooks; punctuation is never normalized.
// Angle brackets, slashes, quotes, whitespace, '=', braces and executable syntax remain excluded.
const TAG_NAME = String.raw`[\p{L}_][\p{L}\p{N}\p{M}_:.·、，：()\[\]（）【】［］-]*`;
const TAG_START = /^<\/?[\p{L}_]/u;
const TAG_TOKEN = new RegExp('^<(\\/)?(' + TAG_NAME + ')(?:\\s+[^<>]*?)?\\s*(\\/)?\\s*>$', 'u');
const TAG_CLOSE = new RegExp('^<\\/' + TAG_NAME + '\\s*>$', 'u');
const DYNAMIC_STATE_CLOCK_DICE = /status_current_variables|current_variables|记忆系统私密简报|状态快照|变量快照|当前(?:变量|状态|时间|日期)|实时状态|骰(?:池|子|点)|(?:掷|投)骰|大前天|前天|昨天|今日|今天|明天|后天|此刻|\d+\s*(?:天|日|周|星期|个月|小时|分钟)(?:前|后)|上周[一二三四五六日天]|(?:last|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|\b(?:today|yesterday|tomorrow|dice)\b|\bcurrent\s+(?:time|date|state|status|variables)\b|\d+\s+(?:days?|weeks?|hours?|minutes?)\s+ago|<\/?(?:status|current_state|variables|snapshot)\b/i;
const FORBIDDEN_MACRO = /\{\{|\}\}|<%|%>|\$\{/;
const DEPENDENT_REFERENCE = /上一(?:条|项|段)|下一(?:条|项|段)|前一(?:条|项|段)|后一(?:条|项|段)|上述(?:规则|条目|指令)|下述(?:规则|条目|指令)|以上(?:规则|条目|指令)|以下(?:规则|条目|指令)|(?:previous|next|preceding|following)\s+(?:entry|section|instruction|rule)|(?:above|below)\s+(?:rules|instructions|entries)/i;
const EXCLUSION_MESSAGES = {
    'not-explicit-world-info':'不是明确的世界书来源，保持只读。',
    'missing-trusted-activation-provenance':'缺少本轮激活事件及完整条目来源。',
    'third-party-adapter-diagnostic-only':'第三方适配器来源仅供只读诊断，即使声称来自官方激活事件也不能自动改写其请求片段。',
    'native-source-identity-mismatch':'来源标识与原生世界书名称、条目 UID 不一致，不能确认官方来源。',
    'unsupported-source-access':'来源权限标记异常，保持只读诊断。',
    'source-text-does-not-exactly-match-entry-content':'来源文本与条目正文不完全相同。',
    'entry-marked-disabled':'条目标记为禁用，不能自动调整。',
    'macro-or-template-boundary':'含宏或模板边界，需要明确适配。',
    'code-or-executable-scope-not-eligible':'包含代码或工具调用作用域，排除自动排序。',
    'unbalanced-entry-tags':'条目标签未独立闭合。',
    'explicit-neighbour-dependency':'存在依赖相邻条目顺序的明确表述。',
    'unknown-trigger-class':'无法从明确设置识别常驻或按需触发类型。',
    'dynamic-state-clock-or-dice':'含状态快照、相对时间或骰池信息；常驻设置不代表内容稳定，排除自动排序。',
    'not-uniquely-located-in-request':'无法在实际请求中唯一定位。',
    'tool-or-unknown-message-role':'不允许调整工具消息或未知消息角色。',
    'message-with-code-fence-needs-manual-review':'所在消息含代码围栏，保留原顺序。',
    'message-has-unresolved-template-boundary':'所在消息含未解析模板边界，不能确认宏作用范围。',
    'duplicate-source-identity':'来源标识重复，不能确定对应关系。',
    'overlapping-or-ambiguous-source':'来源区间重叠或归属不唯一。',
    'entry-crosses-outer-tag-scope':'条目跨越外层标签作用域。',
    'additional-disjoint-run-in-same-message':'同一消息的另一段不相邻范围，本轮不跨区重排。',
    'bounded-candidate-cap':'达到本轮候选条目或范围数量上限。',
};
const utf8 = value => new TextEncoder().encode(value).length;
const copy = value => JSON.parse(JSON.stringify(value));
const label = value => String(value ?? '').slice(0, 256);

/**
 * Track exact outer tag identities (including opening offsets), not just tag names.
 * Unknown/malformed markup and code-fence interiors fail closed. A textual `< 3`
 * comparison is not treated as a tag. No markup is interpreted or executed.
 */
function tagBoundaryMetadata(text, start, end = text.length) {
    // Tag-name prefix only: stop before attributes; retain code points of symbols, not names.
    const prefix = text.slice(start + 1, end).replace(/^\//, '').split(/\s/u, 1)[0].replace(/\/$/, '');
    const symbols = [...prefix].filter(char => !/[\p{L}\p{N}\p{M}_]/u.test(char));
    return { offset: start, symbolCodePoints: [...new Set(symbols.slice(0, 16).map(char => 'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')))] };
}

function markupAtBoundaries(text, boundaries) {
    const points = [...new Set(boundaries)].sort((a, b) => a - b), result = new Map(), stack = [];
    let point = 0, cursor = 0;
    const recordThrough = end => {
        while (point < points.length && points[point] <= end) { result.set(points[point], JSON.stringify(stack)); point++; }
    };
    while (cursor < text.length) {
        const start = text.indexOf('<', cursor);
        if (start < 0) break;
        recordThrough(start);
        if (text.startsWith('<!--', start)) {
            const end = text.indexOf('-->', start + 4);
            if (end < 0) return { ok: false, reason: 'unclosed-comment' };
            if (points.some(p => p > start && p < end + 3)) return { ok: false, reason: 'source-boundary-inside-comment' };
            cursor = end + 3; continue;
        }
        if (/^<[!?]/.test(text.slice(start))) return { ok: false, reason: 'unsupported-markup' };
        if (!TAG_START.test(text.slice(start))) {
            if (/^<\/?[^\s\d=<>]/u.test(text.slice(start))) return { ok: false, reason: 'unsupported-tag-name', boundaryFailure: tagBoundaryMetadata(text, start, text.indexOf('>', start) < 0 ? text.length : text.indexOf('>', start)) };
            cursor = start + 1; continue;
        }
        let end = start + 1, quote = null;
        for (; end < text.length; end++) {
            const char = text[end];
            if (quote) { if (char === quote) quote = null; }
            else if (char === '"' || char === "'") quote = char;
            else if (char === '>') break;
        }
        if (end >= text.length || quote) return { ok: false, reason: 'incomplete-tag' };
        if (points.some(p => p > start && p < end + 1)) return { ok: false, reason: 'source-boundary-inside-tag' };
        const tag = text.slice(start, end + 1);
        const match = TAG_TOKEN.exec(tag);
        if (!match) return { ok: false, reason: 'unsupported-tag-syntax', boundaryFailure: tagBoundaryMetadata(text, start, end) };
        if (match[1]) {
            if (match[3] || !TAG_CLOSE.test(tag) || stack.pop()?.name !== match[2]) return { ok: false, reason: 'mismatched-tag' };
        } else if (!match[3]) stack.push({ name: match[2], offset: start });
        cursor = end + 1;
    }
    recordThrough(text.length);
    if (stack.length) return { ok: false, reason: 'unclosed-outer-tag' };
    return { ok: true, contexts: result };
}

function fieldScope(entry) {
    // SillyTavern 1.19.0 world-info.js: fixed-position before/after/AN/EM
    // branches inject content without reading depth, role or outletName.
    // Imported entries may retain those inactive editor fields (including an
    // absent role versus 0); they cannot split an otherwise identical actual
    // message scope. Actual message role, path and outer tags remain checked by
    // slotSignature. At-depth, outlet and unknown positions stay conservative.
    if ([0, 1, 2, 3, 5, 6].includes(entry.position)) return stableStringify({ position: entry.position });
    return stableStringify({ position: entry.position ?? null, depth: entry.depth ?? null, role: entry.role ?? null, outletName: entry.outletName ?? null });
}
function slotSignature(item) { return `${item.scope}\0${item.role}\0${item.outerScope}\0${fieldScope(item.entry)}`; }
function stableFirst(entries) { return [...entries.filter(e => e.stable), ...entries.filter(e => !e.stable)]; }
function changesOrder(entries) { return stableFirst(entries).some((e, i) => e.id !== entries[i].id); }
function limitsValid(limits) {
    return Number.isSafeInteger(limits?.maxInputTokens) && limits.maxInputTokens > 0
        && Number.isSafeInteger(limits.contextTokens) && limits.contextTokens > 0
        && Number.isSafeInteger(limits.outputReserveTokens ?? 0) && (limits.outputReserveTokens ?? 0) >= 0
        && limits.contextTokens > (limits.outputReserveTokens ?? 0);
}

/**
 * setup.batchAuthorized is trusted UI policy, never a field taken from Agent output.
 * It authorizes this bounded range once; it does not assert machine-proven semantics.
 * inputEvidence may report an estimated counter for display, but is NEVER promoted
 * into exactInputTokens or used to bypass the conservative bound in this version.
 *
 * Returns a profile/proposal/previewContext suitable for previewProposal +
 * applyProposal + transformWithProfile. previewBody is an OFFLINE dry run only.
 */
export function buildBatchPlan({ record, setup = {}, limits, inputEvidence = null } = {}) {
    const exclusions = [], reasons = [], notes = [
        '只处理本轮已经激活并能精确定位的世界书内容；不修改触发集合或原书排序字段。',
        '保留完整条目字节、消息角色、空白分隔、外层标签范围，以及同类条目的相对顺序。',
        '结构检查不能证明语义独立或费用节省；需要一次批次范围授权，并观察后续剧情质量。',
    ];
    const counts = { totalSources: Array.isArray(record?.sources) ? record.sources.length : 0, explicitWorldInfoSources: 0, eligibleEntries: 0, eligibleGroups: 0, selectedEntries: 0, selectedGroups: 0, stableEntries: 0, dynamicEntries: 0 };
    const result = { status: 'blocked', canApply: false, requiresBatchApproval: setup.batchAuthorized !== true, profile: null, proposal: null, previewContext: null, preview: null, previewBody: null, groups: [], input: null, counts, exclusions, reasons, notes, evidence: 'offline-request-local-batch-plan' };
    if (setup.complete !== true || setup.optimizationBlocked === true) { reasons.push('当前连接检查未完成或被明确标记为禁止优化；仅保留诊断。'); return result; }
    if (record?.imported || record?.synthetic || record?.replay || record?.predicted || record?.evidence === 'offline-preview') { reasons.push('导入、模拟、回放或预测数据不能直接授权修改实际请求。'); return result; }
    if (!record || record.observationLevel !== 'frontend' || record.purpose !== 'main' || !record.body || typeof record.body !== 'object') {
        reasons.push('需要已经明确归类为正文的前端实际请求及完整组装内容。'); return result;
    }
    const activationSnapshot = record.snapshot ?? record.world;
    if (activationSnapshot && activationSnapshot.activationEventSeen === false) { reasons.push('当前快照明确没有本轮世界书激活事件，不能使用来源字符串代替实际激活证据。'); return result; }
    if (!record.chatId || !record.model || !record.provider || [record.model, record.provider].includes('unknown')) {
        reasons.push('需要明确当前聊天、模型及接口来源，才能建立自动调整范围。'); return result;
    }
    if (setup.binding && ['chatId', 'model', 'provider', 'purpose', 'characterId', 'groupId'].some(key => setup.binding[key] !== undefined && String(setup.binding[key]) !== String(record[key]))) { reasons.push('当前请求与已授权的聊天、角色、模型或用途范围不一致。'); return result; }
    if (!limitsValid(limits)) { reasons.push('请先设置有效的输入上限、上下文上限和输出预留。'); return result; }
    if (!BYTE_TOKENIZER_INTERFACES.has(record.interfaceType)) { reasons.push('当前接口尚不支持此文本输入保护，不能自动应用。'); return result; }
    if (hasUnsupportedContent(record.body)) { reasons.push('请求含多模态或不支持的内容，无法使用文本输入保护。'); return result; }
    let slots;
    try { slots = textSlots(record.body); } catch { reasons.push('当前请求的消息结构不受支持。'); return result; }
    const sources = Array.isArray(record.sources) ? record.sources : [];
    const accepted = [], sourceIds = new Map();
    const exclude = (source, reason, boundaryFailure = null) => exclusions.push({ sourceId: label(source?.id), reason, message: EXCLUSION_MESSAGES[reason] ?? (reason.startsWith('unsafe-outer-markup:') ? '外层标签或注释结构不明确，不能安全调整。' : '此来源未通过自动范围检查。'), ...(boundaryFailure ? { boundaryFailure } : {}) });
    for (const [index, source] of sources.entries()) {
        const kind = source?.kind ?? source?.type;
        if (!WORLD_KINDS.has(kind)) { exclude(source, 'not-explicit-world-info'); continue; }
        counts.explicitWorldInfoSources++;
        // Registry wrappers force adapter markers. A third-party callback cannot become
        // native merely by copying WORLD_INFO_ACTIVATED into its returned metadata.
        if (Object.hasOwn(source, 'adapter') || Object.hasOwn(source, 'adapterVersion')) { exclude(source, 'third-party-adapter-diagnostic-only'); continue; }
        // Native collection itself is read-only: original entry settings are never written.
        if (source.access !== undefined && source.access !== 'read-only') { exclude(source, 'unsupported-source-access'); continue; }
        if (source.provenance !== 'WORLD_INFO_ACTIVATED' || !source.entry || typeof source.entry !== 'object' || Array.isArray(source.entry)) { exclude(source, 'missing-trusted-activation-provenance'); continue; }
        const text = source.text ?? source.content, entry = source.entry;
        if (typeof entry.world !== 'string' || !entry.world || entry.uid === undefined || entry.uid === null || source.id !== `world:${entry.world}:${entry.uid}`) { exclude(source, 'native-source-identity-mismatch'); continue; }
        if (typeof text !== 'string' || text.length < 8 || entry.content !== text) { exclude(source, 'source-text-does-not-exactly-match-entry-content'); continue; }
        if (entry.disable === true) { exclude(source, 'entry-marked-disabled'); continue; }
        if (source.requiresMacroExpansion || FORBIDDEN_MACRO.test(text)) { exclude(source, 'macro-or-template-boundary'); continue; }
        if (/```|(?:^|\n)\s*~~~|<\/?(?:script|style|tool_call|function_call)\b/i.test(text)) { exclude(source, 'code-or-executable-scope-not-eligible'); continue; }
        if (!hasBalancedTags(text) || !markupAtBoundaries(text, [0, text.length]).ok) { exclude(source, 'unbalanced-entry-tags'); continue; }
        if (DYNAMIC_STATE_CLOCK_DICE.test(text + '\n' + String(source.name ?? source.label ?? entry.comment ?? ''))) { exclude(source, 'dynamic-state-clock-or-dice'); continue; }
        if (DEPENDENT_REFERENCE.test(text)) { exclude(source, 'explicit-neighbour-dependency'); continue; }
        const stable = entry.constant === true;
        const recalled = entry.vectorized === true || (Array.isArray(entry.key) && entry.key.some(k => typeof k === 'string' && k.length));
        if (!stable && !recalled) { exclude(source, 'unknown-trigger-class'); continue; }
        const hits = [];
        for (const slot of slots) {
            const start = slot.text.indexOf(text);
            if (start >= 0) {
                if (start !== slot.text.lastIndexOf(text)) hits.push({ ambiguous: true });
                else hits.push({ slot, start });
            }
        }
        if (hits.length !== 1 || hits[0].ambiguous) { exclude(source, 'not-uniquely-located-in-request'); continue; }
        const { slot, start } = hits[0];
        if (!ROLES.has(slot.role)) { exclude(source, 'tool-or-unknown-message-role'); continue; }
        if (FORBIDDEN_MACRO.test(slot.text)) { exclude(source, 'message-has-unresolved-template-boundary'); continue; }
        if (/```|(?:^|\n)\s*~~~/.test(slot.text)) { exclude(source, 'message-with-code-fence-needs-manual-review'); continue; }
        const sourceId = String(source.id ?? 'source-' + index);
        if (sourceIds.has(sourceId)) {
            const prior = sourceIds.get(sourceId);
            prior.ambiguous = true; exclude(source, 'duplicate-source-identity'); continue;
        }
        const item = { id: `b${index}`, sourceId,
            content: text, role: slot.role, scope: slot.scope, start, end: start + text.length,
            stable, entry, source, slot, ambiguous: false };
        sourceIds.set(sourceId, item); accepted.push(item);
    }
    const byScope = new Map();
    for (const item of accepted) { if (!byScope.has(item.scope)) byScope.set(item.scope, []); byScope.get(item.scope).push(item); }
    const eligible = [];
    for (const group of byScope.values()) {
        group.sort((a, b) => a.start - b.start);
        for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length && group[j].start < group[i].end; j++) { group[i].ambiguous = true; group[j].ambiguous = true; }
        const markup = markupAtBoundaries(group[0].slot.text, group.flatMap(e => [e.start, e.end]));
        for (const item of group) {
            if (item.ambiguous) { exclude(item.source, 'overlapping-or-ambiguous-source'); continue; }
            if (!markup.ok) { exclude(item.source, 'unsafe-outer-markup:' + markup.reason, markup.boundaryFailure ? { scope: item.scope, ...markup.boundaryFailure } : null); continue; }
            if (markup.contexts.get(item.start) !== markup.contexts.get(item.end)) { exclude(item.source, 'entry-crosses-outer-tag-scope'); continue; }
            item.outerScope = markup.contexts.get(item.start); eligible.push(item);
        }
    }
    counts.eligibleEntries = eligible.length;
    const runs = [];
    for (const slot of slots) {
        const items = eligible.filter(e => e.scope === slot.scope).sort((a, b) => a.start - b.start);
        let run = [];
        for (const item of items) {
            const prior = run.at(-1);
            if (prior && (slotSignature(prior) !== slotSignature(item) || !/^\s*$/.test(slot.text.slice(prior.end, item.start)))) {
                if (run.length > 1) runs.push(run); run = [];
            }
            run.push(item);
        }
        if (run.length > 1) runs.push(run);
    }
    counts.eligibleGroups = runs.length;
    const changedRuns = runs.filter(changesOrder), chosen = [], chosenScopes = new Set();
    const maxGroups = Number.isInteger(setup.maxGroups) && setup.maxGroups > 0 ? Math.min(setup.maxGroups, 20) : 20;
    const maxEntries = Number.isInteger(setup.maxEntries) && setup.maxEntries > 1 ? Math.min(setup.maxEntries, 1000) : 256;
    // One run per actual message scope fits the existing optimizer's role/scope contract.
    for (const run of changedRuns) {
        if (chosenScopes.has(run[0].scope)) { run.forEach(e => exclude(e.source, 'additional-disjoint-run-in-same-message')); continue; }
        if (chosen.length >= maxGroups || chosen.reduce((n, g) => n + g.length, 0) + run.length > maxEntries) { run.forEach(e => exclude(e.source, 'bounded-candidate-cap')); continue; }
        chosen.push(run); chosenScopes.add(run[0].scope);
    }
    if (!chosen.length) {
        result.status = eligible.length ? 'no-change' : 'blocked';
        reasons.push(eligible.length ? '没有需要稳定资料前置的相邻同级范围；无需修改，也不会进行无意义排序。' : '没有实际激活且可唯一定位的世界书范围通过结构检查。');
        return result;
    }
    const selected = chosen.flat(), binding = { chatId: String(record.chatId), model: String(record.model), provider: String(record.provider), purpose: 'main' };
    if (record.characterId !== undefined) binding.characterId = record.characterId === null ? null : String(record.characterId);
    if (record.groupId !== undefined) binding.groupId = record.groupId === null ? null : String(record.groupId);
    const blocks = selected.map(e => ({ id: e.id, content: e.content, role: e.role, scope: e.scope, stable: e.stable, cacheable: true,
        approvedIndependent: setup.batchAuthorized === true, source: { kind: 'worldbook', name: label(e.source.name ?? e.source.label ?? e.sourceId), id: label(e.sourceId), provenance: 'WORLD_INFO_ACTIVATED', approvalBasis: 'bounded-batch-policy-not-machine-proven-semantics' } }));
    const profile = createProfile({ id: 'batch-' + profileFingerprint(binding), mode: 'preview', binding, blocks, limits });
    const proposal = { schemaVersion: 1, expectedVersion: profile.version,
        reason: '仅在本轮已激活、同角色且同注入范围的相邻世界书条目中，将无宏的常驻资料稳定排列到按需召回资料之前；不修改原书排序值、内容或触发。',
        sources: selected.map(e => e.id),
        operations: chosen.map(run => ({ type: 'reorder_blocks', scope: run[0].scope, role: run[0].role, ids: stableFirst(run).map(e => e.id) })) };
    const previewBody = copy(record.body), previewSlots = new Map(textSlots(previewBody).map(slot => [slot.scope, slot]));
    const conservation = [];
    for (const run of chosen) {
        const slot = previewSlots.get(run[0].scope), original = run[0].slot.text;
        const gaps = run.slice(1).map((e, i) => original.slice(run[i].end, e.start));
        const reordered = stableFirst(run);
        const middle = reordered.map((entry, i) => entry.content + (gaps[i] ?? '')).join('');
        slot.parent[slot.key] = original.slice(0, run[0].start) + middle + original.slice(run.at(-1).end);
        conservation.push({ scope: run[0].scope, role: run[0].role, before: run.map(e => e.id), after: reordered.map(e => e.id),
            separatorBytesPreserved: true, contentBytesPreserved: true, nativeEntrySettingsChanged: false });
    }
    const beforeBytes = utf8(JSON.stringify(record.body)), afterBytes = utf8(JSON.stringify(previewBody));
    if (beforeBytes !== afterBytes || chosen.some(run => { const text = previewSlots.get(run[0].scope).parent[previewSlots.get(run[0].scope).key]; return !hasBalancedTags(text) || !markupAtBoundaries(text, [0, text.length]).ok; })) {
        reasons.push('离线内容守恒或作用域校验失败，禁止应用此方案。'); return result;
    }
    const selectedByteAccounting = blocks.reduce((n, b) => n + utf8(b.content) + 128, 0) + 512;
    const fullRequestByteBound = Math.max(beforeBytes, afterBytes) + 4096;
    const otherInputUpperBound = Math.max(0, fullRequestByteBound - selectedByteAccounting);
    const guardedBound = selectedByteAccounting + otherInputUpperBound;
    const context = { byteLevelTokenizer: true, otherInputUpperBound, unsupportedContent: false, limitsOverride: copy(limits), inFlight: false };
    const ceiling = Math.min(limits.maxInputTokens, limits.contextTokens - (limits.outputReserveTokens ?? 0));
    const estimate = inputEvidence && Number.isFinite(inputEvidence.value) && inputEvidence.value >= 0
        ? { value: inputEvidence.value, method: String(inputEvidence.method ?? 'caller-estimate'), exact: false, note: '仅作展示，不替代已验证的完整请求上界。' } : null;
    const preview = previewProposal(profile, proposal, context);
    counts.selectedEntries = blocks.length; counts.selectedGroups = chosen.length;
    counts.stableEntries = selected.filter(e => e.stable).length; counts.dynamicEntries = blocks.length - counts.stableEntries;
    Object.assign(result, { profile, proposal, previewContext: context, preview, previewBody, groups: conservation,
        input: { requestBytesBefore: beforeBytes, requestBytesAfter: afterBytes, upperBound: guardedBound, method: 'conservative-utf8-byte-bound', exact: false, ceiling, withinLimit: guardedBound <= ceiling, estimate },
        status: preview.ok ? 'candidate' : setup.batchAuthorized !== true && guardedBound <= ceiling ? 'needs-batch-approval' : 'blocked',
        canApply: preview.ok && setup.batchAuthorized === true });
    if (guardedBound > ceiling) reasons.push('完整请求的保守输入上界超过用户或上下文上限；较小的分词估算值不会被冒充精确值以绕过保护。');
    if (setup.batchAuthorized !== true) reasons.push('需要一次授权此世界书批次范围，无需逐条勾选；授权前仅提供预览。');
    if (!preview.ok && setup.batchAuthorized === true) reasons.push(...preview.errors);
    return result;
}
