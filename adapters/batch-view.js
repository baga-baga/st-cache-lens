/** Mobile batch summary. Render with textContent; never interpolate source text. */
const rows = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const num = value => !finite(value) ? '未知' : value > 1e9 ? value.toExponential(2) : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

const issueGroups = [
    [['REPORTED_INPUT_OVER_USER_LIMIT'], 'usage 报告实际输入超过用户上限'],
    [['DYNAMIC_BEFORE_CHARACTER', 'DYNAMIC_POSITION_ZERO', 'DYNAMIC_WORLD_SOURCE_AT_EARLIEST_DIFF'], '条件触发资料位于前部或最早差异处，需结合实际作用域排查'],
    [['LARGE_CONSTANT_SET', 'BUDGET_BYPASS_ENABLED'], '常驻量较大或存在绕过世界书预算的设置'],
    [['ACTIVATION_SET_CHANGED', 'OBSERVED_ENTRY_ORDER_CHANGED', 'SOURCE_SCOPE_CHANGED', 'OBSERVED_SOURCE_TEXT_CHANGED'], '已观察到激活集合、排列、作用域或来源文字变化'],
    [['EXACT_TEXT_REPEATED_IN_CONFIG', 'EXACT_REPEATED_REQUEST_TEXT'], '存在完全相同文本；配置重复与实际重复注入须分开核实'],
    [['PRESET_ORDER_UNKNOWN', 'UNKNOWN_EXTENSIONS_READ_ONLY'], '预设顺序未确认或扩展缺少明确适配，相关部分只读'],
    [['SHARED_INSERTION_ORDER'], '多个条目排序值相同；这不证明随机乱序'],
];

function observations(report) {
    const groups = rows(report.requestGroups), all = groups.flatMap(g => rows(g.requests));
    if (!all.length) return '尚无本次分析可用的请求原文；设置扫描不能证明本轮激活量、最终发送量或缓存结果。';
    const parts = [];
    for (const [purpose, name] of [['main', '正文'], ['summary', '摘要'], ['agent', '优化 Agent'], ['unknown', '用途未知']]) {
        const selected = groups.filter(g => (['main', 'summary', 'agent'].includes(g.purpose) ? g.purpose : 'unknown') === purpose);
        if (!selected.length) continue;
        const records = selected.flatMap(g => rows(g.requests));
        parts.push(`${name} ${num(selected.length)} 组/${num(records.length)} 条记录（原文 ${num(records.filter(r => r.bodyObserved === true).length)} 条）`);
    }
    const raw = all.filter(r => r.bodyObserved === true).length;
    return `本次分析：${parts.join('；')}。按聊天、模型、用途、接口及观察层分组；前后端记录不相加计费。${raw ? '' : '仅有元数据，无法重新逐字比较或生成请求优化副本。'}`;
}

function planSummary(plan) {
    if (!plan || typeof plan !== 'object') return '尚未生成请求优化方案；扫描本身不修改配置。';
    const c = plan.counts ?? {}, selected = count(c.selectedEntries), groups = count(c.selectedGroups);
    let text;
    if (plan.canApply === true && plan.status === 'candidate') text = `本地候选：${num(groups)} 组、${num(selected)} 条通过校验，可在已授权范围应用；结构校验不证明语义独立或实际节省。`;
    else if (plan.status === 'needs-batch-approval') text = `批次预览：${num(groups)} 组、${num(selected)} 条；待一次批次范围授权，当前可应用 0 条，无需逐条勾选。`;
    else if (plan.status === 'no-change') text = '当前可应用 0 条：没有需要重排的相邻同级范围，保持原样。';
    else text = '当前可应用 0 条：方案受到保护条件限制。';
    if (plan.input && finite(plan.input.upperBound)) {
        text += `完整请求保守保护上界 ${num(plan.input.upperBound)}，有效上限 ${num(plan.input.ceiling)}${plan.input.withinLimit === false ? '，已超出保护上限' : ''}；这是 UTF-8 字节推导的上界，不是实际 tokens，较小估算不能绕过保护。`;
    }
    // Do not echo free-form errors: they can contain source names or user text.
    const reasons = rows(plan.reasons).filter(r => typeof r === 'string').join('\n');
    const labels = [];
    const reasonRules = [
        [/检查未完成|禁止优化/, '当前设置扫描不完整'],
        [/导入、模拟|回放或预测/, '导入或模拟记录不能授权实际修改'],
        [/正文的前端实际请求|完整组装内容/, '缺少明确归类为正文的完整前端请求'],
        [/需要明确当前聊天|范围不一致/, '聊天、模型或授权范围尚未匹配'],
        [/有效的输入上限/, '尚未设置有效输入及上下文上限'],
        [/多模态|接口尚不支持|消息结构不受支持/, '接口或内容结构暂不支持此输入保护'],
        [/没有实际激活/, '无已激活且可唯一定位的合格范围'],
        [/守恒|作用域校验失败/, '内容守恒或作用域检查未通过'],
    ];
    for (const [pattern, label] of reasonRules) if (pattern.test(reasons)) labels.push(label);
    if (labels.length) text += `限制原因：${labels.slice(0, 2).join('；')}。`;
    const excluded = rows(plan.exclusions).filter(e => e?.reason !== 'not-explicit-world-info');
    if (excluded.length) text += `另有 ${num(excluded.length)} 项世界书来源未通过定位、宏、标签、动态状态或范围检查，保留原样。`;
    return text;
}

