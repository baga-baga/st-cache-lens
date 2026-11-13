/** Human-readable local evidence only. Render with textContent, never innerHTML. */
const numberText = value => Number(value).toLocaleString('zh-CN');
const finiteCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const shortText = value => typeof value === 'string' ? value.slice(0, 180) : '';

function locationText(path) {
    if (typeof path !== 'string' || !path) return '已观察到的内容边界';
    const message = /^messages\[(\d+)\](.*)$/.exec(path);
    if (message) {
        const index = Number(message[1]);
        return `第 ${index + 1} 条 API 消息（数组索引 ${index}，不是第 ${index + 1} 轮聊天）的 ${shortText(message[2].replace(/^\./, '') || '消息边界')}，路径 ${shortText(path)}`;
    }
    const input = /^input\[(\d+)\](.*)$/.exec(path);
    if (input) return `第 ${Number(input[1]) + 1} 个 API input 项的 ${shortText(input[2].replace(/^\./, '') || '项目边界')}，路径 ${shortText(path)}`;
    return `路径 ${shortText(path)}`;
}

const unfinishedStatuses = new Set(['network-error', 'request-error', 'stream-error', 'aborted', 'cancelled', 'error', 'failed']);
const badCompletion = completion => completion === 'error' || completion === 'client-disconnected';
const isImported = record => record?.imported === true || record?.observationLevel === 'imported' || record?.reportedStatus != null;
const failedHTTP = status => status === 'http-error' || (typeof status === 'number' && status >= 400 && status <= 599);
function observedFailure(record) {
    const reported = record.reportedStatus != null;
    const status = reported ? record.reportedStatus : record.status;
    const code = typeof status === 'number' ? status : !reported && typeof record.httpStatus === 'number' ? record.httpStatus : !reported && typeof record.statusCode === 'number' ? record.statusCode : null;
    const imported = isImported(record);
    const qualification = imported ? '导入文件报告' : '';
    const unverified = imported ? '这只是导入文件的原状态，本插件未独立核实。' : '';
    if (status === 'observation-error') return `${qualification}这条记录的观察过程出错；仅凭观察失败不能断定上游生成失败或成功，也不能把这份不完整记录当作缓存命中证据。${unverified}费用仍需看 usage 或平台账单。`;
    if (failedHTTP(code) || status === 'http-error') return `${qualification}这条记录是 HTTP 请求失败${code === null ? '' : `（${code}）`}。${unverified}仍可分析已捕获的请求差异，但不能把它当成成功生成或缓存命中的实测结果；是否产生费用须看 usage 或平台账单。`;
    if (unfinishedStatuses.has(status) || badCompletion(record.completion)) return `${qualification}这条请求或流式响应未正常完成。${unverified}请求差异仍可供排查，缓存读取和费用应以可取得的 usage 或平台账单为准。`;
    return null;
}

function comparisonText(d, record) {
    const comparison = d?.comparison;
    const hasCurrent = record?.startedAt != null || record?.status != null;
    const hasPrevious = comparison && (comparison.previousStartedAt != null || comparison.previousStatus != null);
    const parts = [];
    if (hasCurrent) parts.push(`本次记录：${shortText(record.startedAt) || '时间未记录'}，状态 ${shortText(String(record.status ?? 'unknown'))}。`);
    if (record.reportedStatus != null) parts.push(`导入文件报告的原请求状态：${shortText(String(record.reportedStatus))}（未独立核实，不等于当前新请求的观测状态）。`);
    if (hasPrevious) {
        const imported = isImported(record);
        parts.push(`${imported ? '导入文件报告的' : ''}比较对象：${shortText(comparison.previousStartedAt) || '时间未记录'}，状态 ${shortText(String(comparison.previousStatus ?? 'unknown'))}。`);
        const previous = comparison.previousStatus;
        if (previous === 'observation-error') parts.push('比较对象的观察过程出错；不能用这份不完整记录证明生成成功、生成失败或已写入缓存。');
        else if (failedHTTP(previous)) parts.push(`${imported ? '文件将' : ''}比较对象${imported ? '标为' : '是'}一次失败请求；它可以用于比较已捕获的输入，但不能作为成功生成或已写入缓存的基线。`);
        else if (unfinishedStatuses.has(previous) || badCompletion(comparison.previousCompletion)) parts.push('比较对象未正常完成；已捕获的输入仍可比较，但不能作为成功生成或已写入缓存的基线。');
        if (imported) parts.push('比较对象的原状态也未经本插件独立核实。');
    }
    if ((hasCurrent && record.status == null) || (hasPrevious && comparison.previousStatus == null) || record.status === 'unknown' || comparison?.previousStatus === 'unknown') parts.push('状态未知的记录不能按成功请求处理。');
    return parts.join('');
}

/**
 * @param {object|null|undefined} d analyzePair result or compact archived diagnostic
 * @param {object} record observation record; archived=true denotes no retained raw prompt
 * @returns {string} Concise paragraphs suitable for textContent.
 */
