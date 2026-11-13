import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatchPolicy, BATCH_ALGORITHM } from '../adapters/batch-runner.js';
import { buildBatchPlan } from '../adapters/batch-plan.js';
import { transformWithProfile } from '../adapters/pipeline.js';

const limits={maxInputTokens:50000,contextTokens:64000,outputReserveTokens:4096};
const policy={enabled:true,version:3,algorithm:BATCH_ALGORITHM,connection:{provider:'custom',model:'body-model'}};
function fixture(card='one',dynamicText='本轮人物位于城堡。') {
 const sources=[['dynamic',dynamicText,false],['stable','世界共有两片大陆。',true]].map(([id,text,constant])=>({id:'world:'+card+':'+id,kind:'world-info',provenance:'WORLD_INFO_ACTIVATED',text:'<资料>'+text+'</资料>',entry:{uid:id,world:card,content:'<资料>'+text+'</资料>',constant,key:constant?[]:['人物'],position:0,depth:4,role:0,order:50}}));
 const body={model:'body-model',chat_completion_source:'custom',messages:[{role:'system',content:'<世界书>\n'+sources.map(s=>s.text).join('\n')+'\n</世界书>'},{role:'user',content:'继续剧情'}]};
 const meta={sources,chatId:'chat-'+card,characterId:card,groupId:null,model:'body-model',provider:'custom',interfaceType:'openai',purpose:'main',snapshot:{activationEventSeen:true,generation:{type:'normal',dryRun:false}}};
 return {body,meta};
}
test('portable authorized policy rebuilds each card from fresh activated text with no native mutations',()=>{
 const a=fixture(),before=structuredClone(a),first=runBatchPolicy(a.body,a.meta,policy,limits);
 assert.equal(first.result.applied,true,first.result.reason);assert.deepEqual(a,before);
 assert.ok(first.body.messages[0].content.indexOf('世界共有')<first.body.messages[0].content.indexOf('本轮人物'));
 const b=fixture('two','人物现在已经离开城堡。'),second=runBatchPolicy(b.body,b.meta,policy,limits);
 assert.equal(second.result.applied,true);assert.ok(second.body.messages[0].content.includes('已经离开'));assert.ok(!second.body.messages[0].content.includes('本轮人物位于'));
 assert.deepEqual(first.body.messages.map(m=>m.role),a.body.messages.map(m=>m.role));assert.equal(first.result.expectedImpact.cacheSavingsVerified,false);
});
test('portable policy never mixes summary, unknown purpose or another connection',()=>{
 for(const change of [{purpose:'summary'},{purpose:'unknown'},{provider:'claude'},{model:'other'}]){
  const {body,meta}=fixture();const r=runBatchPolicy(body,{...meta,...change},policy,limits);assert.equal(r.result.applied,false);assert.equal(r.body,body);
 }
 const {body,meta}=fixture();assert.equal(runBatchPolicy(body,meta,{...policy,algorithm:'unknown'},limits).body,body);
});
test('runtime budget overflow, lost provenance and changed activation membership skip safely',()=>{
 const {body,meta}=fixture();body.messages.push({role:'user',content:'x'.repeat(1500000)});
 assert.equal(runBatchPolicy(body,meta,policy,limits).result.applied,false);
 const missing=fixture();missing.meta.sources[0].provenance='text-match-only';assert.equal(runBatchPolicy(missing.body,missing.meta,policy,limits).result.applied,false);
 const absent=fixture();absent.body.messages[0].content=absent.meta.sources[1].text;assert.equal(runBatchPolicy(absent.body,absent.meta,policy,limits).result.applied,false);
});
test('missing, dry-run or stale-generation activation evidence cannot authorize runtime sorting',()=>{
 for(const snapshot of [null,{activationEventSeen:false,generation:{}},{activationEventSeen:true,generation:null},{activationEventSeen:true,generation:{dryRun:true}}]){
  const {body,meta}=fixture();const r=runBatchPolicy(body,{...meta,snapshot},policy,limits);assert.equal(r.result.applied,false);assert.equal(r.body,body);
 }
});
test('explicit non-group binding cannot be applied to a group or unknown group scope',()=>{
 const {body,meta}=fixture();const record={...meta,body,observationLevel:'frontend',status:'complete'};
 const plan=buildBatchPlan({record,setup:{complete:true,batchAuthorized:true},limits});assert.equal(plan.canApply,true);
 for(const groupId of ['new-group',undefined]){const trace={};assert.deepEqual(transformWithProfile(body,plan.preview.after,{binding:{...meta,groupId},record:trace}),body);assert.equal(trace.structureTransformation.applied,false);}
 const trace={};transformWithProfile(body,plan.preview.after,{binding:meta,record:trace});assert.equal(trace.structureTransformation.applied,true);
});
