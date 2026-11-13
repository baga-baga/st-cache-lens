import { OPENAI_STARTER, agentSetupError } from './adapters/agent-setup.js';
import { applyPolicyTransaction, rollbackPolicyTransaction, recoverPolicyIntent, advanceHistoryAfterRollback, rebasePolicyHistory } from './adapters/relay-control.js';
import { installSTAdapter } from './adapters/st.js';
import { createBrowserStateStore } from './adapters/state-store.js';
import { createObservationStore } from './adapters/observation-store.js';
import { diagnosticSummary } from './adapters/diagnostic-view.js';
import { collectCurrentSetup, getSetupInputs } from './adapters/batch-scan.js';
import { analyzeSetup } from './core/batch-diagnostics.js';
import { buildBatchPlan } from './adapters/batch-plan.js';
import { batchSummary } from './adapters/batch-view.js';
import { summarizeBatchPlan, formatPlanRejections } from './adapters/batch-plan-report.js';
import { runBatchPolicy, EMPTY_BATCH_POLICY, BATCH_ALGORITHM } from './adapters/batch-runner.js';
import { observationLayer, ledgerRecords, pricesFor, agentObservation, trialInput, compactDiagnostic, agentPayload, acceptedAgentProposal, agentConfigWithBudget, validatePriceTable, optionalCachePrices, redactedExport, importEvidence } from './adapters/reporting.js';
import { hasObservedContext, normalizeUISources, worldSummary } from './adapters/ui-data.js';
import { eligibleSources, localCandidate, transformWithProfile } from './adapters/pipeline.js';
import { analyzePair, diagnoseDuplicates, diagnoseWorldInfo, estimateTokens, projectContext, requestGroupKey } from './core/diagnostics.js';
import { normalizeUsage, calculateCost, summarizeUsage } from './core/usage.js';
import { createProfile, createOptimizationState, previewProposal, applyProposal, rollback, stableStringify } from './core/optimizer.js';
import { PROVIDER_RULES, hasUnsupportedContent } from './core/providers.js';
import { createMemoryLedger, appendMemory, renderMemory } from './core/memory.js';

