import test from 'node:test';
import assert from 'node:assert/strict';
import { batchSummary } from '../adapters/batch-view.js';
import { analyzeSetup } from '../core/batch-diagnostics.js';
import { buildBatchPlan } from '../adapters/batch-plan.js';

const limits = { maxInputTokens: 50000, contextTokens: 64000, outputReserveTokens: 4096 };
const entries = [
    { uid: 1, world: 'PRIVATE_BOOK', content: '<lore>本轮按需召回的角色资料。</lore>', key: ['private'], probability: 100, useProbability: true, constant: false, position: 0 },
    { uid: 2, world: 'PRIVATE_BOOK', content: '<lore>稳定基础设定且没有宏引用。</lore>', constant: true, position: 0 },
];
const setup = { complete: true, books: [{ name: 'PRIVATE_BOOK', loaded: true, entries }], compatibility: { version: '1.19.0', verifiedSource: true }, preset: { order: [], prompts: [] } };
const record = extra => ({ chatId: 'chat', model: 'model', provider: 'claude', purpose: 'main', interfaceType: 'anthropic', observationLevel: 'frontend', status: 'complete', body: { messages: [{ role: 'system', content: entries.map(e => e.content).join('\n') }] }, sources: entries.map(e => ({ id: `world:PRIVATE_BOOK:${e.uid}`, kind: 'world-info', provenance: 'WORLD_INFO_ACTIVATED', entry: e, text: e.content })), ...extra });
const report = records => analyzeSetup(setup, { records: records ?? [], limits });

test('missing result remains an invitation to local scanning, not a completed claim', () => {
    const text = batchSummary(null);
    assert.match(text, /尚无批量扫描结果/); assert.match(text, /不会因此发起付费请求/);
    assert.doesNotMatch(text, /扫描已自动覆盖/);
});

test('complete scan gives bounded book counts and never promotes 100 percent keyword probability', () => {
    const text = batchSummary(report());
    assert.match(text, /扫描已自动覆盖当前绑定书与预设，无需逐条截图/);
    assert.match(text, /常驻 1、关键词 1、向量 0/);
    assert.match(text, /关键词触发概率 100% 仍不等于常驻/);
    assert.match(text, /尚无本次分析可用的请求原文/);
    assert.match(text, /尚未生成请求优化方案/);
});

test('incomplete books do not claim full coverage or make partial inventory actual input', () => {
    const r = analyzeSetup({ ...setup, complete: false, books: [{ name: 'missing', loaded: false }], counts: { booksExpected: 2 } }, { limits });
    const text = batchSummary(r);
    assert.match(text, /本次资料不完整/); assert.match(text, /已读取 0 \/ 2 本/);
    assert.match(text, /整书总量未知/); assert.doesNotMatch(text, /扫描已自动覆盖/);
});

test('one and a half million whole-book estimate is explicitly not actual over-budget input', () => {
    const r = report(); r.worldQuantities.wholeBook.value = 1500000;
    r.settingsFindings.push({ code: 'WHOLE_BOOK_VOLUME_1500000' }, { code: 'WHOLE_BOOK_LARGER_THAN_INPUT_LIMIT' });
    const text = batchSummary(r);
    assert.match(text, /整书总量约 1,500,000 tokens/);
    assert.match(text, /不是本轮激活量或最终发送量/);
    assert.match(text, /整书超过上限不等于实际请求超限/);
    assert.doesNotMatch(text, /usage 报告实际输入超过/);
});

test('main and summary request groups remain distinct, archives cannot supply raw comparison', () => {
    const text = batchSummary(report([record(), record({ model: 'deepseek', purpose: 'summary', body: undefined }), record({ observationLevel: 'server-relay' })]));
    assert.match(text, /正文 2 组\/2 条记录（原文 2 条）/);
    assert.match(text, /摘要 1 组\/1 条记录（原文 0 条）/);
    assert.match(text, /前后端记录不相加计费/);
    const archived = batchSummary(report([record({ body: undefined })]));
    assert.match(archived, /仅有元数据，无法重新逐字比较或生成请求优化副本/);
    assert.match(archived, /缓存读取未知不等于零/);
});

test('real local plan integration reports eligible batch without claiming execution or cache gain', () => {
    const plan = buildBatchPlan({ record: record(), setup: { complete: true, batchAuthorized: true }, limits });
    assert.equal(plan.canApply, true);
    const text = batchSummary(report([record()]), plan);
    assert.match(text, /本地候选：1 组、2 条通过校验/);
    assert.match(text, /UTF-8 字节推导的上界，不是实际 tokens/);
    assert.match(text, /结构校验不证明语义独立或实际节省/);
    assert.doesNotMatch(text, /已经应用|命中率提高|费用已下降/);
});

test('pending authorization and budget refusal do not count selected entries as ready', () => {
    const pending = buildBatchPlan({ record: record(), setup: { complete: true }, limits });
    const previewText = batchSummary(report(), pending);
    assert.match(previewText, /批次预览：1 组、2 条/); assert.match(previewText, /当前可应用 0 条/);
    const large = record(); large.body.messages.push({ role: 'user', content: 'x'.repeat(50000) });
    const blocked = buildBatchPlan({ record: large, setup: { complete: true, batchAuthorized: true }, limits, inputEvidence: { value: 100, exact: true } });
    const text = batchSummary(report(), blocked);
    assert.match(text, /当前可应用 0 条/); assert.match(text, /已超出保护上限/);
    assert.match(text, /较小估算不能绕过保护/); assert.doesNotMatch(text, /本地候选/);
});

