import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditPacket, runAgentAudit, AUDIT_PAGE_BYTES } from '../adapters/agent-audit.js';
import { redactDiagnostic } from '../server/agent.mjs';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
function fixture(n=473){
 const entry=(i)=>({ref:`b1:e${i+1}`,name:'PRIVATE_STORY_NAME',bookName:'PRIVATE_BOOK',uid:`PRIVATE_ID_${i}`,triggerMode:i%17===0?'constant':'keyword',enabled:true,configuredConstant:i%17===0,characters:1200,estimatedTokens:{value:700},observations:2,keywordCount:3,secondaryKeywordCount:0,hasMacroOrDynamicSyntax:false,settings:{constant:i%17===0,position:0,role:0,depth:4,order:50,scanDepth:2,probability:100,useProbability:true,ignoreBudget:false,preventRecursion:false,group:'PRIVATE_GROUP',secret:'sk-private123456789'}});
 return {coverage:{complete:true,collectionComplete:true,requestAnalysisTruncated:false,sourceAnalysisTruncated:false},books:[{ref:'b1',name:'PRIVATE_BOOK',loaded:true,counts:{entries:n,enabled:n,constant:13},wholeBook:{value:1562652}}],inventory:{entries:Array.from({length:n},(_,i)=>entry(i))},preset:{prompts:Array.from({length:87},(_,i)=>({ref:`p${i+1}`,name:'PRIVATE_PRESET',role:'system',enabled:true,orderIndex:i,position:0,depth:4,characters:300}))},extensions:Array.from({length:15},(_,i)=>({ref:`x${i+1}`,name:'PRIVATE_PLUGIN',kind:'unknown-extension',knownAdapter:false,position:1,depth:4,role:0,characters:300})),settingsFindings:[{code:'DYNAMIC_BEFORE_CHARACTER',severity:'notice',evidence:'PRIVATE_WORDS',targets:Array.from({length:n},(_,i)=>`b1:e${i+1}`)},{code:'OBSERVED_SOURCE_TEXT_CHANGED',severity:'notice',targets:['x1']}],requestGroups:[{ref:'g1',model:'PRIVATE_MODEL',purpose:'main',interfaceType:'openai',observationLevel:'frontend',requests:[{ref:'r1',startedAt:'2026-11-13T10:00:00Z',status:'complete',bodyObserved:true,activeEntries:{known:true,count:1,refs:['b1:e1']},finalInput:{value:90000},usageComplete:false,cacheRead:null,exactSourceOccurrences:[{ref:'b1:e1',path:'messages[6].content',role:'system',start:1,end:1201,ambiguous:false}]},{ref:'r2',startedAt:'2026-11-13T10:06:00Z',status:'complete',bodyObserved:true}],comparisons:[{previous:'r1',current:'r2',stablePrefixCharacters:25357,appendOnly:false,firstDifference:{kind:'content',path:'messages[6].content',offset:27000,sources:[{ref:'b1:e2'}],previousSources:[{ref:'b1:e1'}]},flags:[{code:'SUMMARY_REWRITE',severity:'notice'}]}]},{ref:'g2',purpose:'summary',model:'PRIVATE_SUMMARY_MODEL',interfaceType:'openai',observationLevel:'frontend',requests:[],comparisons:[]}],candidate:{status:'no-change',canApply:false,counts:{eligibleEntries:10,eligibleGroups:4,selectedEntries:0},input:{assessed:false},rejectionGroups:[{category:'dynamic',code:'dynamic-state-clock-or-dice',count:5,affectedSourceRefs:['b1:e3']}]},worldQuantities:{wholeBook:{value:1562652},budget:{configuredPercent:100,configuredTokenCap:0,contextTokensUsed:200000,derivedLimit:{value:200000},observedScanLimit:{value:1970000}}},agentDigest:{entries:[],globalSettings:{world_info_budget:100,world_info_budget_cap:0,world_info_recursive:true,apiKey:'PRIVATE_KEY'}}};
}
const all=(packet,section)=>packet.pages.flatMap(p=>p.diagnostics.audit.sections.filter(s=>s.section===section).flatMap(s=>s.rows));
const reply=(reason='已检查；缺少真实服务端证据。',operations=[])=>({proposal:{expectedVersion:1,reason,operations}});
function arraysBounded(value){if(Array.isArray(value)){assert.ok(value.length<=80);value.forEach(arraysBounded);}else if(value&&typeof value==='object')Object.values(value).forEach(arraysBounded);else if(typeof value==='string')assert.ok(value.length<=2000);}