const KEY = 'cache_lens';
const defaults = { mode: 'diagnose', maxInputTokens: 160000, contextTokens: 200000, outputReserveTokens: 8192, maxTests: 0, maxCost: 0, currency: 'USD', rules: [], prices: {}, state: null, memory: null, relayHistory: [], baselineIds: [], batchFollow:false, batchPolicy:EMPTY_BATCH_POLICY, batchHistory:[], batchRevision:0 };
const clone = v => structuredClone(v);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const display = v => v === null || v === undefined ? '未知' : typeof v === 'number' ? v.toLocaleString('zh-CN', {maximumFractionDigits: 6}) : String(v);
const purposeLabel = {main:'正文', summary:'摘要', agent:'优化 Agent', unknown:'待归类'};
const $ = (root, s) => root.querySelector(s);
const json = v => JSON.stringify(v, null, 2);
const MAX_RECORDS = 30;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export function mountCacheLens({ context = globalThis.SillyTavern?.getContext?.(), host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings'), adapterFactory = installSTAdapter, storageNamespace = null, storage = globalThis.localStorage, locks = globalThis.navigator?.locks, setupCollector = async args => collectCurrentSetup(await getSetupInputs(args)) } = {}) {
  if (!context || !host) return null;
  if (document.getElementById('cache-lens-panel')) return null;
  const settings = { ...clone(defaults), ...clone(context.extensionSettings?.[KEY] || {}) };
  let records = [], billingRecords = [], sources = [], world = {}, selectedId = null, inFlight = 0, draft = null, preview = null, captured = [], lastPreviewState = null, serverStatus = null, busy = false;
  let opt = settings.state || createOptimizationState(createProfile({mode:'preview',limits:limits()}));
  let memory = settings.memory || createMemoryLedger();
  let adapter, store = null, stateReady = false, savedSnapshot = null, capturedBinding = null, pendingAutoRecord = null, lastAutoRecordId = null;
  let actionQueue = Promise.resolve(), disposed = false;
  let observationStore = null, archiveEnabled = false, archiveWrites = Promise.resolve();
  let batchSetup=null,batchReport=null,batchPlan=null,batchRecordId=null,batchTimer=null,batchDirty=false,batchScanning=false,batchEpoch=0,lastBatchResult=null;
  const batchListeners=[];
  let committedSettings = clone({...settings,state:opt,memory});
  let externalSnapshot = stableStringify(context.extensionSettings?.[KEY] ?? null);
  const root = document.createElement('section');root.id = 'cache-lens-panel'; root.className = 'cl-panel';
  root.innerHTML = `
  <details open><summary><strong>Cache Lens</strong> <span class="cl-badge">0.1.4</span> 缓存与费用观察</summary>
  <p class="cl-note">只根据已观察证据诊断。前端相同不等于上游命中；正文、摘要和 Agent 单独计费。</p>
  <div class="cl-status" data-id="status" role="status">正在初始化</div>
  <details open class="cl-quick"><summary>一键批量诊断 · 从这里开始</summary>
    <button data-action="batch-scan">扫描当前角色全部配置（免费）</button>
    <label><input type="checkbox" data-id="batchFollow">自动跟随切卡、预设变化和正常请求重新扫描（免费）</label>
    <p class="cl-note">一次读取当前绑定的世界书、当前预设和记忆来源，自动汇总问题。扫描不生成剧情，也不调用优化模型。</p>
    <div data-id="batchSummary" class="cl-diagnostic-summary">点击扫描即可开始，无需逐条找条目或截图。</div>
    <div data-id="batchBlockers" class="cl-note"></div>
    <div class="cl-toolbar"><button data-action="batch-mark-main" hidden>将当前连接的未归类请求标为正文</button><button data-action="batch-enable">启用跨角色安全排序</button><button data-action="batch-rollback">恢复上一批量设置</button><button data-action="batch-export">导出设置报告（无正文）</button><button data-action="batch-agent">让 Agent 复核报告（按预算计费）</button></div>
    <p class="cl-note">启用排序表示一次授权：在当前正文接口与模型下，后续角色逐请求检查已激活的完整世界书片段，仅在同一消息、同一作用范围内将合格的常驻资料前置。原书触发与排序字段保持原值。结构校验不证明剧情语义或真实节省；没有可用方案或输入上界无法通过时自动跳过。</p>
    <div data-id="batchPolicy" class="cl-status"></div><div data-id="batchAgent" class="cl-note"></div>
    <details><summary>本次排序前后（仅本机，不含正文）</summary><pre data-id="batchPreview"></pre></details>
    <details><summary>批量设置报告（含条目名称，不含正文）</summary><pre data-id="batchDetails"></pre></details>
  </details>
  <div class="cl-grid">
    <label>运行模式<select data-id="mode"><option value="diagnose">只诊断</option><option value="preview">预览后应用</option><option value="automatic">受约束自动优化</option></select></label>
    <label>单轮输入上限<input data-id="maxInput" type="number" min="1"></label>
    <label>上下文上限<input data-id="context" type="number" min="1"></label>
    <label>输出预留<input data-id="reserve" type="number" min="0"></label>
    <label>额外调用次数上限<input data-id="maxTests" type="number" min="0"></label>
    <label>额外调用费用上限<input data-id="maxCost" type="number" min="0" step="0.01"></label>
  </div><button data-action="save">保存边界</button>
  <p class="cl-note">额外预算只授权 Agent；此版本不会自动生成付费正文测试。正常游玩费用照常记录。输入保护约束优化副本；不会拦截你的原始剧情请求。</p>
  <details><summary>用途映射与价格</summary>
    <p>用途不能靠模型名猜测。请明确指定你的接口来源及完整模型 ID。</p>
    <div class="cl-grid"><label>接口来源<input data-id="ruleProvider" placeholder="claude / deepseek / custom"></label><label>完整模型 ID<input data-id="ruleModel" placeholder="以实际请求为准"></label><label>用途<select data-id="rulePurpose"><option value="main">正文</option><option value="summary">摘要</option></select></label></div>
    <button data-action="add-rule">添加明确用途规则</button><pre data-id="rules"></pre>
    <label>价格 JSON（每百万 tokens；币种、来源、更新时间必填）<textarea data-id="prices" rows="7" spellcheck="false"></textarea></label>
    <p class="cl-note">键为 provider:model 或完整 model。字段 input/cacheRead/cacheWrite/cacheWrite5m/cacheWrite1h/output；Responses 另支持 cacheWrite30m/cacheWrite12h。未知价格不按零收费。</p>
    <button data-action="save-prices">保存价格</button>
  </details>
  <div class="cl-toolbar"><button data-action="refresh">刷新服务端观察</button><button data-action="export">导出脱敏诊断</button><button data-action="import">导入请求 / usage / 账单</button><button data-action="clear">清空观察与本机存档</button></div>
  <p class="cl-note" data-id="archiveStatus" role="status">正在读取本机脱敏存档。原始提示词只在当前页面内存中保留。</p>
  <input type="file" accept=".json" data-id="file" hidden>
  <div data-id="ledger" class="cl-scroll"></div>
  <p class="cl-note">读取比例＝缓存读取 / 全部输入，仅统计 usage 完整的请求；未知项不按零。费用为配置价格计算值；平台账单另列。前端和 relay 分层显示，避免同一请求重复合计。</p>
  <div class="cl-grid"><label>观察层<select data-id="layer"><option value="frontend">前端</option><option value="relay">服务端 relay</option><option value="import">导入证据</option></select></label><label>选择请求<select data-id="record"></select></label><label>更正此请求用途<select data-id="purpose"><option value="unknown">待归类</option><option value="main">正文</option><option value="summary">摘要</option><option value="agent">优化 Agent</option></select></label></div>
  <div data-id="facts" class="cl-facts"></div>
  <details open><summary>最早差异、稳定前缀与来源</summary><div data-id="differenceSummary" class="cl-diagnostic-summary"></div><details><summary>技术详情（本机原文片段）</summary><pre data-id="difference"></pre></details></details>
  <details><summary>当前请求 / usage / 来源（仅本机显示）</summary><pre data-id="request"></pre></details>
  <details><summary>世界书：整书、预算、激活、发送</summary><div class="cl-toolbar"><select data-id="book"></select><button data-action="inspect-book">读取所选世界书</button></div><pre data-id="world"></pre><p class="cl-note">整书读取不等于注入。最终发送量只接受明确证据，无法归因时显示未知；触发、递归、分组、概率和预算保持原状。</p></details>
  <details open><summary>优化副本与完整回滚</summary>
    <p>先在一次正文请求后捕获可定位的世界书 / 预设片段。只可重排同一消息中相邻且独立的完整片段。确认独立表示它们的相对顺序不承担指令作用域或剧情顺序。</p>
    <button data-action="capture">从当前请求提取候选片段</button><div data-id="fragments"></div>
    <div class="cl-toolbar"><button data-action="copy">建立优化副本</button><button data-action="candidate">本地生成排序方案</button><button data-action="agent">调用 Agent 提案</button></div>
    <label>结构化方案<textarea data-id="proposal" rows="7" spellcheck="false" placeholder="本地或 Agent 生成，所有方案均经过本地确定性校验"></textarea></label>
    <div class="cl-toolbar"><button data-action="preview">校验与离线试算</button><button data-action="apply">应用到优化副本</button><button data-action="rollback">恢复本轮修改</button><button data-action="restore">恢复优化前</button></div>
    <pre data-id="preview"></pre><pre data-id="history"></pre>
    <p class="cl-note">原世界书 / 预设文件不被覆盖。应用后只在下次请求的副本中重排字节完全匹配的片段；来源改变或不可匹配就跳过，不会冻结动态状态。标签、宏、角色、条目触发和预算均保留。</p>
  </details>
  <details><summary>真实观察评估与剧情质量</summary><button data-action="baseline">将当前观察设为基线</button><button data-action="evaluate">比较后续正常游玩</button><label>剧情质量<select data-id="quality"><option value="unknown">尚未评价</option><option value="pass">连续性、事实和秘密条件正常</option><option value="fail">出现剧情退化</option></select></label><pre data-id="evaluation"></pre><p class="cl-note">相同模型 / 用途和币种的可比窗口才作比较。缺 usage 或价格时不宣布节省。无改善或质量退化会停用自动优化，质量退化恢复优化前副本。</p></details>
  <details><summary>稳定记忆适配（独立，可选）</summary><p>现有第三方摘要保持只读。本插件提供追加式记忆台账供明确适配器读取；不会重复注入它，也不自动改写旧摘要。</p><div class="cl-grid"><label>事件 ID<input data-id="eventId"></label><label>准确剧情日期（ISO）<input data-id="eventDate" placeholder="2026-11-12"></label><label>原相对时间措辞<input data-id="eventRelative" placeholder="5天前（原文保留）"></label></div><label>已确认事件<textarea data-id="eventText" rows="2"></textarea></label><button data-action="append-memory">追加事件</button><button data-action="export-memory">导出记忆与档案</button><pre data-id="memory"></pre></details>
  <details data-id="agentSection"><summary>优化 Agent · 连接与模型设置</summary>
    <p>按顺序操作：检查服务端 → 填写接口和密钥 → 检查连接 → 设置预算并保存。</p>
    <div class="cl-toolbar"><button data-action="check-server">1. 检查服务端</button><button data-action="preset-openai">2. 一键填写 OpenAI</button></div>
    <div data-id="agentConnection" class="cl-status" role="status">尚未检查。只安装前端扩展时，还需要安装一次服务端组件。</div>
    <details><summary>提示服务端未安装时，怎么处理？</summary><p>先停止酒馆，在 Termux 或电脑终端进入酒馆根目录，执行：</p><code>node data/default-user/extensions/st-cache-lens/scripts/install.mjs --st . --server</code><p>随后在酒馆根目录 config.yaml 中设置 enableServerPlugins: true，再启动酒馆。已安装服务端的用户更新后也执行同一命令。其他用户目录和全局安装见仓库说明。</p></details>
    <div class="cl-grid cl-agent-grid">
      <label class="cl-wide">接口<select data-id="agentType"><option value="openai">OpenAI Chat Completions 兼容</option><option value="anthropic">Anthropic Messages</option></select></label>
      <label class="cl-wide">完整 API 地址<input data-id="agentEndpoint" type="url" placeholder="https://api.openai.com/v1/chat/completions" spellcheck="false"></label>
      <label class="cl-wide">模型<input data-id="agentModel" placeholder="例如 gpt-6.1-terra" spellcheck="false"></label>
      <label class="cl-wide">API 密钥<input data-id="agentKey" type="password" autocomplete="off" placeholder="只在这里填写；留空保留同地址已保存密钥"></label>
    </div>
    <p class="cl-note">密钥只发送给同源酒馆服务端，不写进前端设置或导出。检查连接只读取模型信息，不发送剧情、不生成内容；不能据此保证余额充足或生成成功。</p>
    <button data-action="check-agent">3. 检查连接与模型（不生成）</button>
    <div class="cl-grid">
      <label>Agent 调用次数上限<input data-id="agentCalls" type="number" min="0" placeholder="未授权时为 0"></label>
      <label>Agent 总费用上限<input data-id="agentCost" type="number" min="0" step="0.01" placeholder="未授权时为 0"></label>
      <label>币种<input data-id="currency" value="USD"></label><label>最大输出 tokens<input data-id="agentOutput" type="number" value="1024" min="64" max="8192"></label>
    </div>
    <p class="cl-note">预算默认 0，连接检查不需要付费预算。由你填写上限后才允许调用 Agent；保存不会立即调用模型。</p>
    <details><summary>价格与高级选项（OpenAI 一键填写已包含价格）</summary>
      <p class="cl-note">OpenAI 预设使用 2026-11-12 核对的标准价格快照，之后可按服务商实际价格更新。中转价格须自行填写。</p>
      <div class="cl-grid"><label>输入价 / 百万<input data-id="agentInputPrice" type="number" min="0" step="0.001"></label><label>输出价 / 百万<input data-id="agentOutputPrice" type="number" min="0" step="0.001"></label><label class="cl-wide">价格来源<input data-id="agentPriceSource" placeholder="服务商价目表 URL"></label><label>价格更新时间<input data-id="agentPriceDate" type="date"></label><label>推理强度<select data-id="agentReasoning"><option value="default">模型默认</option><option value="none">none</option><option value="low">low（起步配置）</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label><label>输出限制参数<select data-id="agentTokenParameter"><option value="auto">自动（按实际接口）</option><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens</option></select></label></div>
      <label>可选缓存价格 JSON<textarea data-id="agentCachePrices" rows="2" placeholder='{"cacheRead":0.05}'></textarea></label>
      <label><input data-id="agentLocal" type="checkbox">显式允许本机回环 API</label>
    </details>
    <button data-action="save-agent">4. 保存配置与预算（不调用模型）</button>
    <div data-id="agentStatus" class="cl-status" role="status">尚未保存。默认只上传诊断计数、差异类型、片段 ID 和设置，不上传整本世界书。</div>
  </details>
  <details><summary>服务端实际请求与缓存断点</summary><p>安装并启动本地 relay 后，将酒馆该连接的 reverse proxy 指向它。relay 只能证明它实际发送的请求，中转内部二次转换仍不可见。</p><div class="cl-grid"><label>观察器 ID<input data-id="observerId" value="main" placeholder="main 或 summary"></label><label>relay 地址<input data-id="relayURL" value="http://127.0.0.1:8937"></label><label>本地 relay 令牌<input data-id="relayToken" type="password" autocomplete="off"></label></div><button data-action="save-observer">连接本地观察器</button><button data-action="load-policy">读取当前断点策略</button><label>策略 JSON<textarea data-id="policy" rows="8" spellcheck="false"></textarea></label><div class="cl-toolbar"><button data-action="draft-policy">从两次实际请求提取稳定 system 前缀</button><button data-action="apply-policy">应用已核实接口的断点策略</button><button data-action="rollback-policy">恢复上一断点策略</button><button data-action="recover-policy">恢复未完成的策略事务</button></div><label><input type="checkbox" data-id="verifiedEndpoint">我已核对当前上游确实支持该 Anthropic Messages 缓存规则（包括中转兼容性）</label><pre data-id="policyStatus"></pre></details>
  </details>`;
  host.append(root);
  function limits() { return {maxInputTokens:Number(settings.maxInputTokens),contextTokens:Number(settings.contextTokens),outputReserveTokens:Number(settings.outputReserveTokens)}; }
  function value(id) { return $(root, `[data-id="${id}"]`).value; }
  function set(id, val) { $(root, `[data-id="${id}"]`).value = val ?? ''; }
  function out(id, val) { $(root, `[data-id="${id}"]`).textContent = typeof val === 'string' ? val : json(val); }
  function status(message, error = false) { const el=$(root,'[data-id="status"]');el.textContent=message;el.classList.toggle('cl-error',error); }
  function syncBoundaryInputs() {
    for(const [key,id]of [['mode','mode'],['maxInputTokens','maxInput'],['contextTokens','context'],['outputReserveTokens','reserve'],['maxTests','maxTests'],['maxCost','maxCost'],['maxTests','agentCalls'],['maxCost','agentCost'],['currency','currency']])set(id,settings[key]);
  }
  function restoreCommitted() {
    for(const key of Object.keys(settings)) delete settings[key];
    Object.assign(settings,clone(committedSettings));opt=clone(settings.state);memory=clone(settings.memory);syncBoundaryInputs();
  }
  function assertIdle() { if(inFlight || busy || adapter?.getSnapshot?.().generation) throw new Error('请求或提示词组装进行中；本轮配置已锁定。'); }
  function assertFresh() {
    if(!stateReady || !store)throw new Error('持久化状态尚未就绪；当前仅可诊断。');
    if(!store.matches(savedSnapshot) || stableStringify(context.extensionSettings?.[KEY] ?? null)!==externalSnapshot)throw new Error('配置已在其他窗口或插件改变，请刷新后重新预览。');
  }
  async function persist() {
    try {
      assertFresh();
      const next=clone({...settings,state:opt,memory});
      const saved=await store.compareAndSwap(savedSnapshot,next,{guard(){assertIdle();if(stableStringify(context.extensionSettings?.[KEY] ?? null)!==externalSnapshot)throw new Error('保存前检测到其他插件修改。');}});
      if(!saved)throw new Error('并发更新冲突：未覆盖另一窗口的配置，请刷新。');
      committedSettings=next;savedSnapshot=stableStringify(next);
      Object.assign(settings,clone(next));opt=clone(next.state);memory=clone(next.memory);
      context.extensionSettings[KEY]=clone(next);externalSnapshot=stableStringify(context.extensionSettings[KEY]);
      try {context.saveSettingsDebounced?.();}catch{status('本机持久化已完成；酒馆设置镜像暂未保存。',true);}
    } catch(error) {restoreCommitted();render();throw error;}
  }
  const liveContext=()=>globalThis.SillyTavern?.getContext?.()||context;
  const batchConnection=()=>batchSetup?.binding;
  function batchCurrentRecord(setup=batchSetup) {
    const b=setup?.binding;if(!b)return null;
    return [...records].reverse().find(r=>r.observationLevel==='frontend'&&r.purpose==='main'&&r.status==='complete'&&hasObservedContext(r)&&r.chatId===b.chatId&&r.model===b.model&&r.provider===b.provider&&!r.imported&&!r.synthetic)||null;
  }
  function renderBatch() {
    $(root,'[data-id="batchFollow"]').checked=settings.batchFollow===true;
    out('batchSummary',batchReport?batchSummary(batchReport,batchPlan):'点击扫描即可读取当前绑定的全部设置，无需逐条找条目或截图。');
    out('batchBlockers',batchPlan?formatPlanRejections(batchPlan,batchReport):'');
    const p=settings.batchPolicy;
    out('batchPolicy',p?.enabled?`批量策略 v${p.version} 已启用：${p.connection?.provider} / ${p.connection?.model}。当前模式：${settings.mode==='diagnose'?'只诊断，排序暂停':'允许已校验请求副本排序'}。${lastBatchResult?'\n最近一次检查：'+lastBatchResult.reason:''}`:'批量排序未启用；当前只读扫描不会修改剧情输入。');
    const b=batchConnection();
    $(root,'[data-action="batch-mark-main"]').hidden=!b||b.provider==='unknown'||b.model==='unknown'||!records.some(r=>r.observationLevel==='frontend'&&r.chatId===b.chatId&&r.provider===b.provider&&r.model===b.model&&r.purpose==='unknown');
    const names=new Map((batchPlan?.profile?.blocks||[]).map(block=>[block.id,String(block.source?.name||block.id).slice(0,80)]));
    out('batchPreview',batchPlan?.groups?.length?batchPlan.groups.map((group,i)=>`第 ${i+1} 组（${group.role} / ${group.scope}）\n原顺序：${group.before.map(id=>names.get(id)||id).join(' → ')}\n新顺序：${group.after.map(id=>names.get(id)||id).join(' → ')}`).join('\n\n').slice(0,12000)+'\n\n正文增删：0；原书设置修改：0。仅为离线候选，是否允许应用见上方校验结果。':'没有待预览的合格排序范围。');
  }
  async function readBatchSetup() {return setupCollector({context:liveContext(),snapshot:adapter?.getSnapshot?.(),getContext:liveContext});}
  async function scanBatch({follow=false}={}) {
    assertIdle();batchScanning=true;batchDirty=false;const scanEpoch=batchEpoch;
    out('batchSummary','正在读取当前绑定的世界书、预设和扩展来源；不会生成模型请求。');
    try {
      const setup=await readBatchSetup();assertIdle();if(disposed||scanEpoch!==batchEpoch)return null;
      const report=analyzeSetup(setup,{records,limits:limits()});
      const r=batchCurrentRecord(setup);
      const candidate=buildBatchPlan({record:r,setup:{...setup,batchAuthorized:true},limits:limits()});
      const requestRef=report.requestGroups.flatMap(group=>group.requests).find(item=>item.id===r?.id)?.ref;
      report.candidate={...summarizeBatchPlan(candidate,report),requestRef:/^r\d+$/.test(requestRef||'')?requestRef:null};
      batchSetup=setup;batchReport=report;batchPlan=candidate;batchRecordId=r?.id??null;
      out('batchDetails',report);out('batchAgent','');
      if(follow&&!settings.batchFollow){settings.batchFollow=true;await persist();}
      renderBatch();return report;
    } finally {batchScanning=false;if(batchDirty)queueBatchScan();}
  }
  function queueBatchScan({invalidate=false}={}) {
    if(invalidate){batchEpoch++;batchSetup=null;batchReport=null;batchPlan=null;batchRecordId=null;out('batchDetails','配置或角色已改变，旧报告已失效。');renderBatch();}
    if(disposed||settings.batchFollow!==true)return;
    batchDirty=true;clearTimeout(batchTimer);
    batchTimer=setTimeout(()=>{
      if(disposed||!batchDirty||batchScanning||inFlight||busy||adapter?.getSnapshot?.().generation)return;
      actionQueue=actionQueue.then(async()=>{await ready;if(disposed||!batchDirty||batchScanning||inFlight||busy||adapter?.getSnapshot?.().generation)return;await scanBatch();}).catch(()=>out('batchSummary','自动扫描暂未完成。请求结束后会重试，或点击扫描；不会重发模型请求。'));
    },600);
  }
  function batchSettingsSnapshot() {return {policy:clone(settings.batchPolicy||EMPTY_BATCH_POLICY),mode:settings.mode,baselineIds:clone(settings.baselineIds||[]),follow:settings.batchFollow===true};}
  async function enableBatch() {
    assertIdle();assertFresh();
    if(!batchSetup||!batchReport)throw new Error('先点击免费扫描，生成当前配置的具体报告。');
    if(opt.undoStack?.length)throw new Error('当前还有已应用的手动优化副本，请先恢复优化前，避免两种排序叠加。');
    if(!batchReport.safety?.canPrepareCandidate||!batchPlan?.canApply)throw new Error(batchPlan?.reasons?.join('；')||'当前没有通过校验的排序方案；报告中的问题仍可查看，不能强行应用。');
    const revision=batchSetup.revision?.fingerprint,recordId=batchRecordId;
    const fresh=await readBatchSetup();assertIdle();assertFresh();
    if(!revision||fresh.revision?.fingerprint!==revision||batchCurrentRecord(fresh)?.id!==recordId)throw new Error('角色、配置或请求已改变，请重新扫描；未覆盖任何设置。');
    const checked=buildBatchPlan({record:batchCurrentRecord(fresh),setup:{...fresh,batchAuthorized:true},limits:limits()});
    if(!checked.canApply)throw new Error(checked.reasons.join('；')||'新的校验未通过，保持原请求。');
    const before=batchSettingsSnapshot();
    settings.batchRevision=(settings.batchRevision||0)+1;
    settings.batchPolicy={enabled:true,version:settings.batchRevision,algorithm:BATCH_ALGORITHM,connection:{provider:fresh.binding.provider,model:fresh.binding.model}};
    if(settings.mode==='diagnose')settings.mode='preview';
    settings.batchFollow=true;settings.baselineIds=billingRecords.map(r=>r.id);
    settings.batchHistory=[...(settings.batchHistory||[]),{at:new Date().toISOString(),revision:settings.batchRevision,before,after:batchSettingsSnapshot(),reason:'用户一次授权当前正文连接下的跨角色激活片段排序',expectedImpact:{addedEntries:0,removedEntries:0,nativeSettingsChanged:false,actualSavingsKnown:false},rollback:false}].slice(-12);
    await persist();syncBoundaryInputs();render();status('已启用跨角色安全排序。以后只检查每次请求自身的激活内容；无需逐条勾选，实际效果随正常游玩观察。');
  }
  async function rollbackBatch() {
    assertIdle();assertFresh();const tx=[...(settings.batchHistory||[])].reverse().find(t=>!t.rollback);
    if(!tx)throw new Error('没有待恢复的批量设置。');
    const currentPolicy=settings.batchPolicy||EMPTY_BATCH_POLICY;
    if(currentPolicy.algorithm!==tx.after.policy.algorithm||currentPolicy.enabled!==tx.after.policy.enabled||stableStringify(currentPolicy.connection)!==stableStringify(tx.after.policy.connection)||settings.mode!==tx.after.mode||stableStringify(settings.baselineIds||[])!==stableStringify(tx.after.baselineIds)||!!settings.batchFollow!==!!tx.after.follow)throw new Error('批量策略或关联模式、基线、跟随设置已改变，未强行覆盖。可使用“恢复优化前”停用全部优化。');
    settings.batchRevision=(settings.batchRevision||0)+1;settings.batchPolicy={...clone(tx.before.policy),version:settings.batchRevision};settings.mode=tx.before.mode;settings.baselineIds=clone(tx.before.baselineIds);settings.batchFollow=tx.before.follow===true;
    tx.rollback=true;tx.rolledBackAt=new Date().toISOString();await persist();if(!settings.batchFollow){clearTimeout(batchTimer);batchDirty=false;}syncBoundaryInputs();render();status('已恢复上一批量设置；后续请求使用恢复后的策略，原世界书与预设未被改写。');
  }
  async function reviewBatchWithAgent() {
    assertIdle();assertFresh();if(!batchReport)throw new Error('先免费扫描当前配置。');
    if(settings.maxTests<1||settings.maxCost<=0)throw new Error('未配置额外付费预算，不调用 Agent。');
    const profile=createProfile({mode:'preview',limits:limits()});
    const request={diagnostics:{batch:batchReport.agentDigest},proposalContext:{expectedVersion:profile.version,blocks:[],allowedOperations:[],instruction:'Review the diagnostic metadata in reason; return operations: []. No modifications are authorized by this review.'}};
    busy=true;
    try {
      serverStatus=await api('status');const cfg=agentConfigWithBudget(serverStatus.config,settings);if(cfg)await api('agent-config',cfg);
      const result=await api('agent',request);if(result.record)addRecord(agentObservation(result.record));
      const proposed=acceptedAgentProposal(result.proposal,profile.version);
      if(proposed.operations.length)throw new Error('本次只授权 Agent 复核报告，已阻止其修改操作。');
      out('batchAgent','Agent 复核意见（已计入 Agent 费用，不能当成服务端缓存证据）：\n'+String(proposed.reason||'未提出额外意见。'));
    } finally {busy=false;}
  }
  async function initializeStore() {
    try {
      const namespace=storageNamespace ?? (await import('/scripts/user.js')).getCurrentUserHandle();
      if(typeof namespace!=='string'||!namespace)throw new Error('无法确定当前酒馆账号的存储隔离标识。');
      try {
        observationStore=createObservationStore({key:'cache-lens:observations:v1:'+encodeURIComponent(namespace),storage,locks});
        const restored=await observationStore.read();
        archiveEnabled=true;
        const liveIds=new Set(billingRecords.map(r=>r.id));
        const archived=restored.filter(r=>!liveIds.has(r.id)).map(r=>({...r,archived:true,sources:[],observationNotice:r.observationLevel==='frontend'?'仅观察到前端请求；已恢复脱敏记录，原始提示词未保存，服务端转换与中转内部路由仍不可见。':'已恢复本机脱敏观察记录；原始请求未保存，不能重新比较或优化。'}));
        billingRecords=[...archived,...billingRecords];
        records=[...archived.slice(-MAX_RECORDS),...records].slice(-MAX_RECORDS);
        out('archiveStatus',`已恢复 ${archived.length} 条脱敏记录。自动保留最近最多 1000 条 / 2MiB；不保存提示词原文。清除浏览器数据或更换浏览器后无法恢复。`);
        render();if(liveIds.size)saveObservations();
      } catch {archiveEnabled=false;out('archiveStatus','本机存档不可用或格式损坏，原存档未覆盖；当前只能临时观察，请及时导出。可以明确清空观察与本机存档后重新开始。');}
      store=createBrowserStateStore({key:'cache-lens:v1:'+encodeURIComponent(namespace),storage,locks});
      const saved=await store.initialize(committedSettings);
      if(!saved?.state?.profile || !saved?.memory)throw new Error('持久化优化状态格式无效；已禁止自动覆盖。');
      committedSettings=clone(saved);savedSnapshot=stableStringify(saved);restoreCommitted();
      context.extensionSettings[KEY]=clone(saved);externalSnapshot=stableStringify(saved);stateReady=true;
      set('prices',json(settings.prices));render();status(settings.pendingRelayIntent?'存在未完成的 relay 事务，请打开断点面板恢复；当前不会自动修改策略。':'被动观察已开启；优化副本和回滚记录已持久化。',!!settings.pendingRelayIntent);queueBatchScan();
    }catch(error){stateReady=false;status(error.message+' 仍可只读观察请求。',true);}
  }
  function current() { return records.find(r=>r.id===selectedId) || [...records].reverse().find(r=>layerOf(r)===value('layer')); }
  function layerOf(r) { return observationLayer(r); }
  function usageFor(r) { return normalizeUsage(r.usage,r.interfaceType || r.provider); }
  function ratesFor(r) { return pricesFor(r, settings.prices); }
  function priorFor(r) { return records.slice(0, records.indexOf(r)).reverse().find(p=>hasObservedContext(p)&&requestGroupKey(p)===requestGroupKey(r)); }
  function diagnostic(r=current()) {
    if(!hasObservedContext(r))return r?.diagnostic&&(r.archived||r.diagnostic.firstDifference||r.diagnostic.equal===true||r.diagnostic.appendOnly===true)?{...r.diagnostic,archived:true}:{notice:'本请求未观察到可比较的上下文；不能据此判断前缀或缓存失效。'};
    const prev=priorFor(r);
    if(prev)return {...analyzePair(prev,r,{sources:r.sources,previousSources:prev.sources}),comparison:{previousStartedAt:prev.startedAt??prev.time??null,previousStatus:prev.status??'unknown'}};
    return r?.diagnostic&&(r.diagnostic.firstDifference||r.diagnostic.equal===true||r.diagnostic.appendOnly===true)?{...r.diagnostic,archived:true}:{notice:'需要当前页面内同一模型、用途、接口和观察层的两次完整请求；历史脱敏存档没有原文，不能作为新的比较基准。'};
  }
  function saveObservations(items=billingRecords) {
    if(!observationStore||!archiveEnabled)return;
    const snapshot=items.map(r=>{
      const live=records.find(x=>x.id===r.id);const d=compactDiagnostic(diagnostic(live||r));
      r.diagnostic=d;if(live)live.diagnostic=d;
      return {...r,diagnostic:d};
    });
    archiveWrites=archiveWrites.then(()=>observationStore.upsert(snapshot)).then(()=>{
      if(!disposed)out('archiveStatus','脱敏观察已自动保存到本浏览器当前酒馆账号（最多 1000 条 / 2MiB）。刷新后可恢复用量与差异结论；原始提示词不保存。');
    }).catch(()=>{if(!disposed)out('archiveStatus','本机存档写入失败，当前新记录未确认保存。请先导出诊断；存储配额不足或缺少 Web Locks 时请改用 localhost / HTTPS。不会自动重发模型请求。');});
  }
  function localContext(r=current()) {
    if(!hasObservedContext(r)) throw new Error('先选择一次具有完整上下文的请求；只有 usage 或采集超限的记录不能用于优化。');
    // Byte-level tokenizer upper bound only for supported text-based protocols. Includes FULL request remainder.
    return { limitsOverride:limits(), byteLevelTokenizer: ['anthropic','openai','deepseek'].includes(r.interfaceType), otherInputUpperBound:new TextEncoder().encode(JSON.stringify(r.body)).length+4096, unsupportedContent:hasUnsupportedContent(r.body), providerRules:PROVIDER_RULES.anthropic, inFlight:inFlight>0 };
  }
  function addRecord(record) {
    const previous=records.find(r=>r.id===record.id);
    const next={...previous,...record};if(previous?.manualPurpose) {next.purpose=previous.purpose;next.manualPurpose=true;}
    next.sources=normalizeUISources(next.sources);
    const i=records.findIndex(r=>r.id===next.id);if(i>=0)records[i]=next;else records.push(next);
    while(records.length>MAX_RECORDS || (records.length>1&&JSON.stringify(records).length>MAX_TOTAL_BYTES)) records.shift();
    if(!selectedId || !records.some(r=>r.id===selectedId)) selectedId=next.id;
    const billed={id:next.id,model:next.model,provider:next.provider,interfaceType:next.interfaceType,purpose:next.purpose,manualPurpose:next.manualPurpose,observationLevel:next.observationLevel,imported:next.imported,usage:next.usage,prices:next.prices,platformBill:next.platformBill,latencyMs:next.latencyMs,status:next.status,reportedStatus:next.reportedStatus,completion:next.completion,transmission:next.transmission,startedAt:next.startedAt||next.time,synthetic:next.synthetic,transformed:next.transformed,batchResult:next.batchResult,diagnostic:next.diagnostic};
    billed.synthetic=!!(next.synthetic||next.replay||next.predicted||next.evidence==='offline-preview');
    const bi=billingRecords.findIndex(r=>r.id===billed.id);if(bi>=0)billingRecords[bi]=billed;else if(billingRecords.length<10000)billingRecords.push(billed);else status('用量记录达到 10000 条上限；请导出并开始新观察会话。当前累计不再完整。',true);
    saveObservations([billed]);render();
    if(next.status==='complete'&&next.purpose==='main'&&next.observationLevel==='frontend'){pendingAutoRecord=next;scheduleAutomatic();}
    if(next.status==='complete'&&next.purpose!=='agent')queueBatchScan();
  }
  function render() {
    const layer=value('layer');const list=records.filter(r=>layerOf(r)===layer);
    const select=$(root,'[data-id="record"]');select.innerHTML=list.map(r=>`<option value="${esc(r.id)}">${esc((r.startedAt||'').slice(11,19))}${r.startedAt?.endsWith('Z')?' UTC':''} · ${esc(purposeLabel[r.purpose]||r.purpose)} · ${esc(r.model)} · ${esc(r.status||'observed')}${r.archived?' · 存档':''}</option>`).join('');
    if(!list.some(r=>r.id===selectedId)) selectedId=list.at(-1)?.id;
    select.value=selectedId||'';
    const groups=summarizeUsage(ledgerRecords(billingRecords,layer),settings.prices);
    $(root,'[data-id="ledger"]').innerHTML=`<table><thead><tr><th>用途 / 模型</th><th>请求</th><th>普通输入</th><th>缓存写入</th><th>缓存读取</th><th>输出</th><th>读取比例</th><th>费用</th></tr></thead><tbody>${groups.map(g=>`<tr><td>${esc(purposeLabel[g.purpose]||g.purpose)}<small>${esc(g.model)}</small></td><td>${g.requests}</td><td>${display(g.usageRequests?g.ordinaryInput:null)}${g.unknownUsageRequests&&g.usageRequests?' + ?':''}</td><td>${display(g.usageRequests?g.cacheWrite:null)}${g.unknownUsageRequests&&g.usageRequests?' + ?':''}</td><td>${display(g.usageRequests?g.cacheRead:null)}${g.unknownUsageRequests&&g.usageRequests?' + ?':''}</td><td>${display(g.usageRequests?g.output:null)}${g.unknownUsageRequests&&g.usageRequests?' + ?':''}</td><td>${g.cacheReadRatio===null?'未知':(100*g.cacheReadRatio).toFixed(1)+'%'}</td><td>${display(g.cost)} ${esc(g.currency||'')}<small>${g.unknownCostRequests?'含未计价请求':''}</small>${g.platformBills.map(b=>`<small>平台账单：${display(b.amount)} ${esc(b.currency)}</small>`).join('')}</td></tr>`).join('')}</tbody></table>`;
    const r=current();set('purpose',r?.purpose||'unknown');
    if(r) {
      const u=usageFor(r),c=calculateCost(u,ratesFor(r));
      $(root,'[data-id="facts"]').innerHTML=`<div><b>${esc(r.observationNotice||(layerOf(r)==='relay'?(r.transmission==='not-attempted'?'本地已拦截；此请求未发往上游':r.transmission==='attempted'?'relay 已尝试发送；未确认上游响应':'已观察 relay 出站请求和上游响应；中转内部转换不可见'):'导入证据：来源待核实'))}</b></div><div>实际输入：${display(u.totalInput)} tokens · 文本估计：${hasObservedContext(r)?estimateTokens(JSON.stringify(projectContext(r))).value:'未知'}（非精确） · 延迟：${display(r.latencyMs)} ms · 费用：${display(c.amount)} ${esc(c.currency||'')}${r.platformBill?` · 平台账单：${display(r.platformBill.amount)} ${esc(r.platformBill.currency)}`:''}</div>`;
      const d=diagnostic(r);out('differenceSummary',diagnosticSummary(d,r));
      out('difference', {...d,duplicates:hasObservedContext(r)?diagnoseDuplicates(r):[]});
      out('request',r);
      out('world',worldSummary(r,{maxInputTokens:settings.maxInputTokens}));
    } else {out('differenceSummary','等待正常请求，或导入已有脱敏诊断。');out('difference','等待正常请求，或导入脱敏 JSON。');out('request','');$(root,'[data-id="facts"]').textContent='仅观察到前端请求（尚无完整服务端记录）';}
    out('history',{version:opt.profile.version,mode:settings.mode,blocks:opt.profile.blocks.length,transactions:opt.history.map(t=>({id:t.id,at:t.at,reason:t.reason,impact:t.impact,rollback:t.rollback}))});
    out('rules',settings.rules);out('memory',renderMemory(memory));renderBatch();
  }
  function download(name, content) { const url=URL.createObjectURL(new Blob([json(content)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
  async function api(path,body) { const headers=context.getRequestHeaders?.()||{'Content-Type':'application/json'};const r=await fetch('/api/plugins/cache-lens/'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:json(body)});if(!r.ok){let code='';try{const data=await r.json();if(/^[A-Z0-9_]{1,100}$/.test(data.error))code=data.error;}catch{}const error=new Error(agentSetupError(code,r.status));error.code=code;error.httpStatus=r.status;throw error;}return r.json(); }
  async function checkAgentServer() {
    serverStatus=await api('status');
    if(!serverStatus.capabilities?.agentCheck)throw new Error('服务端版本较旧。请执行本栏的安装命令更新服务端并重启酒馆。');
    out('agentConnection','服务端已就绪（'+serverStatus.serverVersion+'）。可以填写密钥并检查连接。');
    if(serverStatus.configured){
      const c=serverStatus.config;
      if(!value('agentEndpoint').trim()&&!value('agentModel').trim()){
        const p=c.prices||{};
        for(const [id,v]of Object.entries({agentType:c.interfaceType,agentEndpoint:c.endpoint,agentModel:c.model,agentOutput:c.maxOutputTokens,currency:p.currency,agentInputPrice:p.input,agentOutputPrice:p.output,agentPriceSource:p.source,agentPriceDate:p.updatedAt,agentTokenParameter:c.tokenParameter||'auto',agentReasoning:c.reasoningEffort||'default'}))set(id,v);
        set('agentCachePrices',json(Object.fromEntries(Object.entries(p).filter(([key])=>key.startsWith('cache')))));
        $(root,'[data-id="agentLocal"]').checked=c.allowLocal===true;
      }
      out('agentStatus','服务端已有配置：'+c.model+'；密钥已保存在服务端。');
    }
    return serverStatus;
  }
  function agentConnectionInput() { return {interfaceType:value('agentType'),endpoint:value('agentEndpoint').trim(),model:value('agentModel').trim(),apiKey:value('agentKey'),allowLocal:$(root,'[data-id="agentLocal"]').checked}; }

  async function refresh() {
    serverStatus=await api('status');out('agentStatus',serverStatus.configured?'已保存 Agent 配置：'+serverStatus.config.model+'。调用仍受预算限制。':'服务端可用，尚未保存 Agent 配置。');
    const jobs=[api('agent-records').then(data=>(data.records||[]).forEach(r=>addRecord(agentObservation(r))))];
    if(serverStatus.observerConfigured)jobs.push(api('relay-records').then(data=>{if(data.errors?.length)status('部分观察器不可用：'+data.errors.map(e=>e.observerId+': '+e.error).join('；'),true);(data.records||data||[]).forEach(r=>{
      const rule=settings.rules.find(v=>v.model===r.model&&(v.provider===r.provider||v.provider===r.interfaceType));
      addRecord({...r,id:'relay:'+r.id,purpose:rule?.purpose||r.purpose||'unknown',observationLevel:'server-relay',sources:[]});
    });}));
    const results=await Promise.allSettled(jobs);for(const v of results)if(v.status==='rejected')status(v.reason.message,true);
  }
  function relayCallbacks(observerId,revertedEntry=null) {
    const remote=(action,body)=>api('relay-policy?observerId='+encodeURIComponent(observerId),action==='get'?undefined:body);
    return {
      api:remote,
      async saveIntent(intent){assertIdle();assertFresh();if(settings.pendingRelayIntent&&settings.pendingRelayIntent.id!==intent.id)throw new Error('另一策略事务尚未完成');settings.pendingRelayIntent=intent;await persist();},
      async commitHistory(entry,intent){
        if(revertedEntry)settings.relayHistory=advanceHistoryAfterRollback(settings.relayHistory,revertedEntry,{policy:entry.after,version:entry.version,inFlight:0});
        else settings.relayHistory.push(entry);
        settings.relayAudit=[...(settings.relayAudit||[]),{id:entry.id,observerId,at:entry.at,kind:entry.kind,version:entry.version}].slice(-100);
        settings.pendingRelayIntent=intent;await persist();
      },
      async clearIntent(id){if(settings.pendingRelayIntent?.id===id){settings.pendingRelayIntent=null;await persist();}},
      async onCompensated({state,intent}){settings.relayHistory=rebasePolicyHistory(settings.relayHistory,observerId,state);settings.pendingRelayIntent=intent;await persist();}
    };
  }
  async function rollbackOneRelay(entry){
    assertIdle();assertFresh();if(settings.pendingRelayIntent)throw new Error('先恢复未完成策略事务');
    const result=await rollbackPolicyTransaction({entry,...relayCallbacks(entry.observerId||'main',entry)});
    set('observerId',entry.observerId||'main');root.dataset.policyObserver=entry.observerId||'main';root.dataset.policyVersion=String(result.state.version);set('policy',json(result.state.policy));out('policyStatus',result);return result;
  }
  async function rollbackRelayAll(){
    if(settings.pendingRelayIntent)throw new Error('有未完成策略事务；先执行事务恢复再完整回滚。');
    // Each CAS is journaled separately. A later conflict leaves completed rounds recorded, never hidden.
    while(settings.relayHistory.length)await rollbackOneRelay(settings.relayHistory.at(-1));
  }
  function doPreview(record=current()) {draft=JSON.parse(value('proposal'));preview=previewProposal(opt.profile,draft,localContext(record));lastPreviewState=stableStringify(opt);out('preview',preview.ok?{ok:true,evidence:preview.evidence,impact:preview.impact,before:preview.before.blocks.map(b=>b.id),after:preview.after.blocks.map(b=>b.id),reason:draft.reason}:preview);return preview;}
  async function doApply(record=current()) {
    assertIdle();assertFresh();if(settings.mode==='diagnose')throw new Error('只诊断模式不可应用修改。');
    if(settings.batchPolicy?.enabled)throw new Error('跨角色批量排序已启用，请先恢复批量设置再应用手动方案，避免两种策略互相覆盖。');
    if(lastPreviewState!==stableStringify(opt))throw new Error('副本已变化，请重新预览。');
    opt=applyProposal(opt,JSON.parse(value('proposal')),{...localContext(record),expectedPreview:preview});
    await persist();render();status('已应用优化副本；等待下一次正常请求验证。');
  }
  async function doRollback(all=false) {assertIdle();assertFresh();opt=rollback(opt,{all,inFlight:false,expectedVersion:opt.profile.version,expectedProfile:opt.profile});await persist();render();status(all?'已恢复优化前副本配置。':'已恢复本轮修改。');}
  async function stopAutomatic({restore=false}={}) {
    assertIdle();assertFresh();
    if(restore)await rollbackRelayAll();
    if(restore&&opt.undoStack?.length)opt=rollback(opt,{all:true,inFlight:false,expectedVersion:opt.profile.version,expectedProfile:opt.profile});
    if(restore){const first=(settings.batchHistory||[]).find(tx=>!tx.rollback);if(first){settings.batchFollow=first.before.follow===true;settings.baselineIds=clone(first.before.baselineIds);}settings.batchRevision=(settings.batchRevision||0)+1;settings.batchPolicy={...clone(EMPTY_BATCH_POLICY),version:settings.batchRevision};for(const tx of settings.batchHistory||[])tx.rollback=true;}
    settings.mode='diagnose';await persist();if(!settings.batchFollow){clearTimeout(batchTimer);batchDirty=false;}set('mode','diagnose');render();
    status(restore?'已恢复优化前副本并停用优化。':'已停用自动优化；原始请求继续正常发送。');
  }
  function matchesBinding(record) {
    const binding=opt.profile.binding;
    return !!binding&&['chatId','model','provider','purpose'].every(key=>binding[key]===record?.[key]);
  }
  function scheduleAutomatic() {
    if(disposed||!stateReady||settings.batchPolicy?.enabled||settings.pendingRelayIntent||settings.mode!=='automatic'||!pendingAutoRecord||pendingAutoRecord.id===lastAutoRecordId||inFlight||busy||adapter?.getSnapshot?.().generation)return;
    const record=pendingAutoRecord;
    actionQueue=actionQueue.then(async()=>{
      if(disposed||settings.mode!=='automatic'||inFlight||busy||adapter?.getSnapshot?.().generation||!records.some(r=>r.id===record.id)||pendingAutoRecord?.id!==record.id)return;
      if(record.id===lastAutoRecordId||!matchesBinding(record))return;
      lastAutoRecordId=record.id;
      const proposal=localCandidate(opt.profile);if(!proposal.operations.length)return;
      set('proposal',json(proposal));const checked=doPreview(record);
      if(checked.ok)await doApply(record);else status('自动方案未通过本地校验，未修改请求：'+checked.errors.join('；'),true);
    }).catch(error=>status(error.message,true));
  }
  const actions = {
    async 'batch-scan'(){await scanBatch({follow:true});},
    'batch-enable':enableBatch,
    'batch-rollback':rollbackBatch,
    'batch-agent':reviewBatchWithAgent,
    'batch-export'(){if(!batchReport)throw new Error('先免费扫描当前配置。');download('cache-lens-settings-report.json',{...batchReport,notice:'包含世界书/条目名称与设置，不含提示词正文、触发词文本或密钥。仅为本地诊断，不能证明实际节省。'});},
    async 'batch-mark-main'(){
      assertIdle();assertFresh();const b=batchConnection();if(!b||[b.provider,b.model].some(x=>!x||x==='unknown'))throw new Error('先扫描有效的当前连接。');
      settings.rules=[...settings.rules.filter(r=>!(r.provider===b.provider&&r.model===b.model)),{provider:b.provider,model:b.model,purpose:'main'}];
      for(const r of [...records,...billingRecords])if(r.provider===b.provider&&r.model===b.model&&r.purpose==='unknown'){r.purpose='main';r.manualPurpose=true;if(hasObservedContext(r))delete r.diagnostic;}
      await persist();saveObservations();await scanBatch();render();
    },
    async save(){assertIdle();assertFresh();const proposed={};for(const [key,id]of [['maxInputTokens','maxInput'],['contextTokens','context'],['outputReserveTokens','reserve'],['maxTests','maxTests'],['maxCost','maxCost']]){const n=Number(value(id));if(!Number.isFinite(n)||n<0||(key!=='maxCost'&&!Number.isSafeInteger(n)))throw new Error('tokens 和次数上限必须是非负整数，费用须是非负数字');proposed[key]=n;}if(proposed.maxInputTokens<1||proposed.contextTokens<=proposed.outputReserveTokens)throw new Error('输入和上下文边界无效');if(!['diagnose','preview','automatic'].includes(value('mode')))throw new Error('未知运行模式');Object.assign(settings,proposed,{mode:value('mode')});await persist();syncBoundaryInputs();status('已保存边界；自动模式在下一次正常正文完成后，只在已授权副本范围内生成免费本地排序方案。');render();scheduleAutomatic();},
    async 'add-rule'(){const provider=value('ruleProvider').trim(),model=value('ruleModel').trim();if(!provider||!model)throw new Error('需要接口来源和完整模型 ID');settings.rules=settings.rules.filter(r=>!(r.provider===provider&&r.model===model));settings.rules.push({provider,model,purpose:value('rulePurpose')});for(const r of [...records,...billingRecords])if(r.provider===provider&&r.model===model){r.purpose=value('rulePurpose');r.manualPurpose=true;if(hasObservedContext(r))delete r.diagnostic;}await persist();saveObservations();render();},
    async 'save-prices'(){settings.prices=validatePriceTable(JSON.parse(value('prices')));await persist();render();},
    refresh,
    export(){download('cache-lens-diagnostics-redacted.json',redactedExport({records:billingRecords,prices:settings.prices,history:opt.history,diagnosticFor:r=>diagnostic(records.find(x=>x.id===r.id)||r)}));},
    import(){ $(root,'[data-id="file"]').click(); },
    async clear(){
      assertIdle();const removedIds=new Set(billingRecords.map(r=>r.id));
      if(observationStore){const cleared=archiveWrites.then(()=>observationStore.clear());archiveWrites=cleared.catch(()=>{});await cleared;archiveEnabled=true;}
      records=records.filter(r=>!removedIds.has(r.id));billingRecords=billingRecords.filter(r=>!removedIds.has(r.id));if(removedIds.has(selectedId))selectedId=null;render();
      if(removedIds.has(pendingAutoRecord?.id))pendingAutoRecord=null;lastAutoRecordId=null;
      out('archiveStatus','观察与本机脱敏存档已清空；优化副本、回滚记录和 Agent 预算未重置。');if(billingRecords.length)saveObservations();
    },
    async 'inspect-book'(){const book=await adapter.inspectWorldBook(value('book'));out('world',worldSummary(current(),{book,maxInputTokens:settings.maxInputTokens}));},
    capture(){assertIdle();const r=current();if(!hasObservedContext(r)||layerOf(r)!=='frontend'||r.purpose!=='main')throw new Error('先选择一次具有完整上下文并已归类为正文的前端请求；采集超限或只有 usage 时不能提取片段');capturedBinding={chatId:r.chatId??'',model:r.model,provider:r.provider,purpose:r.purpose};captured=eligibleSources(r.body,r.sources||sources);$(root,'[data-id="fragments"]').innerHTML=captured.length?captured.map((b,i)=>`<div class="cl-fragment"><label><input type="checkbox" data-fragment="${i}">独立可重排</label><label><input type="checkbox" data-stable="${i}">稳定</label><b>${esc(b.source.name||b.id)}</b><small>${esc(b.scope)} · ${b.content.length} 字符</small><code>${esc(b.content.slice(0,100))}</code></div>`).join(''):'未找到可精确定位且标签闭合的片段。宏展开、跨消息或未知插件不会被强行适配。';},
    async copy(){assertIdle();assertFresh();if(opt.undoStack?.length)throw new Error('当前仍有生效修改；先恢复优化前再建立新副本。');const blocks=captured.filter((b,i)=>$(root,`[data-fragment="${i}"]`)?.checked).map(b=>{const i=captured.indexOf(b);return {...b,approvedIndependent:true,stable:$(root,`[data-stable="${i}"]`).checked};});if(blocks.length<2||!capturedBinding)throw new Error('至少选择两个已确认独立的片段。');settings.archivedOptimizationHistory=[...(settings.archivedOptimizationHistory||[]),...opt.history.map(t=>({id:t.id,at:t.at,reason:t.reason,rollback:t.rollback}))].slice(-100);opt=createOptimizationState(createProfile({id:'live-copy',mode:'preview',blocks,binding:capturedBinding,limits:limits()}));lastAutoRecordId=null;preview=null;lastPreviewState=null;await persist();render();status('已建立当前聊天、模型和用途专属副本；原始配置未被覆盖。');},
    async candidate(){draft=localCandidate(opt.profile);if(!draft.operations.length){out('preview','当前已授权片段没有可执行的排序改进；未修改、未付费。');return;}set('proposal',json(draft));doPreview();if(settings.mode==='automatic'&&preview.ok)await doApply();},
    preview:doPreview,
    apply:doApply,
    async rollback(){const latest=settings.relayHistory.at(-1),batch=[...(settings.batchHistory||[])].reverse().find(t=>!t.rollback);if(batch&&batch.at>(latest?.at||'')&&batch.at>(opt.history.at(-1)?.at||''))await rollbackBatch();else if(latest&&(!opt.undoStack?.length||latest.at>(opt.history.at(-1)?.at||'')))await rollbackOneRelay(latest);else await doRollback(false);},
    async restore(){await stopAutomatic({restore:true});},
    async agent(){
      assertIdle();if(settings.maxTests<1||settings.maxCost<=0)throw new Error('未配置额外付费预算，不调用 Agent。');busy=true;
      try {
        serverStatus=await api('status');const updated=agentConfigWithBudget(serverStatus.config,settings);
        if(updated)serverStatus=await api('agent-config',updated);
        const result=await api('agent',agentPayload(opt.profile,diagnostic()));
        if(result.record)addRecord(agentObservation(result.record));
        draft=acceptedAgentProposal(result.proposal,opt.profile.version);set('proposal',json(draft));busy=false;
        if(draft.operations.length){await doPreview();if(settings.mode==='automatic'&&preview.ok)await doApply();}else{preview=null;out('preview',{ok:true,applied:false,notice:'Agent 未建议必要修改；本次调用费用仍计入统计。'});}
      } finally {busy=false;await refresh().catch(e=>status(e.message,true));}
    },
    async baseline(){assertIdle();settings.baselineIds=billingRecords.map(r=>r.id);await persist();out('evaluation','基线已标记；继续正常游玩后比较。没有发起额外测试。');},
    async evaluate(){
      assertIdle();const {evaluateTrial}=await import('./core/evaluation.js');
      const evaluated=evaluateTrial(trialInput({records:billingRecords,baselineIds:settings.baselineIds,layer:value('layer'),settings,serverStatus,quality:value('quality')}));
      out('evaluation',evaluated);
      if(evaluated.decision==='rollback')await stopAutomatic({restore:true});
      else if(evaluated.decision==='no-improvement')await stopAutomatic();
    },
    async 'append-memory'(){assertIdle();assertFresh();memory=appendMemory(memory,{id:value('eventId'),occurredAt:value('eventDate'),originalTimeText:value('eventRelative'),text:value('eventText')});await persist();render();},
    'export-memory'(){download('cache-lens-memory.json',memory);},
    async 'check-server'(){try{await checkAgentServer();}catch(error){out('agentConnection',error.message);throw error;}},
    'preset-openai'(){
      const p=OPENAI_STARTER;
      if(value('agentEndpoint').trim()!==p.endpoint)set('agentKey','');
      for(const [id,v]of Object.entries({agentType:p.interfaceType,agentEndpoint:p.endpoint,agentModel:p.model,agentOutput:p.maxOutputTokens,currency:p.currency,agentInputPrice:p.input,agentOutputPrice:p.output,agentPriceSource:p.source,agentPriceDate:p.updatedAt,agentCachePrices:json({cacheRead:p.cacheRead,cacheWrite:p.cacheWrite,cacheWrite30m:p.cacheWrite30m,cacheWrite12h:p.cacheWrite12h}),agentTokenParameter:p.tokenParameter,agentReasoning:p.reasoningEffort}))set(id,v);
      $(root,'[data-id="agentLocal"]').checked=false;
      out('agentConnection','已填写 OpenAI 官方接口、gpt-6.1-terra 和价格快照。请填写 OpenAI API 密钥，再检查连接。预算未改变，尚未保存。');
    },
    async 'check-agent'(){
      try{await checkAgentServer();out('agentConnection','正在检查密钥与模型可见性，不生成内容……');const result=await api('agent-check',agentConnectionInput());if(!result.ok||result.modelVisible!==true)throw new Error(agentSetupError(result.code,result.httpStatus));out('agentConnection','连接检查通过：'+(result.authenticationVerified===true?'密钥被接受，':'接口可访问（未确认此兼容接口是否校验密钥），')+'模型 '+result.model+' 可见。尚未进行生成或余额验证；现在可填写预算并保存。');}
      catch(error){out('agentConnection',error.message);throw error;}
    },
    async 'save-agent'(){
      assertIdle();assertFresh();
      const maxCalls=Number(value('agentCalls')),maxCost=Number(value('agentCost'));
      if(!Number.isSafeInteger(maxCalls)||maxCalls<=0||!Number.isFinite(maxCost)||maxCost<=0){out('agentStatus','请填写正数的 Agent 调用次数和总费用上限。只检查连接时无需设置预算。');throw new Error('尚未填写 Agent 预算。');}
      const payload={...agentConnectionInput(),enabled:true,tokenParameter:value('agentTokenParameter'),reasoningEffort:value('agentType')==='openai'?value('agentReasoning'):'default',maxOutputTokens:Number(value('agentOutput')),budget:{maxCalls,maxCost,currency:value('currency')},prices:{...optionalCachePrices(JSON.parse(value('agentCachePrices')||'{}')),input:Number(value('agentInputPrice')),output:Number(value('agentOutputPrice')),currency:value('currency'),source:value('agentPriceSource'),updatedAt:value('agentPriceDate')}};
      try{await checkAgentServer();serverStatus=await api('agent-config',payload);set('agentKey','');Object.assign(settings,{currency:payload.budget.currency,maxTests:maxCalls,maxCost});await persist();syncBoundaryInputs();out('agentStatus','配置已保存，密钥已由服务端保管。尚未调用模型。正常观察后，在优化副本中点击“调用 Agent 提案”。');}
      catch(error){out('agentStatus',error.message);throw error;}
    },
    async 'save-observer'(){try{await api('observer-config',{id:value('observerId').trim(),relayBaseUrl:value('relayURL'),relayToken:value('relayToken')});await refresh();}finally{set('relayToken','');}},
    async 'load-policy'(){const p=await api('relay-policy?observerId='+encodeURIComponent(value('observerId').trim()));set('policy',json(p.policy||{enabled:false}));out('policyStatus',p);root.dataset.policyVersion=String(p.version);root.dataset.policyObserver=value('observerId').trim();},
    'draft-policy'(){const r=current(),prev=r&&priorFor(r);if(!hasObservedContext(r)||layerOf(r)!=='relay'||!prev)throw new Error('需要同一通道两次实际 relay 请求。');if(r.interfaceType!=='anthropic')throw new Error('仅为已核实 Anthropic Messages 生成断点；兼容名称不代表支持。');const texts=[];for(let i=0;i<(r.body.system||[]).length;i++){const a=r.body.system[i],b=prev.body.system?.[i];if(!a||a.type!=='text'||a.text!==b?.text)break;texts.push(a.text);}if(!texts.length)throw new Error('没有已观察到相同的 system 内容块前缀。');set('policy',json({enabled:true,interfaceType:'anthropic',endpointVerified:true,model:r.model,stableSystemTexts:texts,ttl:'5m',maximumInputTokens:settings.maxInputTokens,rules:PROVIDER_RULES.anthropic}));},
    async 'apply-policy'(){
      assertIdle();assertFresh();if(settings.mode==='diagnose')throw new Error('只诊断模式不可应用。');
      if(settings.pendingRelayIntent)throw new Error('有未完成的策略事务，请先恢复。');
      if(!$(root,'[data-id="verifiedEndpoint"]').checked)throw new Error('请核实实际接口支持规则后勾选确认。');
      const observerId=value('observerId').trim();if(root.dataset.policyObserver!==observerId||!root.dataset.policyVersion)throw new Error('先读取当前观察器策略。');
      const result=await applyPolicyTransaction({observerId,policy:JSON.parse(value('policy')),expectedVersion:root.dataset.policyVersion,...relayCallbacks(observerId)});
      root.dataset.policyVersion=String(result.state.version);out('policyStatus',result);
    },
    async 'rollback-policy'(){const id=value('observerId').trim();const last=[...settings.relayHistory].reverse().find(e=>(e.observerId||'main')===id);if(!last)throw new Error('此观察器没有本插件应用的断点修改');await rollbackOneRelay(last);},
    async 'recover-policy'(){assertIdle();assertFresh();const intent=settings.pendingRelayIntent;if(!intent)throw new Error('没有待恢复事务');const result=await recoverPolicyIntent({intent,...relayCallbacks(intent.observerId)});out('policyStatus',result);if(result.intentPending)throw new Error('恢复尚未完成：'+result.status+'。未覆盖并发修改，请核对 relay 当前策略。');}

  };
  root.addEventListener('click',event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(!action)return;actionQueue=actionQueue.then(async()=>{await ready;await actions[action]?.();}).catch(error=>status(error.message,true));});
  $(root,'[data-id="layer"]').addEventListener('change',()=>{selectedId=null;render();});
  $(root,'[data-id="record"]').addEventListener('change',event=>{selectedId=event.target.value;render();});
  $(root,'[data-id="purpose"]').addEventListener('change',event=>{const r=current();if(r){r.purpose=event.target.value;r.manualPurpose=true;if(hasObservedContext(r))delete r.diagnostic;const bill=billingRecords.find(b=>b.id===r.id);if(bill){bill.purpose=r.purpose;bill.manualPurpose=true;}saveObservations();render();}});
  $(root,'[data-id="batchFollow"]').addEventListener('change',event=>{const enabled=event.target.checked;actionQueue=actionQueue.then(async()=>{await ready;assertIdle();settings.batchFollow=enabled;await persist();if(enabled)queueBatchScan();else{clearTimeout(batchTimer);batchDirty=false;}renderBatch();}).catch(error=>status(error.message,true));});
  $(root,'[data-id="file"]').addEventListener('change',async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>16*1024*1024)throw new Error('导入文件超过 16MB');const data=JSON.parse(await file.text());for(const record of importEvidence(data))addRecord(record);set('layer','import');render();}catch(e){status(e.message,true);}finally{event.target.value='';}});
  for(const [key,id]of [['mode','mode'],['maxInputTokens','maxInput'],['contextTokens','context'],['outputReserveTokens','reserve'],['maxTests','maxTests'],['maxCost','maxCost'],['maxTests','agentCalls'],['maxCost','agentCost'],['currency','currency']])set(id,settings[key]);
  set('prices',json(settings.prices));set('agentPriceDate',new Date().toISOString().slice(0,10));
  $(root,'[data-id="book"]').innerHTML=(context.getWorldInfoNames?.()||[]).map(n=>`<option>${esc(n)}</option>`).join('');
  adapter=adapterFactory({getContext:()=>globalThis.SillyTavern?.getContext?.()||context,onRecord:addRecord,onSources:(s,w)=>{sources=s;world=w;scheduleAutomatic();if(batchDirty)queueBatchScan();},onInFlight:n=>{inFlight=n;status(n?`正在观察 ${n} 个请求；修改锁定。`:'被动观察中；不会额外发送正文测试。');if(!n){scheduleAutomatic();if(batchDirty)queueBatchScan();}},onError:e=>status(e,true),resolvePurpose:body=>committedSettings.rules.find(r=>r.provider===body.chat_completion_source&&r.model===body.model)?.purpose,transform:(body,meta)=>{
    if(!stateReady||committedSettings.pendingRelayIntent||committedSettings.mode==='diagnose'||!store.matches(savedSnapshot))return body;
    if(stableStringify(context.extensionSettings?.[KEY]??null)!==externalSnapshot)return body;
    if(committedSettings.batchPolicy?.enabled){
      const run=runBatchPolicy(body,meta,committedSettings.batchPolicy,{maxInputTokens:committedSettings.maxInputTokens,contextTokens:committedSettings.contextTokens,outputReserveTokens:committedSettings.outputReserveTokens});
      meta.batchResult=run.result;lastBatchResult=run.result;renderBatch();return run.body;
    }
    const ceiling=Math.min(committedSettings.maxInputTokens,committedSettings.contextTokens-committedSettings.outputReserveTokens);
    if(new TextEncoder().encode(JSON.stringify(body)).length+4096>ceiling||hasUnsupportedContent(body))return body;
    return transformWithProfile(body,committedSettings.state.profile,{binding:meta});
  },validateTransform:()=>true});
  for(const name of ['CHAT_CHANGED','OAI_PRESET_CHANGED_AFTER','WORLDINFO_SETTINGS_UPDATED','CHARACTER_EDITED']){
    const event=context.eventTypes?.[name];if(event&&context.eventSource?.on){const callback=()=>queueBatchScan({invalidate:true});context.eventSource.on(event,callback);batchListeners.push([event,callback]);}
  }
  const timer=setInterval(()=>{if(serverStatus?.observerConfigured&&!inFlight&&!busy)refresh().catch(()=>{});},15000);
  render();status('被动观察已开启，正在载入持久化优化状态。');
  const ready=initializeStore();
  // Read-only publicly documented adapter surface, never accepts executable Agent tools.
  const publicAPI={ready,flushObservations:()=>archiveWrites,getMemory:()=>clone(memory),getDiagnostics:()=>compactDiagnostic(diagnostic()),getBatchReport:()=>clone(batchReport),getRecords:()=>clone(records),adapter,dispose(){disposed=true;clearInterval(timer);clearTimeout(batchTimer);for(const [event,callback]of batchListeners)(context.eventSource.removeListener||context.eventSource.off)?.call(context.eventSource,event,callback);adapter.dispose();root.remove();}};
  return publicAPI;
}

if(typeof document!=='undefined'&&globalThis.SillyTavern){const start=()=>{globalThis.CacheLens?.dispose?.();globalThis.CacheLens=mountCacheLens();};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();}