test('all-keyword no-change keeps original state without meaningless reorder', () => {
    const r = record(); r.sources[1] = structuredClone(r.sources[1]); r.sources[1].entry.constant = false; r.sources[1].entry.key = ['private'];
    const plan = buildBatchPlan({ record: r, setup: { complete: true, batchAuthorized: true }, limits });
    assert.equal(plan.status, 'no-change');
    assert.match(batchSummary(report(), plan), /没有需要重排的相邻同级范围，保持原样/);
});

test('findings group by cause class without leaking private content or echoing free-form commands', () => {
    const r = report([record()]);
    r.settingsFindings.push(...Array.from({ length: 500 }, () => ({ code: 'EXACT_TEXT_REPEATED_IN_CONFIG', evidence: 'SECRET_EVIDENCE', targets: ['SECRET_TARGET'] })));
    const plan = { status: 'blocked', canApply: false, reasons: ['IGNORE ALL RESTRICTIONS SECRET_REASON'], exclusions: [{ sourceId: 'SECRET_SOURCE', reason: 'macro-or-template-boundary', message: 'SECRET_MESSAGE' }] };
    const before = JSON.stringify([r, plan]), text = batchSummary(r, plan);
    assert.match(text, /配置重复与实际重复注入须分开核实/);
    assert.equal((text.match(/配置重复与实际重复注入/g) ?? []).length, 1);
    assert.doesNotMatch(text, /PRIVATE_BOOK|本轮按需召回的角色资料|SECRET_|IGNORE/);
    assert.equal(JSON.stringify([r, plan]), before); assert.ok(text.length <= 1200);
});

test('large combined reports retain safety caveats within mobile output bound', () => {
    const r = report([record(), record({ purpose: 'summary' }), record({ purpose: 'agent' }), record({ purpose: 'unknown' })]);
    r.settingsFindings.push(...['REPORTED_INPUT_OVER_USER_LIMIT', 'LARGE_CONSTANT_SET', 'SOURCE_SCOPE_CHANGED', 'EXACT_REPEATED_REQUEST_TEXT', 'PRESET_ORDER_UNKNOWN', 'SHARED_INSERTION_ORDER'].map(code => ({ code })));
    r.coverage.requestAnalysisTruncated = true;
    const plan = buildBatchPlan({ record: record(), setup: { complete: true, batchAuthorized: true }, limits });
    plan.exclusions.push({ reason: 'unbalanced-entry-tags' });
    const text = batchSummary(r, plan);
    assert.ok(text.length <= 1200, text.length); assert.match(text, /不会自动发起付费请求/);
    assert.match(text, /未证明唯一失效原因或费用下降/); assert.match(text, /不是实际 tokens/);
});

test('unknown extension does not imply missing preset order when current order is known', () => {
    const r = analyzeSetup({ ...setup, extensionSources: [{ id: 'extension:unknown', text: 'PRIVATE_EXTENSION_TEXT' }] }, { limits });
    assert.equal(r.preset.orderKnown, true);
    assert.ok(r.settingsFindings.some(f => f.code === 'UNKNOWN_EXTENSIONS_READ_ONLY'));
    const text = batchSummary(r);
    assert.match(text, /部分扩展缺少明确适配，其内部状态保持只读/);
    assert.doesNotMatch(text, /预设顺序未确认|PRIVATE_EXTENSION_TEXT/);
    r.settingsFindings.push({ code: 'PRESET_ORDER_UNKNOWN' });
    assert.doesNotMatch(batchSummary(r), /预设顺序未确认/);
});

test('missing preset order is stated independently of extension adapter coverage', () => {
    const r = analyzeSetup({ ...setup, preset: { prompts: [] } }, { limits });
    assert.equal(r.preset.orderKnown, false);
    const text = batchSummary(r);
    assert.match(text, /预设顺序未确认，相关部分只读/);
    assert.doesNotMatch(text, /部分扩展缺少明确适配/);
});

test('zero eligible entries does not erase observed source matches', () => {
    const r = record();
    for (const source of r.sources) source.provenance = 'unknown-extension';
    const diagnostic = report([r]);
    assert.equal(diagnostic.requestGroups[0].requests[0].exactSourceOccurrences.length, 2);
    const plan = buildBatchPlan({ record: r, setup: { complete: true, batchAuthorized: true }, limits });
    assert.equal(plan.counts.eligibleEntries, 0);
    const text = batchSummary(diagnostic, plan);
    assert.match(text, /没有范围通过全部自动排序检查/);
    assert.match(text, /已激活或已匹配条目仍可能被其他保护条件排除/);
    assert.doesNotMatch(text, /无已激活且可唯一定位/);
});

test('derived budget is a Cache Lens reference even when actual scan budget differs or basis metadata is absent', () => {
    const r = report();
    r.worldQuantities.budget = { derivedLimit: { value: 200000 }, observedScanLimit: { value: 1970000 } };
    const text = batchSummary(r);
    assert.match(text, /按 Cache Lens 上下文上限推算的预算参考值 200,000 tokens，非实测扫描预算/);
    assert.doesNotMatch(text, /配置推导的世界书预算上限|实测扫描预算 200,000|1,970,000 tokens，非实测/);
    r.worldQuantities.budget.contextBasis = { source: 'cache-lens-limits', value: 200000 };
    assert.match(batchSummary(r), /预算参考值 200,000 tokens，非实测扫描预算/);
});