/** Human-readable, bounded summary of analyzeSetup and optional buildBatchPlan. */
export function batchSummary(report, plan = null) {
    if (!report || typeof report !== 'object') return '尚无批量扫描结果。扫描会自动读取当前绑定世界书与预设，无需逐条截图；不会因此发起付费请求。';
    const c = report.counts ?? {}, coverage = report.coverage ?? {}, q = report.worldQuantities ?? {};
    const intro = coverage.complete === true
        ? '扫描已自动覆盖当前绑定书与预设，无需逐条截图。'
        : '扫描会自动读取当前绑定书与预设，无需逐条截图；本次资料不完整，相关自动调整受限。';
    const inventory = `已读取 ${num(c.loadedBooks)} / ${num(c.booksExpected ?? c.books)} 本绑定书，共 ${num(c.entries)} 条：常驻 ${num(c.constant)}、关键词 ${num(c.keyword)}、向量 ${num(c.vector)}、停用 ${num(c.disabled)}、其他/未知 ${num(c.conditionalOrUnknown)}；预设 ${num(c.presetPrompts)} 项。关键词触发概率 100% 仍不等于常驻。`;
    const whole = finite(q.wholeBook?.value) ? `整书总量约 ${num(q.wholeBook.value)} tokens（含停用条目）` : `整书总量未知${finite(q.observedInventoryPartial?.value) ? `，已读取部分约 ${num(q.observedInventoryPartial.value)} tokens` : ''}`;
    const budget = finite(q.budget?.derivedLimit?.value) ? `配置推导的世界书预算上限 ${num(q.budget.derivedLimit.value)} tokens` : '世界书预算上限未知';
    const quantities = `${whole}；${budget}。整书是字节估算，不是本轮激活量或最终发送量；整书超过上限不等于实际请求超限。世界书单独最终发送 tokens 尚未知。`;
    const notes = [];
    if (coverage.requestAnalysisTruncated || coverage.sourceAnalysisTruncated) notes.push('观察记录或来源分析已限量，不能据未覆盖部分判断稳定。');
    if (rows(report.warnings).some(w => w?.code === 'USAGE_INCOMPLETE')) notes.push('usage 不完整时，缓存读取未知不等于零。');
    const end = `${notes.join('')}这是本地诊断与离线试算，不会自动发起付费请求，也未证明唯一失效原因或费用下降。`;
    const before = [intro + inventory, observations(report), quantities];
    const after = [planSummary(plan), end];
    const findings = rows(report.settingsFindings), issues = [];
    for (const [codes, label] of issueGroups) {
        const matches = findings.filter(f => codes.includes(f?.code));
        if (!matches.length) continue;
        issues.push(label);
        if (issues.length === 6) break;
    }
    // Keep safety/evidence qualifications; omit optional grouped findings first.
    let middle = issues.length ? `集中排查：${issues.join('；')}。` : '未发现已实现规则中的集中风险；这不代表缓存与剧情质量已经验证。';
    while ([...before, middle, ...after].join('\n\n').length > 1200 && issues.length) {
        issues.pop(); middle = issues.length ? `集中排查：${issues.join('；')}。` : '';
    }
    return [...before, middle, ...after].filter(Boolean).join('\n\n');
}
