import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSetup } from '../core/batch-diagnostics.js';
const limits={maxInputTokens:160000,contextTokens:200000,outputReserveTokens:8000};
const makeEntry=(uid,content,extra={})=>({uid,world:'Private Book',comment:`Entry ${uid}`,content,constant:false,vectorized:false,disable:false,key:['PRIVATE_TRIGGER'],order:100,position:0,depth:4,role:0,...extra});
const baseEntries=()=>[makeEntry(1,'Stable foundation '+'.'.repeat(45),{constant:true}),makeEntry(2,'Conditional topic A '+'.'.repeat(45)),makeEntry(3,'Conditional topic B '+'.'.repeat(45),{vectorized:true})];
const makeSetup=(entries=baseEntries(),extra={})=>({schemaVersion:1,compatibility:{version:'1.19.0',verifiedSource:true},binding:{chatId:'current',provider:'custom',model:'claude',purpose:'main'},
 books:[{id:'book-N',name:'Private Book',boundBy:['global'],loaded:true,entries}],worldSettings:{world_info_budget:25,world_info_budget_cap:50000},preset:{order:[],prompts:[]},extensionSources:[],complete:true,truncated:false,counts:{booksExpected:1},...extra});
const sources=entries=>entries.map(e=>({id:`world:${e.world}:${e.uid}`,kind:'world-info',text:e.content,entry:e}));
const record=(id,entries,extra={})=>({id,chatId:'current',provider:'custom',interfaceType:'openai',model:'claude',purpose:'main',observationLevel:'frontend',status:'complete',body:{messages:[{role:'system',content:entries.map(e=>e.content).join('\n')}]},sources:sources(entries),world:{activationEventSeen:true,activeEntries:entries,budgetTokens:50000},usage:null,...extra});

test('batch counts every bound book and separates disabled/constant/keyword/vector modes',()=>{
 const es=[...baseEntries(),makeEntry(4,'off',{disable:true}),makeEntry(5,'unknown',{key:[]})];
 const r=analyzeSetup(makeSetup(es),{limits});assert.deepEqual([r.counts.entries,r.counts.constant,r.counts.keyword,r.counts.vector,r.counts.disabled,r.counts.conditionalOrUnknown],[5,1,1,1,1,1]);
 assert.equal(r.safety.canPrepareCandidate,true);assert.equal(r.safety.automaticModificationAuthorized,false);
 assert.equal(r.worldQuantities.budget.derivedLimit.value,50000);assert.equal(r.worldQuantities.worldInfoFinalSentTokens,null);
});

test('100 percent keyword probability does not become constant or a stable block',()=>{
 const e=makeEntry(9,'key matched content',{probability:100,useProbability:true});
 const r=analyzeSetup(makeSetup([e]),{records:[record('a',[e]),record('b',[e])],limits});
 const row=r.inventory.entries[0];assert.equal(row.triggerMode,'keyword');assert.equal(row.configuredConstant,false);assert.equal(row.observedStable,true);assert.equal(row.stabilityCandidate,false);assert.equal(row.stable,false);
});

test('constant with macro or dynamic snapshot syntax is not automatically stable',()=>{
 const e=makeEntry(1,'Variable {{getvar::time}} status_current_variables',{constant:true});
 const r=analyzeSetup(makeSetup([e]),{records:[record('a',[e]),record('b',[e])],limits});
 assert.equal(r.inventory.entries[0].observedStable,true);assert.equal(r.inventory.entries[0].stable,false);
});

test('constant stability requires repeated exact matches in current bound request group',()=>{
 const e=baseEntries()[0];
 const r=analyzeSetup(makeSetup([e]),{records:[record('a',[e]),record('b',[e])],limits});
 assert.equal(r.inventory.entries[0].stable,true);assert.equal(r.inventory.entries[0].observations,2);
 const other=analyzeSetup(makeSetup([e]),{records:[record('a',[e],{purpose:'summary',model:'deepseek'}),record('b',[e],{purpose:'summary',model:'deepseek'})],limits});
 assert.equal(other.inventory.entries[0].stable,false);assert.equal(other.inventory.entries[0].observedStable,false);
});

test('1.5 million whole-book estimate is not actual sent input or a reason to disable bounded on-demand use',()=>{
 const e=makeEntry(1,'x'.repeat(4500000));const r=analyzeSetup(makeSetup([e]),{limits});
 assert.equal(r.worldQuantities.wholeBook.value,1500000);assert.equal(r.worldQuantities.wholeBook.kind,'estimate');
 assert.ok(r.settingsFindings.some(f=>f.code==='WHOLE_BOOK_VOLUME_1500000'));
 assert.equal(r.worldQuantities.finalInput.length,0);assert.equal(r.safety.canPrepareCandidate,true);
 assert.ok(!r.settingsFindings.some(f=>f.code==='REPORTED_INPUT_OVER_USER_LIMIT'));
 assert.ok(JSON.stringify(r).length<40000);
});

