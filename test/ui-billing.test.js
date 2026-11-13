import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerRecords, observationLayer, agentObservation, trialInput, compactDiagnostic, agentPayload, acceptedAgentProposal, agentConfigWithBudget, validatePriceTable, optionalCachePrices, redactedExport, importEvidence, numericUsage, pricedObservation } from '../adapters/reporting.js';
import { evaluateTrial } from '../core/evaluation.js';
import { createProfile, previewProposal } from '../core/optimizer.js';
const prices={currency:'USD',source:'https://price.example/table',updatedAt:'2026-11-12',input:4,output:20,cacheRead:.2,cacheWrite:5};
const usage={input_tokens:100,cache_creation_input_tokens:0,cache_read_input_tokens:1000,output_tokens:20};
const observed=(id,extra={})=>({id,provider:'anthropic',interfaceType:'anthropic',model:'story',purpose:'main',observationLevel:'frontend',usage,prices,status:'complete',...extra});

test('ledger uses one capture layer and each actual Agent record once',()=>{
 const items=[observed('f'),observed('r',{observationLevel:'server-relay'}),observed('a',{observationLevel:'agent-server',purpose:'agent'}),observed('imp',{observationLevel:'imported',imported:true,purpose:'agent'})];
 assert.deepEqual(ledgerRecords(items,'frontend').map(r=>r.id),['f','a']);
 assert.deepEqual(ledgerRecords(items,'relay').map(r=>r.id),['r','a']);
 assert.deepEqual(ledgerRecords([...items,items[2]],'agent').map(r=>r.id),['a']);
 assert.equal(observationLayer({...items[0],imported:true}),'import');
});

test('historical Agent record preserves its price snapshot and schema',()=>{
 const a=agentObservation(observed('one',{interfaceType:'deepseek',purpose:'agent',prices:{...prices,input:.1},time:'2026-11-12T01:00:00.000Z'}));
 assert.equal(a.observationLevel,'agent-server');assert.equal(a.interfaceType,'deepseek');assert.equal(a.prices.input,.1);assert.equal(a.id,'agent:one');
 assert.deepEqual(agentObservation({id:'old'}).prices,{});
});

test('trial receives correct budgets, ledger reservations and no duplicate capture',()=>{
 const records=[observed('before'),observed('after',{usage:{...usage,input_tokens:50}}),observed('agent',{purpose:'agent',observationLevel:'agent-server',model:'small',usage:{...usage,input_tokens:2,output_tokens:1,cache_read_input_tokens:0}})];
 const settings={maxTests:3,maxCost:1,currency:'USD',maxInputTokens:2000,prices:{}};
 const input=trialInput({records,baselineIds:['before'],layer:'frontend',settings,serverStatus:{ledger:{calls:1,chargedOrReserved:.02,currency:'USD'}},quality:'pass'});
 assert.equal(input.limits.maxPaidTestCalls,3);assert.equal(input.limits.maxPaidTestCost,1);assert.equal(input.paidTestCost.amount,.02);
 const result=evaluateTrial(input);assert.equal(result.candidate.invalidEvidence,0);assert.equal(result.candidate.requests,2);assert.equal(result.decision,'keep');
});

test('evicted baseline or pending request leaves observation window incomplete',()=>{
 const input=trialInput({records:[observed('after')],baselineIds:['missing'],settings:{},quality:'pass'});assert.equal(input.completed,false);
 const pending=trialInput({records:[observed('before'),observed('after',{status:'pending'})],baselineIds:['before']});assert.equal(pending.completed,false);
});

test('Agent request omits narrative/source names and examples match server proposal schema',()=>{
 const profile={version:3,limits:{maxInputTokens:10000},blocks:[{id:'b1',role:'system',scope:'system',content:'SECRET_NARRATIVE',source:{kind:'worldbook',name:'SECRET_BOOK'},stable:true,secret:'SKIP'}]};
 const payload=agentPayload(profile,{firstDifference:{currentPath:'messages[0].content',kind:'content',currentExcerpt:{escaped:'SECRET_DIFF'}}});
 const text=JSON.stringify(payload);assert.ok(!text.includes('SECRET'));assert.equal(payload.proposalContext.example.schemaVersion,undefined);
 assert.equal(payload.proposalContext.blocks[0].chars,16);assert.equal(payload.diagnostics.firstDifference.path,'messages[0].content');
});

