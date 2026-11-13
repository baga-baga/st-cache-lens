import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBudget } from '../adapters/agent-audit-budget.js';
import { buildAgentRequest } from '../server/agent.mjs';

const packet={requiredCalls:3,totalBytes:36000};
const config={enabled:true,interfaceType:'openai',endpoint:'https://example.invalid/v1/chat/completions',model:'test-model',budget:{maxCalls:10,maxCost:1,currency:'USD'},prices:{input:1,output:5,cacheWrite:2,currency:'USD'},maxOutputTokens:1024};
const status={config,ledger:{calls:2,chargedOrReserved:0.1,currency:'USD'}};
const settings={maxTests:10,maxCost:1,currency:'USD'};
test('audit whole-run preflight uses remaining overlapping budgets, including final synthesis and output',()=>{
 const r=auditBudget(packet,status,settings);assert.equal(r.ok,true);assert.equal(r.remainingCalls,8);assert.equal(r.remainingCost,0.9);assert.equal(r.reserveEstimate,((2*(36000+18000)+3*6000)*2+3*1024*5)/1e6);
 assert.equal(auditBudget(packet,status,{...settings,maxTests:4}).ok,false);
 assert.equal(auditBudget(packet,{...status,ledger:{...status.ledger,chargedOrReserved:0.99}},settings).ok,false);
 assert.equal(auditBudget(packet,{...status,config:{...config,budget:{...config.budget,maxCalls:4}}},settings).ok,false);
});
test('unknown ledger, zero budget and mismatched currencies cannot authorize generation',()=>{
 assert.throws(()=>auditBudget(packet,status,{...settings,maxCost:0}),/预算/);
 assert.throws(()=>auditBudget(packet,{...status,ledger:null},settings),/预算/);
 assert.throws(()=>auditBudget(packet,status,{...settings,currency:'CNY'}),/币种/);
 assert.throws(()=>auditBudget(packet,{...status,config:{...config,enabled:false}},settings),/保存/);
 assert.throws(()=>auditBudget(packet,{...status,config:{...config,maxOutputTokens:NaN}},settings),/不完整/);
});
test('preflight input bound covers existing server request wrapping even for escape-heavy pages',()=>{
 const data=JSON.stringify({diagnostics:{value:'"\\'.repeat(4000)}});
 const bytes=Buffer.byteLength(data);
 assert.ok(Buffer.byteLength(JSON.stringify(buildAgentRequest(config,data)))+2048<=2*bytes+6000);
 const anthropic={...config,interfaceType:'anthropic',endpoint:'https://example.invalid/v1/messages'};
 assert.ok(Buffer.byteLength(JSON.stringify(buildAgentRequest(anthropic,data)))+2048<=2*bytes+6000);
});
