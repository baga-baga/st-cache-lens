/** Metadata-only rejection reporting. This module never changes optimization guards. */
const LIMITS = Object.freeze({ exclusions: 2000, inventory: 5000, groups: 100, requests: 100, occurrences: 2000, affectedRefs: 40 });
const COUNT_KEYS = ['totalSources', 'explicitWorldInfoSources', 'eligibleEntries', 'eligibleGroups', 'selectedEntries', 'selectedGroups', 'stableEntries', 'dynamicEntries'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const rows = value => Array.isArray(value) ? value : [];
const STATUS = new Set(['candidate', 'needs-batch-approval', 'no-change', 'blocked']);

// Every exported label and code comes from this local allowlist, never a source string.
const REASONS = Object.freeze({
    'not-explicit-world-info': ['非世界书来源', 'non-world', false],
    'missing-trusted-activation-provenance': ['激活来源证据不足', 'provenance', true],
    'third-party-adapter-diagnostic-only': ['第三方适配器仅供诊断', 'provenance', true],
    'native-source-identity-mismatch': ['原生条目身份不匹配', 'provenance', true],
    'unsupported-source-access': ['来源权限标记异常', 'provenance', true],
    'source-text-does-not-exactly-match-entry-content': ['来源与条目正文不一致', 'source-content', true],
    'entry-marked-disabled': ['条目标记停用', 'disabled', true],
    'macro-or-template-boundary': ['条目含宏或模板边界', 'template', true],
    'message-has-unresolved-template-boundary': ['所在消息含未解析模板边界', 'template', true],
    'code-or-executable-scope-not-eligible': ['条目含代码或工具作用域', 'code', true],
    'message-with-code-fence-needs-manual-review': ['所在消息含代码围栏', 'code', true],
    'unbalanced-entry-tags': ['条目标签未完整闭合', 'entry-tags', true],
    'dynamic-state-clock-or-dice': ['动态状态、相对时间或骰池', 'dynamic', true],
    'explicit-neighbour-dependency': ['依赖相邻条目的顺序', 'dependency', true],
    'unknown-trigger-class': ['触发类型未明确', 'trigger', true],
    'not-uniquely-located-in-request': ['无法唯一定位实际文本', 'location', true],
    'tool-or-unknown-message-role': ['工具消息或未知角色', 'role', true],
    'duplicate-source-identity': ['来源身份重复', 'location', true],
    'overlapping-or-ambiguous-source': ['来源区间重叠或归属不唯一', 'location', true],
    'entry-crosses-outer-tag-scope': ['条目跨越外层标签范围', 'outer-tags', true],
    'additional-disjoint-run-in-same-message': ['同消息另一个不相邻范围', 'range', true],
    'bounded-candidate-cap': ['达到候选数量上限', 'capacity', true],
});
const OUTER_REASONS = Object.freeze({
    'unclosed-comment': '外层注释未闭合',
    'source-boundary-inside-comment': '来源边界位于注释内',
    'unsupported-markup': '外层标记语法未支持',
    'unsupported-tag-name': '外层标签名称未支持',
    'incomplete-tag': '外层标签不完整',
    'source-boundary-inside-tag': '来源边界位于标签内',
    'unsupported-tag-syntax': '外层标签语法未支持',
    'mismatched-tag': '外层标签闭合不匹配',
    'unclosed-outer-tag': '外层标签未闭合',
});
const CATEGORY_LABELS = Object.freeze({
    provenance: '来源证据', 'source-content': '正文一致性', disabled: '停用条目', template: '模板边界', code: '代码围栏或代码范围',
    'entry-tags': '条目标签', dynamic: '状态、时间或骰池', dependency: '顺序依赖', trigger: '触发类型', location: '文本定位', role: '消息角色',
    'outer-tags': '外层标签', range: '相邻范围', capacity: '数量上限', unknown: '未识别保护条件', 'non-world': '非世界书来源',
});
function reasonMetadata(raw) {
    if (typeof raw === 'string' && Object.hasOwn(REASONS, raw)) {
        const [label, category, worldCandidate] = REASONS[raw]; return { code: raw, label, category, worldCandidate, recognized: true };
    }
    if (typeof raw === 'string' && raw.startsWith('unsafe-outer-markup:')) {
        const subcode = raw.slice('unsafe-outer-markup:'.length);
        if (Object.hasOwn(OUTER_REASONS, subcode)) return { code: 'unsafe-outer-markup:' + subcode, label: OUTER_REASONS[subcode], category: 'outer-tags', worldCandidate: true, recognized: true };
    }
    return { code: 'unrecognized-protection-condition', label: '未识别保护条件', category: 'unknown', worldCandidate: null, recognized: false };
}
function safeBoundaryFailure(value) {
    if (!value || typeof value.scope !== 'string' || !/^(?:system(?:\.\d{1,6}\.text)?|messages\.\d{1,6}\.content(?:\.\d{1,6}\.text)?)$/.test(value.scope) || count(value.offset) === null) return null;
    const symbolCodePoints = rows(value.symbolCodePoints).slice(0, 16).filter(code => {
        if (typeof code !== 'string' || !/^U\+[0-9A-F]{4,6}$/.test(code)) return false;
        const n = parseInt(code.slice(2), 16);
        return n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) && !/[\p{L}\p{N}\p{M}_]/u.test(String.fromCodePoint(n));
    });
    return { scope: value.scope, offset: value.offset, symbolCodePoints: [...new Set(symbolCodePoints)] };
}
function inventoryIndex(report) {
    const inventory = rows(report?.inventory?.entries), byNative = new Map(), byReportRef = new Map();
    for (const [i, entry] of inventory.slice(0, LIMITS.inventory).entries()) {
        const ref = typeof entry?.ref === 'string' && /^b\d+:e\d+$/.test(entry.ref) ? entry.ref : 'entry-' + (i + 1);
        if (typeof entry?.ref === 'string') byReportRef.set(entry.ref, ref);
        if (typeof entry?.bookName === 'string' && entry.uid !== undefined && entry.uid !== null && ['string', 'number'].includes(typeof entry.uid)) {
            const native = `world:${entry.bookName}:${entry.uid}`;
            // Ambiguous source IDs cannot be mapped to a specific entry in a metadata export.
            byNative.set(native, byNative.has(native) ? null : ref);
        }
    }
    return { byNative, byReportRef, truncated: inventory.length > LIMITS.inventory };
}
function matchEvidence(report, index) {
    const groups = rows(report?.requestGroups), selectedGroups = groups.slice(0, LIMITS.groups).filter(g => g?.purpose === 'main');
    const all = selectedGroups.flatMap(g => rows(g.requests)), selected = all.slice(-LIMITS.requests);
    const summaries = [];
    let incomplete = groups.length > LIMITS.groups || all.length > LIMITS.requests;
    for (const [i, request] of selected.entries()) {
        if (request?.bodyObserved !== true || !Array.isArray(request.exactSourceOccurrences)) continue;
        const occurrences = request.exactSourceOccurrences.slice(0, LIMITS.occurrences), refs = new Set();
        if (request.exactSourceOccurrences.length > LIMITS.occurrences) incomplete = true;
        for (const occurrence of occurrences) {
            if (occurrence?.ambiguous === true) continue;
            const ref = index.byReportRef.get(occurrence?.ref);
            if (ref) refs.add(ref);
        }
        summaries.push({ requestRef: typeof request.ref === 'string' && /^r\d+$/.test(request.ref) ? request.ref : 'request-' + (i + 1),
            exactMatchedWorldEntries: refs.size, activatedWorldEntries: request.activeEntries?.known === true ? count(request.activeEntries.count) : null });
    }
    return { available: summaries.length > 0, scope: 'report-main-requests-not-bound-to-candidate', evidence: 'reported-exact-source-occurrences',
        mainRequestsWithMatchMetadata: summaries.length, mainRequestsWithWorldMatches: summaries.filter(r => r.exactMatchedWorldEntries > 0).length,
        maximumExactMatchedWorldEntries: summaries.length ? Math.max(...summaries.map(r => r.exactMatchedWorldEntries)) : null,
        latestReportedMainRequest: summaries.at(-1) ?? null, truncated: incomplete,
        conclusion: summaries.some(r => r.exactMatchedWorldEntries > 0) ? 'reported-world-text-matches-exist' : 'no-positive-match-established-by-this-export' };
}

