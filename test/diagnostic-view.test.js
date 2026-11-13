import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticSummary } from '../adapters/diagnostic-view.js';

test('stable prefix uses UTF-16 length and does not claim tokens or cache hits', () => {
    const text = diagnosticSummary({ equal: true, comparable: true, stablePrefixCharacters: 66839 });
    assert.match(text, /66,839 个 UTF-16 代码单元/);
    assert.match(text, /不是 tokens，也不是服务端实际缓存读取量/);
    assert.match(text, /内容、角色和边界上保持一致/);
});

test('appended dialogue is explained as preserved old context, without proof of caching', () => {
    const text = diagnosticSummary({ appendOnly: true, firstDifference: { kind: 'append', currentPath: 'messages[4].content' }, stablePrefixCharacters: 17 });
    assert.match(text, /只在末尾追加/);
    assert.match(text, /不能证明服务端已经读取缓存/);
    assert.doesNotMatch(text, /旧请求中的后续内容/);
});

test('actual messages[21] structure difference names API message and qualifies offset zero', () => {
    const text = diagnosticSummary({ comparable: true, stablePrefixCharacters: 66839, firstDifference: { currentPath: 'messages[21].content', previousPath: 'messages[21].content', kind: 'structure', offset: 0 } }, { status: 'complete' });
    assert.match(text, /第 22 条 API 消息（数组索引 21，不是第 22 轮聊天）/);
    assert.match(text, /消息角色、内容类型、块边界或元数据/);
    assert.match(text, /offset=0 表示比较在这一段的起点停止/);
    assert.match(text, /不能据此断定前面的历史被裁剪/);
    assert.match(text, /66,839/);
    assert.doesNotMatch(text, /HTTP 请求失败/);
});

test('actual failed request messages[6] still diagnoses content but cannot stand in for success', () => {
    const text = diagnosticSummary({ firstDifference: { currentPath: 'messages[6].content', kind: 'content', offset: 19 }, stablePrefixCharacters: 123 }, { status: 'http-error', httpStatus: 400 });
    assert.match(text, /HTTP 请求失败（400）/);
    assert.match(text, /第 7 条 API 消息（数组索引 6，不是第 7 轮聊天）/);
    assert.match(text, /UTF-16 偏移 19/);
    assert.match(text, /是否产生费用须看 usage 或平台账单/);
    assert.match(text, /不能确定它是零缓存读取的唯一原因/);
});

test('summary and relative-date flags describe limited evidence, not same-event rewriting', () => {
    const text = diagnosticSummary({ firstDifference: { path: 'messages[2].content', kind: 'content' }, findings: [{ code: 'SUMMARY_REWRITE' }, { code: 'RELATIVE_TIME_TEXT_CHANGED' }, { code: 'SUMMARY_POSITION_MOVED' }] });
    assert.match(text, /不再是旧内容的简单末尾追加/);
    assert.match(text, /不能直接证明旧事件事实被改写/);
    assert.match(text, /不证明“5天前”和“上周二”指向同一事件或同一日期/);
    assert.match(text, /固定深度注入是否为原因仍需确认/);
});

test('archive accepts firstDifference.path and never implies raw prompt can be reconstructed', () => {
    const text = diagnosticSummary({ stablePrefixCharacters: 66, firstDifference: { path: 'messages[21].content', kind: 'structure', sources: [{ label: 'not retained as public summary' }] } }, { archived: true });
    assert.match(text, /原始提示词未保存/);
    assert.match(text, /已保存的位置、长度和诊断标记仍可用于回顾/);
    assert.match(text, /第 22 条 API 消息/);
    assert.doesNotMatch(text, /not retained as public summary/);
});

test('missing diagnostic and source-only notice do not invent difference evidence', () => {
    const empty = diagnosticSummary(null);
    assert.match(empty, /尚无可比较的相邻请求/);
    assert.doesNotMatch(empty, /长度为 0/);
    const notice = diagnosticSummary({ notice: '需要同一模型的两次请求。' });
    assert.match(notice, /还没有足够证据/);
    assert.match(notice, /需要同一模型的两次请求/);
});

test('incomparable groups and stable breakpoints are qualified instead of universal cache failure', () => {
    const text = diagnosticSummary({ comparable: false, firstDifference: { currentPath: 'system[1].text', kind: 'content' }, findings: [{ code: 'STABLE_EXPLICIT_BREAKPOINT' }, { code: 'REQUEST_CONFIGURATION_CHANGED' }] });
    assert.match(text, /不能据此判断同一缓存为什么未命中/);
    assert.match(text, /后部动态内容变化不必使这段前缀失效/);
    assert.match(text, /是否实际复用仍要看服务商 usage/);
    assert.match(text, /请求配置也有变化/);
});