test('1.5 million budget, activation estimate, whole book and usage total are different quantities',()=>{
 const es=baseEntries(),rr=record('a',es,{world:{activationEventSeen:true,activeEntries:[es[1]],budgetTokens:1500000},usage:{prompt_tokens:1234,prompt_tokens_details:{cached_tokens:1000},completion_tokens:50}});
 const r=analyzeSetup(makeSetup(es),{records:[rr],limits});
 assert.equal(r.requestGroups[0].requests[0].budget.value,1500000);assert.equal(r.worldQuantities.finalInput[0].value,1234);
 assert.equal(r.worldQuantities.activated[0].count,1);assert.ok(r.worldQuantities.wholeBook.value<1234);
 assert.equal(r.worldQuantities.worldInfoFinalSentTokens,null);
});

test('missing books, missing activation, missing usage remain unknown and block preparation when collection incomplete',()=>{
 const setup=makeSetup([], {books:[],complete:false,optimizationBlocked:true,counts:{booksExpected:2}});
 const r=analyzeSetup(setup,{records:[record('a',[],{world:{},usage:null})],limits});
 assert.equal(r.worldQuantities.wholeBook.value,null);assert.equal(r.coverage.missingBooks,2);assert.equal(r.safety.canPrepareCandidate,false);
 assert.equal(r.worldQuantities.activated[0].count,null);assert.equal(r.worldQuantities.finalInput[0].value,null);
 assert.equal(r.requestGroups[0].requests[0].cacheRead,null);
});

test('explicit empty activation is known zero while no activation event is unknown',()=>{
 const r=analyzeSetup(makeSetup(),{records:[record('a',[],{world:{activationEventSeen:true,activeEntries:[]}}),record('b',[],{world:{}})],limits});
 assert.equal(r.worldQuantities.activated[0].count,0);assert.equal(r.worldQuantities.activated[1].count,null);
});

test('large constant volume and ignoreBudget are configuration risks, not historical inflation proof',()=>{
 const es=Array.from({length:25},(_,i)=>makeEntry(i,'fixed text '+i,{constant:true,ignoreBudget:i===0}));
 const r=analyzeSetup(makeSetup(es),{limits});
 assert.equal(r.counts.ignoreBudget,1);assert.ok(r.settingsFindings.some(f=>f.code==='BUDGET_BYPASS_ENABLED'));
 const f=r.settingsFindings.find(f=>f.code==='LARGE_CONSTANT_SET');assert.equal(f.historicalInflationConfirmed,false);
});

test('shared configured order does not claim nondeterministic sorting',()=>{
 const r=analyzeSetup(makeSetup(),{limits});
 const f=r.settingsFindings.find(f=>f.code==='SHARED_INSERTION_ORDER');assert.ok(f);assert.equal(f.nondeterminismConfirmed,false);
 assert.ok(!r.settingsFindings.some(f=>f.code==='OBSERVED_ENTRY_ORDER_CHANGED'));
});

test('activation set change is distinct from permutation of identical active entries',()=>{
 const es=baseEntries();
 const changed=analyzeSetup(makeSetup(es),{records:[record('a',[es[0],es[1]]),record('b',[es[0],es[2]])],limits});
 assert.ok(changed.settingsFindings.some(f=>f.code==='ACTIVATION_SET_CHANGED'));
 assert.ok(!changed.settingsFindings.some(f=>f.code==='OBSERVED_ENTRY_ORDER_CHANGED'));
 assert.deepEqual(changed.requestGroups[0].comparisons[0].activationChange.entered,['b1:e3']);
 const reordered=analyzeSetup(makeSetup(es),{records:[record('a',es),record('b',[es[0],es[2],es[1]])],limits});
 assert.ok(reordered.settingsFindings.some(f=>f.code==='OBSERVED_ENTRY_ORDER_CHANGED'));
 assert.ok(!reordered.settingsFindings.some(f=>f.code==='ACTIVATION_SET_CHANGED'));
});