test('accepted server proposal gets deterministic local schema version, then strict validation',()=>{
 const profile=createProfile({mode:'preview',blocks:[{id:'a',content:'stable facts',role:'system',scope:'s',approvedIndependent:true,source:{kind:'preset'}},{id:'b',content:'other facts',role:'system',scope:'s',approvedIndependent:true,source:{kind:'worldbook'}}],limits:{maxInputTokens:10000,contextTokens:20000,outputReserveTokens:1000}});
 const proposal=acceptedAgentProposal({expectedVersion:profile.version,reason:'reorder',operations:[{type:'reorder_blocks',role:'system',scope:'s',ids:['b','a']}]},profile.version);
 assert.equal(proposal.schemaVersion,1);assert.equal(previewProposal(profile,proposal,{byteLevelTokenizer:true,otherInputUpperBound:100}).ok,true);
 assert.throws(()=>acceptedAgentProposal({expectedVersion:0,reason:'bad',operations:[],tool_calls:[]},profile.version));
 assert.throws(()=>acceptedAgentProposal({expectedVersion:999,operations:[]},profile.version));
});

test('local changed budget is synchronized before Agent call without exposing key',()=>{
 const cfg={enabled:true,interfaceType:'anthropic',endpoint:'https://api.example/v1/messages',hasKey:true,prices,budget:{maxCalls:50,maxCost:50,currency:'USD'}};
 const newConfig=agentConfigWithBudget(cfg,{maxTests:2,maxCost:.2,currency:'USD'});assert.equal(newConfig.budget.maxCost,.2);assert.equal(newConfig.apiKey,'');assert.equal(newConfig.hasKey,undefined);
 assert.throws(()=>agentConfigWithBudget(cfg,{maxTests:0,maxCost:1,currency:'USD'}));
 assert.throws(()=>agentConfigWithBudget(cfg,{maxTests:1,maxCost:1,currency:'CNY'}));
});

test('untrusted import uses allowlist, strips credentials and forged cost/usage evidence',()=>{
 const records=importEvidence({body:{model:'m',messages:[{role:'user',content:'  keep\n\u200b exact  '}],headers:{authorization:'secret'},api_key:'dont-store'},usage:{input_tokens:5,output_tokens:2,api_key:'secret',mystery:{password:'secret'}},provider:'anthropic',interfaceType:'anthropic',purpose:'main',normalizedUsage:{complete:true,totalInput:0},prices,observationLevel:'server-relay',cost:{amount:0},headers:{Authorization:'secret'},apiKey:'secret'}, {idPrefix:'test'});
 const r=records[0];assert.equal(r.body.messages[0].content,'  keep\n\u200b exact  ');assert.equal(r.observationLevel,'imported');assert.equal(r.normalizedUsage,undefined);assert.equal(r.cost,undefined);assert.equal(r.apiKey,undefined);assert.equal(r.body.api_key,undefined);assert.equal(r.usage.api_key,undefined);
 assert.equal(evaluateTrial({baseline:[observed('a')],candidate:records,quality:'pass'}).decision,'inconclusive');
});

test('imported literal API key is removed with explicit changed-content notice',()=>{
 const r=importEvidence({body:{messages:[{role:'user',content:'Bearer abcdef12345678'}]},usage})[0];
 assert.equal(r.redactedOnImport,true);assert.match(r.observationNotice,/内容已改变/);assert.ok(!JSON.stringify(r).includes('abcdef12345678'));
});