test('summary is plain local text and does not mutate diagnostics or infer plugin identity', () => {
    const d = { firstDifference: { kind: 'content', currentPath: 'messages[0].content', sources: [{ label: '<script>not executed</script>' }, { label: '变量来源' }] }, findings: [] };
    const before = JSON.stringify(d), text = diagnosticSummary(d);
    assert.equal(JSON.stringify(d), before);
    assert.match(text, /文本匹配可能对应多个来源/);
    assert.match(text, /<script>not executed<\/script>/);
});

test('chronological predecessor error is displayed and cannot serve as a successful cache baseline', () => {
    const text = diagnosticSummary({ comparison: { previousStartedAt: '2026-11-12T07:00:00Z', previousStatus: 'http-error' }, stablePrefixCharacters: 66839, firstDifference: { currentPath: 'messages[21].content', kind: 'structure', offset: 0, sources: [], previousSources: [] } }, { startedAt: '2026-11-12T07:02:00Z', status: 'complete' });
    assert.match(text, /本次记录：2026-11-12T07:02:00Z，状态 complete/);
    assert.match(text, /比较对象：2026-11-12T07:00:00Z，状态 http-error/);
    assert.match(text, /比较对象是一次失败请求/);
    assert.match(text, /不能作为成功生成或已写入缓存的基线/);
    assert.match(text, /尚无确认的来源映射/);
    assert.doesNotMatch(text, /这条记录是 HTTP 请求失败/);
});

test('missing previous or current request status is explicitly unknown', () => {
    const text = diagnosticSummary({ comparison: { previousStartedAt: '2026-11-12T07:00:00Z' }, firstDifference: { path: 'messages[6].content', kind: 'content' } }, { startedAt: '2026-11-12T07:02:00Z' });
    assert.match(text, /本次记录：2026-11-12T07:02:00Z，状态 unknown/);
    assert.match(text, /比较对象：2026-11-12T07:00:00Z，状态 unknown/);
    assert.match(text, /状态未知的记录不能按成功请求处理/);
});

test('actual adapter request failures, stream failures and cancellation are not success baselines', () => {
    for (const status of ['request-error', 'network-error', 'stream-error', 'aborted', 'error', 'failed', 'cancelled']) {
        const text = diagnosticSummary({ comparison: { previousStatus: status }, notice: '未取得完整上下文' }, { status });
        assert.match(text, /这条请求或流式响应未正常完成/, status);
        assert.match(text, /比较对象未正常完成/, status);
        assert.match(text, /不能作为成功生成或已写入缓存的基线/, status);
    }
});

test('observation-error is an observation failure and does not assert the upstream failed', () => {
    const text = diagnosticSummary({ comparison: { previousStatus: 'observation-error' }, notice: '未取得完整上下文' }, { status: 'observation-error' });
    assert.match(text, /这条记录的观察过程出错/);
    assert.match(text, /不能断定上游生成失败或成功/);
    assert.match(text, /比较对象的观察过程出错/);
    assert.doesNotMatch(text, /比较对象是一次失败请求/);
});

test('completion errors qualify current and prior records even when status is otherwise complete', () => {
    const text = diagnosticSummary({ comparison: { previousStatus: 'complete', previousCompletion: 'error' } }, { status: 'complete', completion: 'error' });
    assert.match(text, /这条请求或流式响应未正常完成/);
    assert.match(text, /比较对象未正常完成/);
    const disconnected = diagnosticSummary({}, { status: 200, completion: 'client-disconnected' });
    assert.match(disconnected, /未正常完成/);
});

test('imported reportedStatus refers to the original unverified request, not a newly observed failure', () => {
    const text = diagnosticSummary({ comparison: { previousStatus: 'request-error' }, firstDifference: { path: 'messages[6].content', kind: 'content' } }, { status: 'imported', reportedStatus: 'http-error', imported: true, archived: true });
    assert.match(text, /状态 imported/);
    assert.match(text, /导入文件报告的原请求状态：http-error/);
    assert.match(text, /未独立核实，不等于当前新请求的观测状态/);
    assert.match(text, /导入文件报告这条记录是 HTTP 请求失败/);
    assert.match(text, /比较对象的原状态也未经本插件独立核实/);
});

test('numeric failing HTTP statuses are treated as failures, unlike informational and successful codes', () => {
    for (const status of [400, 429, 500, 599]) {
        const text = diagnosticSummary({ comparison: { previousStatus: status } }, { status });
        assert.match(text, /HTTP 请求失败/);
        assert.match(text, /比较对象是一次失败请求/);
    }
    for (const status of [100, 200, 204, 302]) assert.doesNotMatch(diagnosticSummary({}, { status }), /HTTP 请求失败/);
});