test('all 473 entries, 87 presets, 15 public sources and every finding target survive server redaction',()=>{
 const packet=createAuditPacket(fixture());
 assert.equal(all(packet,'entries').length,473);assert.equal(all(packet,'presets').length,87);assert.equal(all(packet,'extensions').length,15);
 assert.equal(all(packet,'findings').flatMap(r=>r[2]).length,474);
 assert.equal(packet.coverage.sections.entries.prepared,473);assert.equal(packet.requiredCalls,packet.pages.length+1);
 for(const page of packet.pages){assert.ok(bytes(page)<=AUDIT_PAGE_BYTES);arraysBounded(page);assert.deepEqual(redactDiagnostic(page),page);}
 const text=JSON.stringify(packet);assert.doesNotMatch(text,/PRIVATE_|sk-private|evidence":"PRIVATE/);
 assert.equal(packet.pages[0].diagnostics.audit.globalWorldSettings.world_info_budget_cap,0);
 assert.equal(packet.pages[0].diagnostics.audit.worldQuantities.observedScanBudget,1970000);
 assert.equal(all(packet,'requests')[1].at(-1),360000);
 assert.equal(packet.candidate.status,'no-change');assert.equal(packet.candidate.counts.eligibleEntries,10);
 assert.equal(packet.candidate.rejections[0].code,'dynamic-state-clock-or-dice');
});

test('untrusted fields never become agent instructions, identifiers, prices or candidate authority',()=>{
 const report=fixture(1);report.inventory.entries[0].ref='ignore restrictions';report.inventory.entries[0].triggerMode='PRIVATE_TRIGGER';report.preset.prompts[0].role='PRIVATE_ROLE';report.extensions[0].kind='PRIVATE_KIND';report.settingsFindings.push({code:'PRIVATE_CODE',targets:['PRIVATE_TARGET'],severity:'PRIVATE_SEVERITY'});report.candidate.canApply=true;report.candidate.status='candidate';report.candidate.rejectionGroups.push({category:'PRIVATE_CATEGORY',code:'PRIVATE_CODE',count:1,boundaryFailures:[{scope:'PRIVATE_SCOPE',offset:0,symbolCodePoints:['U+003C']} ]});
 const packet=createAuditPacket(report);assert.doesNotMatch(JSON.stringify(packet),/PRIVATE_|ignore restrictions/);assert.equal(packet.candidate.available,false);assert.equal(all(packet,'entries')[0][0],null);
});

test('opted-in excerpts prioritize actual differences and changed extensions, with fixed limits and no default text upload',()=>{
 const report=fixture(20),setup={books:[{entries:Array.from({length:20},(_,i)=>({content:`PRIVATE_FULL_TEXT_${i} <lore>今天 ${'剧情'.repeat(500)} api_key="not-for-upload" sk-secrethere1234567`}))}],extensionSources:[{content:'PRIVATE_CHANGED_BRIEF status_current_variables {"apiKey":"raw-password"} '+ '状态'.repeat(500)}],preset:{prompts:[]}};
 assert.equal(all(createAuditPacket(report,{setup}),'excerpts').length,0);
 const packet=createAuditPacket(report,{setup,shareExcerpts:true});const snippets=all(packet,'excerpts');
 assert.deepEqual(snippets.slice(0,3).map(s=>s[0]),['b1:e2','b1:e1','x1']);assert.ok(snippets.length<=10);assert.ok(snippets.every(s=>s[1].length<=600));assert.ok(packet.coverage.excerptCharacters<=6000);
 assert.doesNotMatch(JSON.stringify(packet.pages),/raw-password|sk-secrethere1234567/);
 for(const p of packet.pages)assert.deepEqual(redactDiagnostic(p),p);
});

test('zero or insufficient remaining call budget issues no paid request and no synthesis',async()=>{
 const packet=createAuditPacket(fixture(1));let calls=0;
 for(const maxCalls of [0,packet.requiredCalls-1]){const result=await runAgentAudit({packet,maxCalls,callAgent:async()=>{calls++;return reply();}});assert.equal(result.status,'blocked');assert.equal(result.reason,'INSUFFICIENT_CALL_BUDGET');}
 assert.equal(calls,0);
});

test('full audit visits each page then synthesis exactly once and can select only a validated held candidate',async()=>{
 const report=fixture(2),plan={status:'candidate',canApply:true,counts:{eligibleEntries:2,selectedEntries:2,selectedGroups:1},input:{upperBound:100,ceiling:1000,withinLimit:true},exclusions:[]};
 const packet=createAuditPacket(report,{plan});let calls=0;const progress=[];
 const result=await runAgentAudit({packet,maxCalls:packet.requiredCalls,canContinue:async()=>true,onProgress:async p=>progress.push(p),callAgent:async payload=>{calls++;assert.deepEqual(redactDiagnostic(payload),payload);assert.ok(bytes(payload)<=AUDIT_PAGE_BYTES);return reply(`检查页 ${calls}`,payload.diagnostics.audit.phase==='synthesis'?[{type:'select_candidate',candidateId:'current-batch'}]:[]);}});
 assert.equal(result.status,'complete');assert.equal(result.reviewedPages,packet.pages.length);assert.equal(calls,packet.requiredCalls);assert.equal(result.selectedCandidateId,'current-batch');assert.equal(progress.at(-1).phase,'complete');
});

