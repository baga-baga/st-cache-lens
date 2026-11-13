/** Small data-only boundaries used by the UI. No narrative text is exported by default. */
import { projectContext } from '../core/diagnostics.js';
import { normalizeUsage, calculateCost } from '../core/usage.js';
const clone = v => structuredClone(v);
const safeNumber = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const purposes = new Set(['main','summary','agent','unknown']);
const priceKeys = ['input','output','cacheRead','cacheWrite','cacheWrite5m','cacheWrite1h','cacheWrite30m','cacheWrite12h'];
const secretPattern = /\b(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[^\s"']+)|\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*[^\s,;}"']+/gi;
const scrubString = text => String(text??'').replace(secretPattern,'[REDACTED]');
function label(value, fallback='unknown') { return typeof value === 'string' && value ? scrubString(value.slice(0,256)).replace(/[\r\n]/g,' ') : fallback; }
function timestamp(value) { return typeof value==='string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null; }
const usageKeys=new Set(['input_tokens','output_tokens','prompt_tokens','completion_tokens','total_tokens','cache_creation_input_tokens','cache_read_input_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','cached_tokens','cache_write_tokens','ephemeral_5m_input_tokens','ephemeral_1h_input_tokens','ttl_30m_tokens','ttl_12h_tokens','reasoning_tokens','audio_tokens','accepted_prediction_tokens','rejected_prediction_tokens']);
const usageObjects=new Set(['cache_creation','prompt_tokens_details','input_tokens_details','output_tokens_details','completion_tokens_details','cache_write_tokens_details']);
export function numericUsage(value,depth=0) {
  if(!value||typeof value!=='object'||Array.isArray(value)||depth>6)return null;
  const entries=Object.entries(value).flatMap(([key,val])=>usageKeys.has(key)&&safeNumber(val)?[[key,val]]:usageObjects.has(key)&&val&&typeof val==='object'?[[key,numericUsage(val,depth+1)||{}]]:[]);
  return entries.length?Object.fromEntries(entries):null;
}
function safeBill(bill) { return bill&&safeNumber(bill.amount)&&/^[A-Z]{3}$/.test(bill.currency)?{amount:bill.amount,currency:bill.currency,evidence:'user-imported-platform-bill'}:null; }

export function observationLayer(record) {
  if(record.imported || String(record.observationLevel).startsWith('imported'))return 'import';
  if(['agent-server','agent'].includes(record.observationLevel))return 'agent';
  if(record.observationLevel==='frontend')return 'frontend';
  if(record.observationLevel==='server-relay')return 'relay';
  return 'import';
}
/** Include the selected capture layer once plus actual service Agent calls once. */
export function ledgerRecords(records, layer) {
  const seen=new Set();
  return records.filter((r,index)=>{
    if(observationLayer(r)!==layer && !(observationLayer(r)==='agent'&&r.purpose==='agent'))return false;
    const key=r.id??`unkeyed-${index}`;if(seen.has(key))return false;seen.add(key);return true;
  });
}
export function pricesFor(record,table={}) { return record.prices??table[`${record.provider}:${record.model}`]??table[record.model]??{}; }
export function pricedObservation(record,table={}) {
  const normalizedUsage=normalizeUsage(record.usage,record.interfaceType??record.provider);
  const prices=pricesFor(record,table);
  return {...record,normalizedUsage,prices,cost:calculateCost(normalizedUsage,prices)};
}
export function agentObservation(record) {
  // Historical interface and rates belong to this call, never the currently configured Agent.
  return {...record,id:String(record.id??'unknown').startsWith('agent:')?record.id:`agent:${record.id}`,observationLevel:'agent-server',purpose:'agent',
    prices:record.prices??{},interfaceType:record.interfaceType??record.provider??'unknown',startedAt:record.startedAt??record.time};
}
export function trialInput({records=[],baselineIds=[],layer='frontend',settings={},serverStatus=null,quality='unknown'}={}) {
  const items=ledgerRecords(records,layer).map(r=>pricedObservation(r,settings.prices));
  const ids=new Set(baselineIds);
  const baseline=items.filter(r=>ids.has(r.id)),candidate=items.filter(r=>!ids.has(r.id));
  const ledger=serverStatus?.ledger;
  return {baseline,candidate,quality,limits:{maxPaidTestCalls:settings.maxTests,maxPaidTestCost:settings.maxCost,currency:settings.currency,maxInputTokens:settings.maxInputTokens},
    paidTestCount:ledger?.calls??null,paidTestCost:safeNumber(ledger?.chargedOrReserved)&&ledger?.currency?{amount:ledger.chargedOrReserved,currency:ledger.currency}:null,
    completed:baselineIds.every(id=>records.some(r=>r.id===id))&&![...baseline,...candidate].some(r=>['pending','reserved'].includes(r.status)||r.completion==='pending')};
}
export function compactDiagnostic(d={}) {
  d=d&&typeof d==='object'?d:{};
  const codes=new Set(['SUMMARY_REWRITE','SUMMARY_POSITION_MOVED','SUMMARY_TEXT_CHANGED','RELATIVE_TIME_TEXT_CHANGED','CONTEXT_PREFIX_CHANGED','STABLE_EXPLICIT_BREAKPOINT','REQUEST_CONFIGURATION_CHANGED','INCOMPARABLE_REQUEST_GROUP','EXACT_DUPLICATE_BLOCK','EXACT_DUPLICATE_SOURCE','ACTIVATED_INPUT_OVER_LIMIT','ACTIVATED_OVER_BUDGET','LARGE_BOOK_TOTAL','SENT_INPUT_OVER_LIMIT']);
  const path=d.firstDifference?.currentPath??d.firstDifference?.previousPath??d.firstDifference?.path;
  const safePath=typeof path==='string'&&/^(?:messages|system|tools|input|instructions|prompt)(?:\[\d+\]|\.[a-zA-Z_][a-zA-Z_0-9]*)*$/.test(path)&&path.length<180?path:null;
  const kinds=new Set(['content','structure','append','removal']);
  const statuses=new Set(['pending','reserved','complete','completed','http-error','request-error','observation-error','network-error','stream-error','aborted','error','failed','cancelled','observed','imported']);
  return {stablePrefixCharacters:safeNumber(d.stablePrefixCharacters)?d.stablePrefixCharacters:null,appendOnly:d.appendOnly===true,
    ...(typeof d.equal==='boolean'?{equal:d.equal}:{}),...(typeof d.comparable==='boolean'?{comparable:d.comparable}:{}),
    firstDifference:d.firstDifference?{path:safePath,kind:kinds.has(d.firstDifference.kind)?d.firstDifference.kind:'unknown',
      ...(Number.isSafeInteger(d.firstDifference.offset)&&d.firstDifference.offset>=0?{offset:d.firstDifference.offset}:{})}:null,
    ...(d.comparison?{comparison:{previousStartedAt:timestamp(d.comparison.previousStartedAt),previousStatus:statuses.has(d.comparison.previousStatus)||(Number.isInteger(d.comparison.previousStatus)&&d.comparison.previousStatus>=100&&d.comparison.previousStatus<=599)?d.comparison.previousStatus:'unknown'}}:{}),
    findings:(Array.isArray(d.findings)?d.findings:[]).filter(f=>codes.has(f?.code)).slice(0,100).map(f=>({code:f.code,severity:['notice','warning','info'].includes(f.severity)?f.severity:'notice'})),
    needsAnotherRequest:d.needsAnotherRequest===true||!!d.notice,observation:'local-diagnostic-not-cache-hit-proof'};
}
export function agentPayload(profile,diagnostic) {
  return {diagnostics:compactDiagnostic(diagnostic),proposalContext:{expectedVersion:profile.version,limits:clone(profile.limits),
    blocks:profile.blocks.map(b=>({id:b.id,role:b.role,scope:b.scope,stable:b.stable===true,approvedIndependent:b.approvedIndependent===true,cacheable:b.cacheable!==false,
      source:{kind:b.source?.kind},chars:typeof b.content==='string'?b.content.length:0})),allowedOperations:['reorder_blocks'],
    example:{expectedVersion:profile.version,reason:'Place approved stable sibling blocks first',operations:[{type:'reorder_blocks',scope:'exact scope from blocks',role:'system',ids:['complete permutation of sibling IDs']}]}}};
}
export function acceptedAgentProposal(proposal,version) {
  if(!proposal||typeof proposal!=='object'||Array.isArray(proposal)||Object.keys(proposal).some(k=>!['expectedVersion','reason','operations'].includes(k))||!Array.isArray(proposal.operations)||proposal.expectedVersion!==version)throw new Error('Agent 方案格式或版本不匹配；未应用任何改动。');
  return {schemaVersion:1,...clone(proposal)};
}
export function agentConfigWithBudget(config,settings) {
  if(!config?.enabled)throw new Error('先保存并启用服务端 Agent 配置。');
  if(!Number.isSafeInteger(settings.maxTests)||settings.maxTests<1||!safeNumber(settings.maxCost)||settings.maxCost<=0||!/^[A-Z]{3}$/.test(settings.currency))throw new Error('未配置有效的额外付费预算，不调用 Agent。');
  if(config.prices?.currency!==settings.currency)throw new Error('本地预算币种与服务端 Agent 价格币种不一致；先保存 Agent 配置。');
  const budget={maxCalls:settings.maxTests,maxCost:settings.maxCost,currency:settings.currency};
  if(JSON.stringify(config.budget)===JSON.stringify(budget))return null;
  const {hasKey,...safe}=config;return {...safe,apiKey:'',budget};
}
export function validatePriceTable(table) {
  if(!table||typeof table!=='object'||Array.isArray(table))throw new Error('价格表必须是 JSON 对象。');
  const entries=Object.entries(table);if(entries.length>200)throw new Error('价格表条目过多。');
  return Object.fromEntries(entries.map(([key,price])=>{
    if(['__proto__','prototype','constructor'].includes(key)||key.length>256||!price||typeof price!=='object'||Array.isArray(price))throw new Error('价格条目格式无效。');
    if(!/^[A-Z]{3}$/.test(price.currency)||typeof price.source!=='string'||!price.source.trim()||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(price.updatedAt)||!Number.isFinite(Date.parse(price.updatedAt)))throw new Error('每组价格需要有效 currency、source、updatedAt。');
    for(const [field,value] of Object.entries(price))if(![...priceKeys,'currency','source','updatedAt','note'].includes(field)||priceKeys.includes(field)&&!safeNumber(value))throw new Error('价格字段必须受支持，数值必须有限且非负。');
    return [key,clone(price)];
  }));
}
export function optionalCachePrices(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('缓存价格必须是 JSON 对象。');
  for(const [key,value] of Object.entries(input))if(!priceKeys.filter(x=>x.startsWith('cache')).includes(key)||!safeNumber(value))throw new Error('缓存价格只接受 cacheRead / cacheWrite / 对应 TTL 的非负数值。');
  return clone(input);
}
function safeSource(source) {
  try{const u=new URL(source);if(!['http:','https:'].includes(u.protocol))return null;return `${u.protocol}//${u.host}${u.pathname}`;}catch{return null;}
}
export function redactedExport({records=[],prices={},history=[],diagnosticFor=()=>({})}={}) {
  return {schemaVersion:1,redacted:true,compatibility:'SillyTavern 1.19.0',notice:'No prompt text, source names, history reasons, endpoint credentials or raw arbitrary metadata is included.',
    records:records.map((r,i)=>({id:`record-${i+1}`,model:label(r.model),provider:label(r.provider),interfaceType:label(r.interfaceType),purpose:purposes.has(r.purpose)?r.purpose:'unknown',
      observationLevel:label(r.observationLevel),startedAt:timestamp(r.startedAt??r.time),latencyMs:safeNumber(r.latencyMs)?r.latencyMs:null,usage:numericUsage(r.usage),status:label(r.status),transformed:r.transformed===true,
      platformBill:safeBill(r.platformBill),diagnostic:compactDiagnostic(diagnosticFor(r))})),
    prices:Object.fromEntries(Object.entries(prices).map(([key,p])=>[label(key),Object.fromEntries([['currency',label(p.currency)],['source',safeSource(p.source)],['sourceProvided',!!p.source],['updatedAt',/^\d{4}-\d{2}-\d{2}/.test(p.updatedAt??'')?p.updatedAt:null],...priceKeys.filter(k=>safeNumber(p[k])).map(k=>[k,p[k]])])])),
    history:history.map((t,i)=>({revision:i+1,at:timestamp(t.at),operationCount:Array.isArray(t.proposal?.operations)?t.proposal.operations.length:null,rollback:!!t.rollback}))};
}
function scrubContext(value,state) {
  if(typeof value==='string'){const clean=scrubString(value);if(clean!==value)state.redacted=true;return clean;}
  if(Array.isArray(value))return value.map(v=>scrubContext(v,state));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrubContext(v,state)]));
  return value;
}
export function importEvidence(data,{idPrefix=`import:${Date.now()}`}={}) {
  const items=Array.isArray(data)?data:Array.isArray(data?.records)?data.records:[data];
  if(items.length>200)throw new Error('一次最多导入 200 条记录。');
  return items.flatMap((item,i)=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||(!item.body&&!item.request&&!item.usage&&!item.platformBill&&!(data?.redacted===true&&item.diagnostic)))return [];
    const original=item.body??item.request??{};
    if(!original||typeof original!=='object'||Array.isArray(original))throw new Error('请求 body 必须是 JSON 对象。');
    const body=projectContext(original);
    for(const key of ['model','cache_control','prompt_cache_key','prompt_cache_retention','prompt_cache_options','thinking','output_config','reasoning','reasoning_effort','response_format','context_management','max_tokens','stream','tool_choice'])if(original[key]!==undefined)body[key]=clone(original[key]);
    const state={redacted:false};const safeBody=scrubContext(body,state);
    const record={id:`${idPrefix}:${i}`,body:safeBody,provider:label(item.provider??item.interfaceType),interfaceType:label(item.interfaceType),model:label(item.model??original.model),
      purpose:purposes.has(item.purpose)?item.purpose:'unknown',observationLevel:'imported',imported:true,status:'imported',sources:[],usage:numericUsage(item.usage),platformBill:safeBill(item.platformBill),
      startedAt:timestamp(item.startedAt??item.time),latencyMs:safeNumber(item.latencyMs)?item.latencyMs:null,
      redactedOnImport:state.redacted,observationNotice:state.redacted?'用户导入且已移除疑似凭据；内容已改变，不可用于证明原始前缀。':'用户导入证据；来源待核实，不能据此宣布实际节省。'};
    if(data?.redacted===true&&item.diagnostic){record.diagnostic=compactDiagnostic(item.diagnostic);record.archived=true;record.reportedStatus=label(item.status);record.observationNotice='导入的脱敏诊断；保留原记录的用量和差异结论，未包含提示词原文，不能重新比较或优化。';}
    if(item.prices){try{record.prices=validatePriceTable({imported:item.prices}).imported;}catch{/* Malformed price evidence stays unpriced. */}}
    return [record];
  });
}
