/** Fixed, text-free evidence about the local inventory read before an Agent audit. */
const COLLECTION_MESSAGES = Object.freeze({
    WORLD_MODULE_UNAVAILABLE: '世界书公开接口未能加载，当前绑定范围尚未读全。',
    PRESET_MODULE_UNAVAILABLE: '预设模块未能加载；仍可检查从当前设置读到的条目，顺序需另行确认。',
    GLOBAL_BINDINGS_UNKNOWN: '未能确认全局绑定的世界书。',
    GLOBAL_WORLD_SETTINGS_UNKNOWN: '未能读取全局世界书设置。',
    CHAT_BOOK_BINDING_UNKNOWN: '未能确认当前聊天绑定的世界书。',
    CHARACTER_EXTRA_BINDINGS_UNKNOWN: '未能确认角色额外绑定的世界书。',
    PERSONA_BINDING_UNKNOWN: '未能确认用户角色绑定的世界书。',
    CURRENT_CHARACTER_UNSELECTED: '当前没有读到已选择的角色；请先打开要检查的角色聊天，再免费扫描。',
    PRESET_PROMPTS_UNKNOWN: '未能读取当前预设条目。',
    PRESET_ORDER_UNKNOWN: '预设条目顺序尚未确认，只能作只读检查。',
    UNSUPPORTED_MAIN_API: '当前正文接口尚未经过此采集器适配。',
    RUNTIME_VERSION_NOT_VERIFIED: '当前酒馆版本尚未核验；位置语义需要保留不确定性。',
    RUNTIME_VERSION_UNREPORTED: '酒馆未提供运行版本，不能确认版本匹配。',
    GROUP_SCOPE_CURRENT_SPEAKER_ONLY: '群聊采集范围只包括当前发言角色。',
    THIRD_PARTY_IMPLEMENTATIONS_READ_ONLY: '未知第三方扩展内部状态保持只读，当前仅检查其公开来源。',
    INVALID_BOOK_BINDING: '世界书绑定格式无效，不能确认完整范围。',
    INVALID_CHARACTER_EXTRA_BINDINGS: '角色额外世界书绑定格式无效。',
    BOOK_COUNT_LIMIT: '绑定世界书数量达到本机采集上限，当前范围不完整。',
    SETTINGS_BYTE_LIMIT: '设置数据达到本机采集大小上限。',
    WORLD_BOOK_READER_UNAVAILABLE: '没有可用的世界书读取接口。',
    BOOK_READ_FAILED: '至少一本已绑定世界书读取失败；不代表世界书被删除。',
    BOOK_MISSING_OR_INVALID: '至少一本已绑定世界书未返回有效数据。',
    ENTRY_COUNT_LIMIT: '世界书条目数量达到本机采集上限。',
    ENTRY_INVALID: '已绑定世界书含无法识别的条目数据。',
    BOOK_BYTE_LIMIT: '世界书数据达到本机采集大小上限。',
    SCAN_ABORTED: '本机采集被停止，未完成当前范围。',
    SETTINGS_RECHECK_FAILED: '采集后未能复核配置是否仍相同。',
    CONCURRENT_CONFIGURATION_CHANGE: '采集期间角色或配置发生变化，请重新免费扫描。',
    REVISION_FINGERPRINT_UNAVAILABLE: '无法建立配置版本指纹，暂不能核实扫描期间是否有修改。',
    SNAPSHOT_BYTE_LIMIT: '包含采集说明后的快照超过大小上限，部分书未保留。',
    SCAN_METADATA_BYTE_LIMIT: '采集元数据超过大小上限。',
    WORLD_BOOKS_NOT_FULLY_READ: '已确认的绑定书数量与准备/读取数量不一致，尚未完整读取。',
    COLLECTION_TRUNCATED: '本机采集明确标记为截断，尚未完整读取。',
    COLLECTION_ISSUES_TRUNCATED: '采集问题列表超过保留范围，不能确认所有缺口。',
    UNKNOWN_COLLECTION_ISSUE: '采集返回了未识别的问题代码；未保留任意错误正文。',
});