test('earliest conditional world source difference is tracked with opaque refs and no unique cache-cause claim',()=>{
 const es=baseEntries(),r=analyzeSetup(makeSetup(es),{records:[record('a',[es[0],es[1]]),record('b',[es[0],es[2]])],limits});
 const c=r.requestGroups[0].comparisons[0];assert.equal(c.firstDifference.path,'messages[0].content');assert.equal(c.firstDifference.previousSources[0].ref,'b1:e2');assert.equal(c.firstDifference.sources[0].ref,'b1:e3');
 assert.equal(c.cacheCauseEstablished,false);assert.equal(c.actualCacheRead,null);
 assert.ok(r.settingsFindings.some(f=>f.code==='DYNAMIC_WORLD_SOURCE_AT_EARLIEST_DIFF'));
});

test('source scope movement is identified and never authorizes cross-role mutation',()=>{
 const e=baseEntries()[0],a=record('a',[e]),b=record('b',[e],{body:{messages:[{role:'user',content:e.content}]}});
 const r=analyzeSetup(makeSetup([e]),{records:[a,b],limits});
 assert.ok(r.settingsFindings.some(f=>f.code==='SOURCE_SCOPE_CHANGED'));assert.equal(r.inventory.entries[0].stable,false);
 assert.equal(r.safety.requiresSameRoleAndScope,true);assert.ok(r.actions.every(a=>a.autoApplicable===false));
});

test('Claude, summary model, another chat and server layer are not compared as adjacent same-channel requests',()=>{
 const es=baseEntries(),r=analyzeSetup(makeSetup(es),{records:[record('a',es),record('b',es,{model:'deepseek',purpose:'summary'}),record('c',es,{chatId:'other'}),record('d',es,{observationLevel:'server-relay'})],limits});
 assert.equal(r.requestGroups.length,4);assert.ok(r.requestGroups.every(g=>g.comparisons.length===0));
});

test('failed-request comparison is clearly marked with explicit previous/current refs',()=>{
 const es=baseEntries(),r=analyzeSetup(makeSetup(es),{records:[record('a',es,{status:'http-error'}),record('b',es)],limits});
 const c=r.requestGroups[0].comparisons[0];assert.equal(c.previous,'r1');assert.equal(c.current,'r2');assert.equal(c.includesFailedRequest,true);
});

test('exact configured duplicates do not imply duplicate injection; related content does not count',()=>{
 const es=[makeEntry(1,'Exact duplicated paragraph.'.repeat(3)),makeEntry(2,'Exact duplicated paragraph.'.repeat(3)),makeEntry(3,'A related character with different facts and wording.'.repeat(2))];
 const r=analyzeSetup(makeSetup(es),{records:[record('a',[es[0]])],limits});
 assert.equal(r.duplicateGroups.length,1);assert.equal(r.duplicateGroups[0].injectionConfirmed,false);assert.equal(r.duplicateGroups[0].automaticRemovalAllowed,false);
 assert.equal(r.requestGroups[0].requests[0].duplicateInjections.length,0);
 const repeated=analyzeSetup(makeSetup(es),{records:[record('a',[es[0],es[1]])],limits});
 assert.ok(repeated.requestGroups[0].requests[0].duplicateInjections.length>0);assert.ok(repeated.settingsFindings.some(f=>f.code==='EXACT_REPEATED_REQUEST_TEXT'));
});

test('preset/world exact duplicate is reported without exporting either text',()=>{
 const e=baseEntries()[0],setup=makeSetup([e],{preset:{order:[{identifier:'private-prompt',enabled:true}],prompts:[{identifier:'private-prompt',name:'Private Prompt',role:'system',content:e.content}]}});
 const r=analyzeSetup(setup,{limits});assert.equal(r.duplicateGroups.length,1);assert.deepEqual(r.duplicateGroups[0].refs,['b1:e1','p1']);
 assert.ok(!JSON.stringify(r).includes(e.content));
});

test('unknown extension stays read-only and summary source flag is explicitly limited',()=>{
 const setup=makeSetup([], {extensionSources:[{id:'extension:private-summary',key:'private-summary',text:'SECRET_SUMMARY',role:0,depth:4}]});
 const a=record('a',[],{sources:[{id:'extension:private-summary',kind:'history-summary',text:'old memory'}]}),b=record('b',[],{sources:[{id:'extension:private-summary',kind:'history-summary',text:'new memory'}]});
 const r=analyzeSetup(setup,{records:[a,b],limits});assert.equal(r.extensions[0].access,'read-only');
 assert.match(r.requestGroups[0].comparisons[0].flags.find(f=>f.code==='SUMMARY_REWRITE').evidence,/actual injection/);
 assert.ok(!JSON.stringify(r).includes('SECRET_SUMMARY'));
});

