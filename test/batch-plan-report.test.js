import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBatchPlan, formatPlanRejections } from '../adapters/batch-plan-report.js';
const secret='PRIVATE_STORY_API_KEY_DO_NOT_EXPORT';
const report={inventory:{entries:[{ref:'b1:e1',bookName:secret,uid:7,name:secret},{ref:'b1:e2',bookName:secret,uid:8}]},requestGroups:[
 {purpose:'main',requests:[{ref:'r1',bodyObserved:true,activeEntries:{known:true,count:26},exactSourceOccurrences:[{ref:'b1:e1',ambiguous:false},{ref:'b1:e1',ambiguous:false},{ref:'b1:e2',ambiguous:false}]}]},
 {purpose:'summary',requests:[{ref:'r2',bodyObserved:true,exactSourceOccurrences:[]}]},
]};
const plan={status:'blocked',canApply:false,counts:{totalSources:100,explicitWorldInfoSources:26,eligibleEntries:0,eligibleGroups:0,selectedEntries:0,selectedGroups:0,unknown:secret},
 reasons:[secret],body:secret,profile:{content:secret},proposal:{reason:secret},
 exclusions:[{sourceId:'world:'+secret+':7',reason:'message-with-code-fence-needs-manual-review',message:secret},{sourceId:'world:'+secret+':8',reason:'message-has-unresolved-template-boundary'},
 {sourceId:secret,reason:'unsafe-outer-markup:unclosed-outer-tag'},{sourceId:secret,reason:'unsafe-outer-markup:'+secret},{sourceId:secret,reason:'not-explicit-world-info'}]};

test('safe report groups actual rejection codes and maps native identity to opaque inventory refs',()=>{
 const result=summarizeBatchPlan(plan,report);assert.equal(result.status,'blocked');assert.equal(result.canApply,false);
 assert.deepEqual(result.rejectionGroups.find(g=>g.category==='code').affectedSourceRefs,['b1:e1']);
 assert.deepEqual(result.rejectionGroups.find(g=>g.category==='template').affectedSourceRefs,['b1:e2']);
 assert.equal(result.rejectionTotals.knownWorldCandidateRecords,3);assert.equal(result.rejectionTotals.nonWorldRecords,1);assert.equal(result.rejectionTotals.unknownCategoryRecords,1);
 assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(JSON.stringify(result).includes('content'),false);
});

test('unknown arbitrary codes, labels, private refs and free-form fields never leak',()=>{
 const malicious={...plan,status:secret,exclusions:[{sourceId:secret,reason:secret,message:secret}],input:{method:secret,upperBound:10,ceiling:20,estimate:{method:secret},exact:true}};
 const result=summarizeBatchPlan(malicious,{inventory:{entries:[{ref:secret,bookName:secret,uid:7}]}});
 assert.equal(result.status,'unknown');assert.equal(result.rejectionGroups[0].code,'unrecognized-protection-condition');assert.equal(result.input.exact,false);assert.equal(result.input.method,'unreported-or-unsupported');
 assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(formatPlanRejections(result).includes(secret),false);
});

test('exact request matches and zero qualifying candidates are distinct facts',()=>{
 const result=summarizeBatchPlan(plan,report);assert.equal(result.counts.selectedEntries,0);assert.equal(result.matchingEvidence.latestReportedMainRequest.exactMatchedWorldEntries,2);
 assert.equal(result.matchingEvidence.latestReportedMainRequest.requestRef,'r1');assert.equal(result.matchingEvidence.scope,'report-main-requests-not-bound-to-candidate');
 assert.equal(result.distinction.knownTextMatchesExistInReport,true);assert.equal(result.matchingEvidence.mainRequestsWithMatchMetadata,1);
 const text=formatPlanRejections(result);assert.match(text,/代码围栏/);assert.match(text,/模板边界/);assert.match(text,/已有 2 条世界书文本被精确定位/);assert.match(text,/不能解释/);
});

test('missing plan does not manufacture rejection counts or claim no matched lore',()=>{
 const result=summarizeBatchPlan(null,report);assert.equal(result.planPresent,false);assert.equal(result.counts.eligibleEntries,null);assert.equal(result.input.assessed,false);assert.equal(result.rejectionGroups.length,0);
 assert.match(formatPlanRejections(result),/没有本次优化计划的拒绝记录/);assert.equal(result.distinction.knownTextMatchesExistInReport,true);
});

test('numeric byte guard is labeled non-exact and contradictory input flags are not trusted',()=>{
 const result=summarizeBatchPlan({...plan,input:{upperBound:250000,ceiling:160000,withinLimit:true,method:'conservative-utf8-byte-bound',exact:true,requestBytesBefore:245904,requestBytesAfter:245904}});
 assert.equal(result.input.exact,false);assert.equal(result.input.withinLimit,false);assert.equal(result.input.upperBound,250000);assert.equal(result.input.assessed,true);
 assert.equal(result.input.method,'conservative-utf8-byte-bound');
});

test('malformed numeric values remain unknown and bounded input truncation is explicit',()=>{
 const many={...plan,counts:{totalSources:NaN,selectedEntries:-2,eligibleEntries:Infinity},exclusions:Array.from({length:2100},(_,i)=>({sourceId:'private-'+i,reason:'unbalanced-entry-tags'}))};
 const result=summarizeBatchPlan(many);assert.equal(result.counts.totalSources,null);assert.equal(result.counts.selectedEntries,null);assert.equal(result.coverage.exclusionsTruncated,true);
 assert.equal(result.rejectionTotals.records,2100);assert.equal(result.rejectionTotals.analyzedRecords,2000);assert.equal(result.rejectionTotals.distinctMappedOrOpaqueSources,2000);assert.equal(result.rejectionGroups[0].affectedSourceRefs.length,40);assert.equal(result.rejectionGroups[0].affectedRefsTruncated,true);
 assert.ok(formatPlanRejections(result).length<=1200);
});

test('unrecognized private inventory refs are replaced, and summaries with no positive evidence do not claim absence',()=>{
 const r={inventory:{entries:[{ref:secret,bookName:'book',uid:1}]},requestGroups:[{purpose:'main',requests:[{ref:secret,bodyObserved:true,exactSourceOccurrences:[{ref:secret,ambiguous:true}]}]}]};
 const result=summarizeBatchPlan({...plan,exclusions:[{sourceId:'world:book:1',reason:'unbalanced-entry-tags'}]},r);
 assert.deepEqual(result.rejectionGroups[0].affectedSourceRefs,['entry-1']);assert.equal(result.matchingEvidence.latestReportedMainRequest.requestRef,'request-1');assert.equal(result.matchingEvidence.maximumExactMatchedWorldEntries,0);
 assert.equal(result.matchingEvidence.conclusion,'no-positive-match-established-by-this-export');assert.equal(JSON.stringify(result).includes(secret),false);
});