/**
 * Safe metadata export for a concrete plan. It intentionally omits free-form reasons,
 * source names/IDs, source text, profiles, proposals, request bodies and unknown fields.
 * A report may establish past exact matches; it cannot identify this plan's rejection
 * reason unless the plan's actual exclusion metadata is also supplied.
 */
export function summarizeBatchPlan(plan, report = null) {
    const present = !!plan && typeof plan === 'object' && !Array.isArray(plan);
    const status = present && STATUS.has(plan.status) ? plan.status : 'unknown';
    const index = inventoryIndex(report), excluded = present ? rows(plan.exclusions) : [], groups = new Map(), opaque = new Map(), allRefs = new Set();
    let nextOpaque = 1;
    const sourceRef = raw => {
        if (typeof raw !== 'string' || !raw) return 'unidentified-source';
        const native = index.byNative.get(raw); if (native) return native;
        if (!opaque.has(raw)) opaque.set(raw, 'source-' + nextOpaque++);
        return opaque.get(raw);
    };
    for (const exclusion of excluded.slice(0, LIMITS.exclusions)) {
        const metadata = reasonMetadata(exclusion?.reason);
        if (!groups.has(metadata.code)) groups.set(metadata.code, { ...metadata, count: 0, refs: new Set(), failures: new Map() });
        const group = groups.get(metadata.code), ref = sourceRef(exclusion?.sourceId); group.count++; group.refs.add(ref); allRefs.add(ref);
        const failure = metadata.category === 'outer-tags' ? safeBoundaryFailure(exclusion?.boundaryFailure) : null;
        if (failure) group.failures.set(JSON.stringify(failure), failure);
    }
    const rejectionGroups = [...groups.values()].map(({ refs, failures, ...group }) => ({ ...group, distinctSources: refs.size,
        boundaryFailures: [...failures.values()].slice(0, 8), boundaryFailuresTruncated: failures.size > 8,
        affectedSourceRefs: [...refs].slice(0, LIMITS.affectedRefs), affectedRefsTruncated: refs.size > LIMITS.affectedRefs }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, present ? count(plan.counts?.[key]) : null]));
    const input = present && plan.input && typeof plan.input === 'object' ? plan.input : null;
    const upperBound = number(input?.upperBound), ceiling = number(input?.ceiling);
    const matchingEvidence = matchEvidence(report, index);
    const analyzed = Math.min(excluded.length, LIMITS.exclusions);
    return {
        schemaVersion: 1, kind: 'batch-plan-metadata', planPresent: present, status,
        canApply: status === 'candidate' && plan?.canApply === true,
        requiresBatchApproval: present && typeof plan.requiresBatchApproval === 'boolean' ? plan.requiresBatchApproval : null,
        counts, rejectionGroups,
        rejectionTotals: { records: excluded.length, analyzedRecords: analyzed,
            knownWorldCandidateRecords: rejectionGroups.filter(g => g.worldCandidate === true).reduce((n, g) => n + g.count, 0),
            nonWorldRecords: rejectionGroups.filter(g => g.worldCandidate === false).reduce((n, g) => n + g.count, 0),
            unknownCategoryRecords: rejectionGroups.filter(g => g.worldCandidate === null).reduce((n, g) => n + g.count, 0),
            distinctMappedOrOpaqueSources: allRefs.size,
            countMeaning: 'rejection-records-not-proof-of-distinct-sources-or-missing-injection' },
        input: { assessed: !!input, upperBound, ceiling, exact: false,
            method: input?.method === 'conservative-utf8-byte-bound' ? 'conservative-utf8-byte-bound' : 'unreported-or-unsupported',
            withinLimit: upperBound !== null && ceiling !== null ? upperBound <= ceiling : null,
            requestBytesBefore: number(input?.requestBytesBefore), requestBytesAfter: number(input?.requestBytesAfter) },
        matchingEvidence,
        distinction: { qualifyingEntries: counts.eligibleEntries, selectedReorderEntries: counts.selectedEntries, selectedReorderGroups: counts.selectedGroups,
            knownTextMatchesExistInReport: matchingEvidence.conclusion === 'reported-world-text-matches-exist',
            rejectedByPlannerDoesNotMeanAbsentFromPrompt: true,
            noQualifiedRangeIsNotNoMatchingSource: true },
        coverage: { exclusionsTruncated: excluded.length > LIMITS.exclusions, inventoryMappingTruncated: index.truncated,
            requestMatchEvidenceTruncated: matchingEvidence.truncated },
        noPromptText: true, noPrivateNames: true, noApiKeys: true,
    };
}