test('Agent digest excludes every private name, text, trigger and chat ID, including metadata on unknown coverage',()=>{
 const e=makeEntry(1,'SECRET_CONTENT',{comment:'PRIVATE_TITLE',group:'PRIVATE_GROUP',key:['PRIVATE_TRIGGER']});
 const setup=makeSetup([e],{binding:{chatId:'PRIVATE_CHAT',model:'PRIVATE_MODEL',provider:'custom',purpose:'main'},extensionSources:[{id:'PRIVATE_EXTENSION',text:'SECRET_EXT',name:'PRIVATE_NAME'}],coverageUnknown:[{code:'THIRD_PARTY_IMPLEMENTATIONS_READ_ONLY',content:'SECRET_COVERAGE'}]});
 const r=analyzeSetup(setup,{records:[record('a',[e],{chatId:'PRIVATE_CHAT',model:'PRIVATE_MODEL'})],limits});
 const digest=JSON.stringify(r.agentDigest);for(const secret of ['SECRET_CONTENT','PRIVATE_TITLE','PRIVATE_GROUP','PRIVATE_TRIGGER','Private Book','PRIVATE_CHAT','PRIVATE_MODEL','PRIVATE_EXTENSION','SECRET_EXT','PRIVATE_NAME','SECRET_COVERAGE'])assert.ok(!digest.includes(secret),secret);
 assert.ok(!JSON.stringify(r).includes('PRIVATE_TRIGGER'));assert.ok(!JSON.stringify(r).includes('SECRET_CONTENT'));assert.ok(!JSON.stringify(r).includes('SECRET_COVERAGE'));
 assert.equal(r.agentDigest.noExternalCallMade,true);
});

test('digest stays bounded while full local inventory counts every entry and declares omissions',()=>{
 const es=Array.from({length:1000},(_,i)=>makeEntry(i,'text '+i,{ignoreBudget:i%2===0,probability:100,useProbability:true}));
 const r=analyzeSetup(makeSetup(es),{limits});assert.equal(r.inventory.entries.length,1000);assert.equal(r.agentDigest.counts.entries,1000);
 assert.equal(r.agentDigest.coverage.digestTruncated,true);assert.ok(r.agentDigest.coverage.entriesOmitted>0);assert.ok(new TextEncoder().encode(JSON.stringify(r.agentDigest)).length<=14500);
});

test('analysis does not mutate the snapshot or observed requests',()=>{
 const setup=makeSetup(),records=[record('a',baseEntries()),record('b',baseEntries())],before=JSON.stringify({setup,records});
 analyzeSetup(setup,{records,limits});assert.equal(JSON.stringify({setup,records}),before);
});

test('configured tiny digest cap is enforced including its omission metadata',()=>{
 const es=Array.from({length:1000},(_,i)=>makeEntry(i,'x'.repeat(40),{ignoreBudget:true}));
 const setup=makeSetup(es,{preset:{order:[],prompts:Array.from({length:100},(_,i)=>({identifier:String(i),content:'x'.repeat(40),name:'private'}))},extensionSources:Array.from({length:100},(_,i)=>({id:'x'+i,content:'y'.repeat(40)}))});
 const r=analyzeSetup(setup,{limits:{...limits,maxDigestBytes:4096}});
 assert.ok(new TextEncoder().encode(JSON.stringify(r.agentDigest)).length<=4096);assert.equal(r.counts.entries,1000);assert.equal(r.preset.prompts.length,100);
});

test('source history with missing constant-setting evidence does not prove static activation',()=>{
 const e=baseEntries()[0],a=record('a',[e]),b=record('b',[e]);delete a.sources[0].entry;delete b.sources[0].entry;
 const r=analyzeSetup(makeSetup([e]),{records:[a,b],limits});assert.equal(r.inventory.entries[0].observedStable,true);assert.equal(r.inventory.entries[0].stable,false);
});

test('reported oversized final input is a distinct error from a large book inventory',()=>{
 const e=baseEntries()[0],r=analyzeSetup(makeSetup([e]),{records:[record('a',[e],{usage:{prompt_tokens:1500000,prompt_tokens_details:{cached_tokens:0},completion_tokens:1}})],limits});
 assert.ok(r.settingsFindings.some(f=>f.code==='REPORTED_INPUT_OVER_USER_LIMIT'));assert.ok(r.worldQuantities.wholeBook.value<1000);
 assert.equal(r.worldQuantities.finalInput[0].value,1500000);
});

test('unknown ST version does not assign documented position meaning by guess',()=>{
 const r=analyzeSetup(makeSetup(undefined,{compatibility:{version:'fork',verifiedSource:false}}),{limits});
 assert.ok(r.settingsFindings.some(f=>f.code==='DYNAMIC_POSITION_ZERO'));assert.ok(!r.settingsFindings.some(f=>f.code==='DYNAMIC_BEFORE_CHARACTER'));
});