export function diagnosticSummary(d, record = {}) {
    const parts = [];
    const archived = record?.archived === true || d?.archived === true;
    if (archived) parts.push('这是已存档的差异摘要。原始提示词未保存，无法从这份记录重新逐字比较；已保存的位置、长度和诊断标记仍可用于回顾。');
    const comparison = comparisonText(d, record);
    if (comparison) parts.push(comparison);
    const failure = observedFailure(record ?? {});
    if (failure) parts.push(failure);
    if (!d || typeof d !== 'object') {
        parts.push('尚无可比较的相邻请求。需要同一聊天、模型、用途、接口和观察层的两条完整上下文，才能定位最早差异。');
        return parts.join('\n\n');
    }
    const findings = Array.isArray(d.findings) ? d.findings : [];
    const codes = new Set(findings.map(f => f?.code ?? f?.type).filter(Boolean));
    if (d.comparable === false || codes.has('INCOMPARABLE_REQUEST_GROUP')) parts.push('这两条记录的聊天、模型、用途、接口或观察层不同。以下只能描述内容差异，不能据此判断同一缓存为什么未命中。');

    const first = d.firstDifference && typeof d.firstDifference === 'object' ? d.firstDifference : null;
    const stable = finiteCount(d.stablePrefixCharacters) ? d.stablePrefixCharacters : finiteCount(d.stablePrefix?.characters) ? d.stablePrefix.characters : null;
    const path = first?.currentPath ?? first?.path ?? first?.previousPath;
    const kind = first?.kind;
    if (d.appendOnly === true || kind === 'append') {
        parts.push('已观察到的旧上下文保持一致，这次只在末尾追加了内容；这里没有发现旧前缀被重写。追加本身仍不能证明服务端已经读取缓存。');
    } else if (d.equal === true) {
        parts.push('两次已观察到的模型上下文在内容、角色和边界上保持一致。缓存参数、请求设置、TTL 与上游路由仍需单独检查，不能据此认定已命中。');
    } else if (first) {
        const where = locationText(path);
        if (kind === 'structure') {
            parts.push(`最早可确认的差异位于${where}，属于结构差异：可能涉及消息角色、内容类型、块边界或元数据。${first.offset === 0 ? 'offset=0 表示比较在这一段的起点停止，并不说明文字从第一个字就变了，也不能据此断定前面的历史被裁剪。' : '仅凭结构标记，不能断定前面的历史被裁剪。'}`);
        } else if (kind === 'removal') {
            parts.push(`旧请求中的后续内容在本次已观察上下文中不再存在，最早边界位于${where}。这说明观察结果缩短，具体是历史裁剪、组装方式还是来源变化，还需结合完整请求核对。`);
        } else {
            const at = finiteCount(first.offset) ? `；本段从 UTF-16 偏移 ${numberText(first.offset)} 处开始不同` : '';
            parts.push(`最早可确认的内容差异位于${where}${at}。这证明观察到的输入发生了变化，还不能确定它是零缓存读取的唯一原因。`);
        }
        if (!archived) {
            const sourceRows = [...(Array.isArray(first.sources) ? first.sources : []), ...(Array.isArray(first.previousSources) ? first.previousSources : [])];
            const labels = [...new Set(sourceRows.map(s => shortText(s?.label ?? s?.name ?? s?.id)).filter(Boolean))].slice(0, 3);
            if (labels.length) parts.push(`差异附近匹配到来源：${labels.join('、')}。文本匹配可能对应多个来源，不能仅凭名称确认负责的插件。`);
            else if (Array.isArray(first.sources) || Array.isArray(first.previousSources)) parts.push('差异处尚无确认的来源映射，不能仅凭这个位置确定是世界书、摘要还是其他插件造成的。');
        }
    } else if (d.notice) {
        parts.push(`当前还没有足够证据定位差异。${shortText(d.notice)}`);
    } else {
        parts.push('这份记录没有保存可定位的最早差异。需要完整相邻上下文或已有的差异摘要，不能从缺少字段推断缓存结果。');
    }

    if (stable !== null) parts.push(`本地连续一致的内容长度为 ${numberText(stable)} 个 UTF-16 代码单元；角色与块边界另行比较。这是字符长度口径，不是 tokens，也不是服务端实际缓存读取量。`);

    if (codes.has('SUMMARY_REWRITE')) parts.push('摘要诊断发现同一已识别来源的内容不再是旧内容的简单末尾追加。这只说明来源文本发生了改动，不能直接证明旧事件事实被改写、摘要插件每轮都重写，或它是唯一未命中原因。');
    else if (codes.has('SUMMARY_TEXT_CHANGED')) parts.push('带“摘要”标记的内容发生了变化；目前不能仅凭标记确认是哪一个摘要插件、是否改写了同一历史事件。');
    if (codes.has('RELATIVE_TIME_TEXT_CHANGED')) parts.push('两次文本出现的相对时间措辞不同。这不证明“5天前”和“上周二”指向同一事件或同一日期，需结合准确剧情日期核对，不能自动替换。');
    if (codes.has('SUMMARY_POSITION_MOVED')) parts.push('相同摘要文本出现在不同消息或内容块位置。位置移动已有文本证据，固定深度注入是否为原因仍需确认。');
    if (codes.has('STABLE_EXPLICIT_BREAKPOINT') || (Array.isArray(d.breakpoints) && d.breakpoints.some(b => b?.prefixUnchanged && b?.stillConfigured))) parts.push('至少一个已观察到的显式断点仍位于未变的前缀内，后部动态内容变化不必使这段前缀失效；是否实际复用仍要看服务商 usage。');
    if (codes.has('REQUEST_CONFIGURATION_CHANGED') || (Array.isArray(d.requestConfigurationChanges) && d.requestConfigurationChanges.length)) parts.push('面向模型的请求配置也有变化；其缓存影响取决于实际接口和模型，不能只由正文是否相同判断。');
    return parts.join('\n\n');
}