test('default export omits prompts, source names, history reasons and private price query',()=>{
 const r=observed('secret-id',{body:{system:'SECRET_STORY'},sources:[{name:'SECRET_BOOK'}],usage:{...usage,api_key:'SECRET_KEY'},platformBill:{amount:.3,currency:'USD',note:'SECRET_NOTE'}});
 const exported=redactedExport({records:[r],prices:{story:{...prices,source:'https://prices.example/table?api_key=SECRET_QUERY'}},history:[{reason:'SECRET_REASON',proposal:{operations:[{}],secret:'SECRET_PLAN'},impact:{text:'SECRET_IMPACT'}}],diagnosticFor:()=>({firstDifference:{kind:'content',currentPath:'system',currentExcerpt:{escaped:'SECRET_DIFF'}}})});
 const text=JSON.stringify(exported);assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('secret-id'));assert.equal(exported.prices.story.source,'https://prices.example/table');assert.equal(exported.records[0].usage.input_tokens,100);
});

test('price validation rejects non-finite values and preserves missing prices as unknown',()=>{
 assert.throws(()=>validatePriceTable({x:{...prices,input:Infinity}}));assert.throws(()=>validatePriceTable({x:{...prices,output:-1}}));
 assert.throws(()=>validatePriceTable({x:{...prices,updatedAt:'secret free text'}}));
 const rates=validatePriceTable({x:{currency:'USD',source:'manual known',updatedAt:'2026-11-12'}}).x;
 assert.equal(pricedObservation(observed('x',{prices:rates})).cost.amount,null);
 assert.deepEqual(optionalCachePrices({cacheRead:0,cacheWrite1h:8}),{cacheRead:0,cacheWrite1h:8});assert.throws(()=>optionalCachePrices({apiKey:'no'}));
});

test('numeric usage strips arbitrary nested metadata and never fabricates absent values',()=>{
 assert.deepEqual(numericUsage({input_tokens:3,input_tokens_details:{cached_tokens:2,secret:'no'},headers:{secret:2}}),{input_tokens:3,input_tokens_details:{cached_tokens:2}});
 assert.equal(numericUsage({api_key:'no'}),null);assert.equal(compactDiagnostic({}).stablePrefixCharacters,null);
});

test('compact diagnostics survive repeated redaction with offsets and failed comparison provenance',()=>{
 const diagnostic={equal:false,comparable:true,stablePrefixCharacters:66839,firstDifference:{currentPath:'messages[21].content',kind:'structure',offset:0,currentExcerpt:{escaped:'PRIVATE'}},comparison:{previousStartedAt:'2026-11-12T16:37:21.395Z',previousStatus:'http-error',apiKey:'PRIVATE'},findings:[{code:'SUMMARY_REWRITE',severity:'notice',source:'PRIVATE'},{code:'PRIVATE',severity:'notice'}]};
 const compact=compactDiagnostic(diagnostic);assert.deepEqual(compactDiagnostic(compact),compact);
 assert.equal(compact.firstDifference.offset,0);assert.equal(compact.comparison.previousStatus,'http-error');
 assert.equal(JSON.stringify(compact).includes('PRIVATE'),false);
 const malicious=compactDiagnostic({firstDifference:{path:'secret body',kind:'PRIVATE'},findings:[{code:'SECRET_CONTENT'}]});
 assert.equal(malicious.firstDifference.path,null);assert.deepEqual(malicious.findings,[]);
});

test('redacted usage-less Claude diagnostic imports without silently discarding it or claiming server evidence',()=>{
 const data={redacted:true,records:[{model:'story',provider:'custom',interfaceType:'openai',purpose:'main',status:'http-error',observationLevel:'frontend',usage:null,diagnostic:{stablePrefixCharacters:33342,firstDifference:{path:'messages[6].content',kind:'content',offset:31706},findings:[]}}]};
 const [record]=importEvidence(data);assert.ok(record);assert.equal(record.usage,null);assert.equal(record.observationLevel,'imported');assert.equal(record.reportedStatus,'http-error');assert.equal(record.diagnostic.firstDifference.path,'messages[6].content');assert.equal(record.diagnostic.firstDifference.offset,31706);
 assert.equal(record.archived,true);assert.deepEqual(record.body,{});assert.match(record.observationNotice,/不能重新比较或优化/);
 const exported=redactedExport({records:[record],diagnosticFor:r=>r.diagnostic});assert.equal(exported.records[0].diagnostic.stablePrefixCharacters,33342);
});