/** Compact fixed-label UI summary. Passing an already summarized object is preferred. */
export function formatPlanRejections(value, report = null) {
    const summary = value?.kind === 'batch-plan-metadata' ? value : summarizeBatchPlan(value, report);
    const categories = new Map();
    for (const group of rows(summary.rejectionGroups)) {
        const category = Object.hasOwn(CATEGORY_LABELS, group?.category) ? group.category : 'unknown';
        if (category === 'non-world') continue;
        const n = count(group.count); if (n !== null) categories.set(category, (categories.get(category) ?? 0) + n);
    }
    const sorted = [...categories].sort((a, b) => b[1] - a[1]);
    const parts = sorted.slice(0, 8).map(([category, n]) => `${CATEGORY_LABELS[category]} ${n} 项`);
    let text = parts.length ? '保护条件记录：' + parts.join('；') + '。' : summary.planPresent === false ? '当前导出没有本次优化计划的拒绝记录，无法确定具体原因。' : '没有已记录的条目拒绝原因；没有候选不等于未匹配世界书。';
    if (sorted.length > 8) text += '其余分类见诊断详情。';
    const eligible = count(summary.counts?.eligibleEntries), selected = count(summary.counts?.selectedEntries);
    if (eligible !== null || selected !== null) text += `通过结构检查 ${eligible ?? '未知'} 条，选中重排 ${selected ?? '未知'} 条。`;
    const failureSites = new Set(rows(summary.rejectionGroups).flatMap(group => rows(group.boundaryFailures)).map(safeBoundaryFailure).filter(Boolean).map(failure => `${failure.scope}:${failure.offset}`));
    if (failureSites.size) text += `已记录 ${failureSites.size} 处外层标签解析位置，可能共同影响多个条目，不等于每个条目各自损坏。`;
    const latest = summary.matchingEvidence?.latestReportedMainRequest;
    if (count(latest?.exactMatchedWorldEntries) > 0) text += `报告最后一条可用正文记录中，已有 ${latest.exactMatchedWorldEntries} 条世界书文本被精确定位；上述保护条件不能解释为“没有注入世界书”。`;
    if (summary.coverage?.exclusionsTruncated || summary.coverage?.requestMatchEvidenceTruncated) text += '诊断记录已限量，未覆盖部分保持未知。';
    return text.slice(0, 1200);
}