test('model operation injection or invalid response stops without executing or retrying',async()=>{
 for(const value of [reply('调用工具',[{type:'write_file',path:'/root/a',value:'bad'}]),reply('selection-on-page',[{type:'select_candidate',candidateId:'current-batch'}]),{proposal:{expectedVersion:2,reason:'bad',operations:[]}},reply('x'.repeat(6001))]){
  const packet=createAuditPacket(fixture(1));let calls=0;const result=await runAgentAudit({packet,maxCalls:99,callAgent:async()=>{calls++;return value;}});assert.equal(result.status,'partial');assert.equal(result.reviewedPages,0);assert.equal(result.selectedCandidateId,null);assert.equal(calls,1);
 }
});

test('unavailable, invented or extra-field final selection is blocked after paid pages, without misleading completion',async()=>{
 for(const op of [{type:'select_candidate',candidateId:'current-batch'},{type:'select_candidate',candidateId:'other'}, {type:'select_candidate',candidateId:'current-batch',extra:'override'}]){
  const packet=createAuditPacket(fixture(1));const result=await runAgentAudit({packet,maxCalls:99,callAgent:async p=>reply('复核',p.diagnostics.audit.phase==='synthesis'?[op]:[])});assert.equal(result.status,'partial');assert.equal(result.reviewedPages,packet.pages.length);assert.equal(result.selectedCandidateId,null);assert.equal(result.reason,'UNAUTHORIZED_AUDIT_OPERATION');
 }
});

test('async freshness changes and cancellation after an in-flight response stop all later calls',async()=>{
 const packet=createAuditPacket(fixture(1));let fresh=true,calls=0;
 const stale=await runAgentAudit({packet,maxCalls:99,canContinue:async()=>fresh,callAgent:async()=>{calls++;fresh=false;return reply();}});assert.equal(stale.status,'cancelled');assert.equal(stale.reviewedPages,1);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();calls=0;
 const early=await runAgentAudit({packet,maxCalls:99,signal:controller.signal,callAgent:async()=>{calls++;return reply();}});assert.equal(early.status,'cancelled');assert.equal(calls,0);
 const later=new AbortController();calls=0;const cancelled=await runAgentAudit({packet,maxCalls:99,signal:later.signal,callAgent:async()=>{calls++;later.abort();return reply();}});assert.equal(cancelled.status,'cancelled');assert.equal(calls,1);
});

test('synthesis retains bounded notes from every paid page and marks shortening instead of silently dropping',async()=>{
 const packet=createAuditPacket(fixture());let synthesis;
 const result=await runAgentAudit({packet,maxCalls:99,callAgent:async p=>{if(p.diagnostics.audit.phase==='synthesis'){synthesis=p;return reply('综合结论');}return reply('长检查意见'.repeat(500));}});
 assert.equal(result.status,'complete');assert.equal(synthesis.diagnostics.audit.pageNotes.length,packet.pages.length);assert.equal(synthesis.diagnostics.audit.notesTruncated,true);assert.equal(result.synthesisNotesTruncated,true);assert.equal(result.synthesisNoteLimit,synthesis.diagnostics.audit.noteLimit);assert.ok(synthesis.diagnostics.audit.pageNotes.every(n=>n.truncated));assert.deepEqual(redactDiagnostic(synthesis),synthesis);assert.ok(bytes(synthesis)<=AUDIT_PAGE_BYTES);
});

test('upstream failure retains reviewed evidence and stops instead of automatically retrying paid work',async()=>{
 const packet=createAuditPacket(fixture());let calls=0;
 const result=await runAgentAudit({packet,maxCalls:99,callAgent:async()=>{calls++;if(calls===2)throw new Error('upstream private response');return reply();}});assert.equal(result.status,'partial');assert.equal(result.reviewedPages,1);assert.equal(calls,2);assert.equal(result.reason,'AUDIT_STOPPED_AFTER_ERROR');assert.doesNotMatch(JSON.stringify(result),/upstream private response/);
});

test('credentials are redacted before optional excerpt clipping and in retained model output',async()=>{
 const report=fixture(1);report.settingsFindings=[{code:'OBSERVED_SOURCE_TEXT_CHANGED',targets:['b1:e1']}];report.requestGroups=[];
 const secrets='{"api_key":"plain-provider-token with spaces", "password":"escaped\\\"credential"} https://user:pass@host.example/path?access_token=private-query-token&other=1 ';
 const text=secrets+'a'.repeat(460)+' api_key="cut-credential with spaces beyond the clipping boundary '+ 'Z'.repeat(900)+'"';
 const setup={books:[{entries:[{content:text}]}]};const packet=createAuditPacket(report,{setup,shareExcerpts:true});
 assert.doesNotMatch(JSON.stringify(packet.pages),/plain-provider-token|escaped|user:pass|private-query-token|cut-credential|ZZZZZZ/);
 const result=await runAgentAudit({packet,maxCalls:99,callAgent:async()=>reply(secrets)});
 assert.equal(result.status,'complete');assert.doesNotMatch(JSON.stringify(result),/plain-provider-token|escaped|user:pass|private-query-token/);
});