const BLOCKING = new Set([
    'WORLD_MODULE_UNAVAILABLE', 'GLOBAL_BINDINGS_UNKNOWN',
    'GLOBAL_WORLD_SETTINGS_UNKNOWN', 'CHAT_BOOK_BINDING_UNKNOWN', 'CHARACTER_EXTRA_BINDINGS_UNKNOWN',
    'PERSONA_BINDING_UNKNOWN', 'CURRENT_CHARACTER_UNSELECTED', 'PRESET_PROMPTS_UNKNOWN',
    'UNSUPPORTED_MAIN_API', 'INVALID_BOOK_BINDING', 'INVALID_CHARACTER_EXTRA_BINDINGS',
    'BOOK_COUNT_LIMIT', 'SETTINGS_BYTE_LIMIT', 'WORLD_BOOK_READER_UNAVAILABLE', 'BOOK_READ_FAILED',
    'BOOK_MISSING_OR_INVALID', 'ENTRY_COUNT_LIMIT', 'ENTRY_INVALID', 'BOOK_BYTE_LIMIT', 'SCAN_ABORTED',
    'SETTINGS_RECHECK_FAILED', 'CONCURRENT_CONFIGURATION_CHANGE', 'REVISION_FINGERPRINT_UNAVAILABLE',
    'SNAPSHOT_BYTE_LIMIT', 'SCAN_METADATA_BYTE_LIMIT', 'WORLD_BOOKS_NOT_FULLY_READ',
    'COLLECTION_TRUNCATED', 'COLLECTION_ISSUES_TRUNCATED',
]);
const MAX_ISSUES_PER_SOURCE = 256;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9 ? value : null;
const flag = value => typeof value === 'boolean' ? value : null;
const firstFlag = (...values) => values.map(flag).find(value => value !== null) ?? null;
const length = value => Array.isArray(value) ? count(value.length) : null;
const knownCode = value => typeof value === 'string' && Object.hasOwn(COLLECTION_MESSAGES, value);

/** Never returns book names, labels, character IDs, prompt text, URLs or raw errors. */
export function auditCollectionEvidence(report = {}, setup = null) {
    const codes = new Set();
    let issuesTruncated = false;
    for (const source of [setup?.warnings, setup?.coverageUnknown, report?.coverage?.coverageUnknown]) {
        if (!Array.isArray(source)) continue;
        issuesTruncated ||= source.length > MAX_ISSUES_PER_SOURCE;
        for (const item of source.slice(0, MAX_ISSUES_PER_SOURCE)) {
            const value = typeof item === 'string' ? item : item?.code;
            codes.add(knownCode(value) ? value : 'UNKNOWN_COLLECTION_ISSUE');
        }
    }
    if (issuesTruncated) codes.add('COLLECTION_ISSUES_TRUNCATED');
    const requestGroups = Array.isArray(report?.requestGroups) ? report.requestGroups : null;
    const requestRows = requestGroups?.flatMap(group => Array.isArray(group?.requests) ? group.requests : []);
    const books = Array.isArray(report?.books) ? report.books : null;
    const character = setup && Object.hasOwn(setup, 'character') ? setup.character : undefined;
    return {
        version: 1,
        collectionComplete: firstFlag(setup?.complete, report?.coverage?.collectionComplete, report?.coverage?.complete),
        truncated: firstFlag(setup?.truncated, report?.coverage?.truncated),
        requestAnalysisTruncated: flag(report?.coverage?.requestAnalysisTruncated),
        sourceAnalysisTruncated: flag(report?.coverage?.sourceAnalysisTruncated),
        currentCharacterSelected: character === null ? false : character && typeof character === 'object' && !Array.isArray(character) ? true : null,
        issuesTruncated,
        codes: [...codes].sort(),
        totals: {
            booksExpected: count(setup?.counts?.booksExpected) ?? count(report?.counts?.booksExpected),
            booksPrepared: length(books) ?? count(report?.counts?.books),
            booksLoaded: books ? count(books.filter(book => book?.loaded === true).length) : count(report?.counts?.loadedBooks),
            entriesPrepared: length(report?.inventory?.entries) ?? count(report?.counts?.entries),
            presetsPrepared: length(report?.preset?.prompts) ?? count(report?.counts?.presetPrompts),
            requestRecords: length(requestRows) ?? count(report?.counts?.observedRequests),
            requestBodiesObserved: requestRows ? count(requestRows.filter(request => request?.bodyObserved === true).length) : null,
        },
    };
}

/** Block an incomplete full-inventory audit, without requiring new story requests. */
export function collectionBlockingCodes(evidence) {
    const codes = new Set((Array.isArray(evidence?.codes) ? evidence.codes : []).filter(code => BLOCKING.has(code)));
    if (evidence?.currentCharacterSelected === false) codes.add('CURRENT_CHARACTER_UNSELECTED');
    if (evidence?.truncated === true) codes.add('COLLECTION_TRUNCATED');
    if (evidence?.issuesTruncated === true) codes.add('COLLECTION_ISSUES_TRUNCATED');
    const expected = count(evidence?.totals?.booksExpected);
    for (const value of [evidence?.totals?.booksPrepared, evidence?.totals?.booksLoaded]) {
        const actual = count(value);
        if (expected !== null && actual !== null && actual < expected) codes.add('WORLD_BOOKS_NOT_FULLY_READ');
    }
    if (evidence?.collectionComplete === false && evidence?.codes?.includes?.('UNKNOWN_COLLECTION_ISSUE')) codes.add('UNKNOWN_COLLECTION_ISSUE');
    return [...codes].sort();
}

export function collectionIssueMessage(code) {
    return knownCode(code) ? COLLECTION_MESSAGES[code] : COLLECTION_MESSAGES.UNKNOWN_COLLECTION_ISSUE;
}
