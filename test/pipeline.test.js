import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleSources, transformWithProfile, localCandidate, profileContext } from '../adapters/pipeline.js';
import { createProfile, createOptimizationState, applyProposal, previewProposal } from '../core/optimizer.js';
const a = '<lore>dynamic lore</lore>', b = '<rule>stable foundation</rule>';
const body = { messages: [{ role: 'system', content: a + '\n\u00a0' + b }], model: 'x' };
const blocks = eligibleSources(body, [{id:'a',type:'worldbook',text:a},{id:'b',type:'preset',text:b}]).map(v=>({...v,approvedIndependent:true,stable:v.id==='b'}));
test('live exact fragment reorder preserves separators, roles, text and untouched metadata',()=>{
  const profile=createProfile({mode:'preview',blocks,limits:{maxInputTokens:10000,contextTokens:12000,outputReserveTokens:1000}});
  const p=localCandidate(profile), context={byteLevelTokenizer:true,otherInputUpperBound:100};
  const next=applyProposal(createOptimizationState(profile),p,{...context,expectedPreview:previewProposal(profile,p,context)});
  const result=transformWithProfile(body,next.profile);
  assert.equal(result.messages[0].content,b+'\n\u00a0'+a); assert.equal(result.model,'x'); assert.equal(result.messages[0].role,'system');
  assert.equal(body.messages[0].content,a+'\n\u00a0'+b);
  const changed=structuredClone(body);changed.messages[0].content=changed.messages[0].content.replace('dynamic','new dynamic');
  assert.deepEqual(transformWithProfile(changed,next.profile),changed);
});
test('never moves fragments across unselected content or ambiguous duplicate occurrence',()=>{
  const profile=createProfile({mode:'automatic',blocks:[...blocks].reverse()});
  for(const content of [a+'\nimportant scope\n'+b,a+'\n'+a+'\n'+b]) {
    const input={messages:[{role:'system',content}]};assert.deepEqual(transformWithProfile(input,profile),input);
  }
});
test('Agent context omits full block content',()=>{ assert.equal(JSON.stringify(profileContext(createProfile({blocks}))).includes('stable foundation'),false); });

test('live request bounds are checked again after preview; current dynamic input never frozen',()=>{
  const profile=createProfile({mode:'automatic',blocks:[...blocks].reverse(),limits:{maxInputTokens:10000,contextTokens:12000,outputReserveTokens:1000}});
  const expanded={messages:[{role:'system',content:a+'\n'+b},{role:'user',content:'x'.repeat(1500000)}]};
  const record={};assert.deepEqual(transformWithProfile(expanded,profile,{record}),expanded);
  assert.equal(record.structureTransformation.applied,false);
  assert.match(record.structureTransformation.reason,/bound/);
  const unknown=createProfile({mode:'automatic',blocks:[...blocks].reverse()});
  assert.deepEqual(transformWithProfile(body,unknown),body);
});
test('approved profile is bound to exact chat/model/provider/purpose and skips other traffic',()=>{
  const binding={chatId:'story-a',model:'fixture-model',provider:'claude',purpose:'main'};
  const profile=createProfile({mode:'preview',blocks:[...blocks].reverse(),binding,limits:{maxInputTokens:10000,contextTokens:12000,outputReserveTokens:1000}});
  assert.notDeepEqual(transformWithProfile(body,profile,{binding}),body);
  for(const key of Object.keys(binding))assert.deepEqual(transformWithProfile(body,profile,{binding:{...binding,[key]:'other'}}),body);
  assert.deepEqual(transformWithProfile(body,profile),body);
});
