import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrial } from '../core/evaluation.js';
const prices = { currency:'USD',source:'test configured rates',updatedAt:'2026-11-12',rates:{input:10,cacheRead:1,cacheWrite:12.5,output:30} };
function request(id,{purpose='main',read=0,input=10000,model='main-model',provider='anthropic'}={}) {
  return {id,purpose,model,provider,interfaceType:'anthropic',observationLevel:'server-relay',usage:{input_tokens:input,cache_creation_input_tokens:0,cache_read_input_tokens:read,output_tokens:100},prices,latencyMs:1000};
}
const baseline=[request('b1'),request('b2'),request('bs',{purpose:'summary',model:'summary-model',input:1000})];
const candidate=[request('c1',{input:2000,read:8000}),request('c2',{input:2000,read:8000}),request('cs',{purpose:'summary',model:'summary-model',input:1000})];

test('actual main+summary+Agent window costs compared, never cache ratio alone',()=>{
 const result=evaluateTrial({baseline,candidate,agentCosts:[request('a',{purpose:'agent',model:'agent-model',input:500})],quality:'pass'});
 assert.equal(result.decision,'keep');assert.ok(result.savings.amount>0);assert.equal(result.causalClaim,false);
 assert.equal(result.candidate.groups.filter(g=>g.purpose==='agent').length,1);
 assert.equal(result.mayContinuePaidTests,false);
});

test('large optimizer overhead outweighs improved cache reads and triggers rollback',()=>{
 const result=evaluateTrial({baseline,candidate,agentCosts:[request('a',{purpose:'agent',model:'agent-model',input:1000000})],quality:'pass'});
 assert.equal(result.decision,'rollback');assert.ok(result.savings.amount<0);assert.equal(result.shouldStopPaidTests,true);
});

test('missing usage, simulated records, mixed currencies or unequal main turns are inconclusive',()=>{
 for(const altered of [
  candidate.map((r,i)=>i===0?{...r,usage:null}:r),
  candidate.map((r,i)=>i===0?{...r,synthetic:true}:r),
  candidate.map((r,i)=>i===0?{...r,prices:{...prices,currency:'CNY'}}:r),
  candidate.slice(1),
 ]) assert.equal(evaluateTrial({baseline,candidate:altered,quality:'pass'}).decision,'inconclusive');
});

test('quality gate blocks keep and quality failure forces rollback even if cost falls',()=>{
 assert.equal(evaluateTrial({baseline,candidate}).decision,'await-quality-review');
 assert.equal(evaluateTrial({baseline,candidate,quality:'fail'}).decision,'rollback');
});

test('stop after no improvement, budget exhaustion or observed input violation',()=>{
 const same=baseline.map((r,i)=>({...r,id:'copy'+i}));
 assert.equal(evaluateTrial({baseline,candidate:same,quality:'pass'}).decision,'no-improvement');
 const result=evaluateTrial({baseline,candidate,quality:'pass',limits:{maxPaidTestCalls:2,maxPaidTestCost:1,currency:'USD',maxInputTokens:500},paidTestCount:2,paidTestCost:{amount:1,currency:'USD'}});
 assert.equal(result.shouldStopPaidTests,true);assert.ok(result.stopReasons.some(r=>/input exceeds/.test(r)));
});

test('explicit duplicate correlation coalesces frontend/relay records but unrelated captures do not',()=>{
 const paired=candidate.flatMap(r=>[{...r,id:r.id+'front',correlationId:r.id,observationLevel:'frontend'},{...r,correlationId:r.id}]);
 const result=evaluateTrial({baseline,candidate:paired,quality:'pass'});
 assert.equal(result.candidate.requests,3);assert.equal(result.decision,'keep');
 const mixed=[...candidate,{...candidate[0],id:'other-front',observationLevel:'frontend'}];
 assert.equal(evaluateTrial({baseline,candidate:mixed,quality:'pass'}).decision,'inconclusive');
});

test('a platform bill replaces calculated cost; it is not counted twice',()=>{
 const modified=candidate.map(r=>({...r,platformBill:{amount:0.001,currency:'USD'}}));
 const result=evaluateTrial({baseline,candidate:modified,quality:'pass'});
 assert.equal(result.candidate.totalCost,0.003);assert.equal(result.candidate.costMethods[0],'user-imported-platform-bill');
});
