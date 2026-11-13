import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchPlan } from '../adapters/batch-plan.js';
import { createOptimizationState, applyProposal, previewProposal } from '../core/optimizer.js';
import { transformWithProfile } from '../adapters/pipeline.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { collectContextSources } from '../adapters/st.js';

const limits={maxInputTokens:50000,contextTokens:64000,outputReserveTokens:4096};
const setup={complete:true,optimizationBlocked:false,batchAuthorized:true};
function source(id,text,{constant=false,vectorized=false,key=['Alice'],...extra}={}) {
 return {id:'world:local-private-book:'+id,kind:'world-info',provenance:'WORLD_INFO_ACTIVATED',name:'私有人物 '+id,text,content:text,entry:{uid:id,world:'local-private-book',content:text,constant,vectorized,key,position:0,depth:4,role:0,order:100,...extra}};
}
const dynamic=source('d','<lore>本轮召回的角色事实。</lore>');
const stable=source('s','<lore>稳定且必要的世界基础设定。</lore>',{constant:true});
function record(sources=[dynamic,stable],content=sources.map(s=>s.text).join('\n\u00a0')) {
 return {id:'request-1',chatId:'chat-1',characterId:'character-1',model:'test-model',provider:'claude',interfaceType:'anthropic',purpose:'main',observationLevel:'frontend',status:'complete',sources:structuredClone(sources),body:{model:'test-model',chat_completion_source:'claude',messages:[{role:'system',content:'<world_info>\n'+content+'\n</world_info>'},{role:'user',content:'继续剧情'}]}};
}
function plan(r=record(),options={}) {return buildBatchPlan({record:r,setup,limits,...options});}

test('one batch grant produces optimizer-compatible byte-preserving current-request plan',()=>{
 const r=record(),before=structuredClone(r),p=plan(r);
 assert.equal(p.status,'candidate',p.reasons.join());assert.equal(p.canApply,true);assert.equal(p.counts.selectedEntries,2);
 assert.deepEqual(p.profile.blocks.map(b=>b.id),['b0','b1']);assert.deepEqual(p.proposal.operations[0].ids,['b1','b0']);
 assert.deepEqual(p.proposal.sources,['b0','b1']);assert.deepEqual(r,before);
 const checked=previewProposal(p.profile,p.proposal,p.previewContext);assert.equal(checked.ok,true);
 const applied=applyProposal(createOptimizationState(p.profile),p.proposal,{...p.previewContext,expectedPreview:checked});
 const result=transformWithProfile(r.body,applied.profile,{binding:p.profile.binding});
 assert.deepEqual(result,p.previewBody);assert.equal(result.messages[0].content,'<world_info>\n'+stable.text+'\n\u00a0'+dynamic.text+'\n</world_info>');
 assert.equal(p.input.exact,false);assert.equal(p.input.requestBytesBefore,p.input.requestBytesAfter);assert.equal(r.sources[0].entry.order,100);
});

test('no per-entry approval required but absent batch authorization remains preview-only',()=>{
 const p=plan(record(),{setup:{complete:true}});assert.equal(p.status,'needs-batch-approval');assert.equal(p.canApply,false);assert.equal(p.requiresBatchApproval,true);assert.ok(p.previewBody);assert.equal(p.profile.blocks[0].approvedIndependent,false);
});

test('stable and dynamic classes retain original internal order including vector recall',()=>{
 const d2=source('d2','<lore>向量召回的另一条事实。</lore>',{vectorized:true,key:[]});
 const s2=source('s2','<lore>第二条稳定基础事实。</lore>',{constant:true});
 const p=plan(record([dynamic,stable,d2,s2]));assert.equal(p.canApply,true);assert.deepEqual(p.proposal.operations[0].ids,['b1','b3','b0','b2']);
 assert.equal(p.counts.dynamicEntries,2);assert.equal(p.counts.stableEntries,2);
});

test('presets, memory and unknown extension sources cannot enter automatic range',()=>{
 const preset={id:'preset:x',kind:'preset',text:'<rules>固定预设内容。</rules>'};
 const summary={id:'extension:summary',kind:'history-summary',text:'<summary>已经发生的剧情。</summary>'};
 const r=record([dynamic,stable,preset,summary],dynamic.text+'\n'+stable.text+'\n'+preset.text+'\n'+summary.text);
 const p=plan(r);assert.equal(p.counts.selectedEntries,2);assert.ok(p.profile.blocks.every(b=>b.source.kind==='worldbook'));
 assert.ok(p.previewBody.messages[0].content.endsWith(preset.text+'\n'+summary.text+'\n</world_info>'));
 assert.equal(p.exclusions.filter(e=>e.reason==='not-explicit-world-info').length,2);
});

test('macro, dependent tag, neighbour reference and incomplete provenance fail closed',()=>{
 for(const bad of [
  source('macro','<lore>{{getvar::current_state}}</lore>',{constant:true}),
  source('open','<lore>跨条目未闭合事实。',{constant:true}),
  source('dependency','<lore>必须以上述规则为前提才揭露秘密。</lore>',{constant:true}),
  {...stable,provenance:'unknown-third-party'},
 ]) {const p=plan(record([dynamic,bad]));assert.equal(p.canApply,false);assert.equal(p.counts.selectedEntries,0);}
});

test('different outer tag scopes or native injection metadata never merged',()=>{
 const wrapped=record([dynamic,stable],'<first>'+dynamic.text+'</first>\n<second>'+stable.text+'</second>');
 assert.equal(plan(wrapped).canApply,false);
 const different=structuredClone(stable);different.entry.depth=0;
 assert.equal(plan(record([dynamic,different])).canApply,false);
 const malformed=record([dynamic,stable],'<incomplete>'+dynamic.text+'\n'+stable.text);
 assert.equal(plan(malformed).canApply,false);
});

test('ambiguous repeated text, overlapping source and duplicated identity are not guessed',()=>{
 assert.equal(plan(record([dynamic,stable],dynamic.text+'\n'+stable.text+'\n'+stable.text)).canApply,false);
 const identical=source('other',stable.text,{constant:true});assert.equal(plan(record([dynamic,stable,identical],dynamic.text+'\n'+stable.text)).canApply,false);
 assert.equal(plan(record([dynamic,stable,stable],dynamic.text+'\n'+stable.text)).canApply,false);
});

test('disjoint ranges do not cross unselected content; only one changed run per scope',()=>{
 const d2=source('d2','<lore>另一个召回人物。</lore>');const s2=source('s2','<lore>另一条稳定世界事实。</lore>',{constant:true});
 const r=record([dynamic,stable,d2,s2],dynamic.text+'\n'+stable.text+'\n保持这段未知作用域指令\n'+d2.text+'\n'+s2.text);
 const p=plan(r);assert.equal(p.canApply,true);assert.equal(p.counts.selectedGroups,1);assert.equal(p.counts.selectedEntries,2);
 assert.ok(p.previewBody.messages[0].content.includes('保持这段未知作用域指令\n'+d2.text+'\n'+s2.text));
});

test('all keyword entries or already stable-first ranges do not produce meaningless edits',()=>{
 const d2=source('d2','<lore>另一条关键词召回。</lore>');assert.equal(plan(record([dynamic,d2])).status,'no-change');
 assert.equal(plan(record([stable,dynamic])).status,'no-change');
});

test('fresh invocation follows current content and membership, never freezes prior lore',()=>{
 const old=plan(record());const changed=source('d','<lore>人物当前已经离开城堡。</lore>');const next=plan(record([changed,stable]));
 assert.equal(next.canApply,true);assert.ok(next.previewBody.messages[0].content.includes(changed.text));assert.ok(!next.previewBody.messages[0].content.includes(dynamic.text));
 assert.equal(plan(record([stable])).canApply,false);assert.deepEqual(old.profile.blocks[0].content,dynamic.text);
});

test('different messages and roles cannot be combined into a range',()=>{
 const r=record();r.body.messages=[{role:'system',content:dynamic.text},{role:'user',content:stable.text}];assert.equal(plan(r).canApply,false);
});

test('full 1.5 million input rejects; estimates do not become exact or bypass ceiling',()=>{
 const r=record();r.body.messages.push({role:'user',content:'x'.repeat(1500000)});
 const p=plan(r,{inputEvidence:{value:10000,method:'ST tokenizer estimate',exact:true}});
 assert.equal(p.status,'blocked');assert.equal(p.canApply,false);assert.equal(p.input.estimate.exact,false);assert.ok(p.input.upperBound>1500000);assert.equal(p.previewContext.exactInputTokens,undefined);
 const small=plan(record());assert.ok(small.input.upperBound<small.input.requestBytesBefore+5000,'selected text is not double-counted');
});

test('runtime setup blockers and exact chat/character bindings prevent accidental cross-scope apply',()=>{
 assert.equal(plan(record(),{setup:{...setup,optimizationBlocked:true}}).canApply,false);
 assert.equal(plan(record(),{setup:{...setup,complete:false}}).canApply,false);
 assert.equal(plan(record(),{setup:{...setup,binding:{characterId:'other-character'}}}).canApply,false);
 const p=plan();assert.equal(p.profile.binding.characterId,'character-1');
});

test('unknown interfaces, multimodal body and imported evidence stay diagnostic-only',()=>{
 const r=record();r.interfaceType='unknown';assert.equal(plan(r).canApply,false);
 const image=record();image.body.messages.push({role:'user',content:[{type:'image_url',image_url:{url:'x'}}]});assert.equal(plan(image).canApply,false);
 const imported=record();imported.observationLevel='imported';assert.equal(plan(imported).canApply,false);
});

test('unresolved outer template spanning eligible entries is never rearranged',()=>{
 const r=record([dynamic,stable],'{{concat::'+dynamic.text+'\n'+stable.text+'}}');
 const p=plan(r);assert.equal(p.canApply,false);assert.ok(p.exclusions.some(e=>e.reason==='message-has-unresolved-template-boundary'));
});

test('Unicode Chinese outer tags including 、 preserve shared sibling scopes',()=>{
 const r=record([dynamic,stable],'<秘党><龙文、黄金瞳与血统共鸣>'+dynamic.text+'\n'+stable.text+'</龙文、黄金瞳与血统共鸣></秘党>');
 const p=plan(r);assert.equal(p.canApply,true,p.reasons.join());assert.ok(p.previewBody.messages[0].content.includes('<龙文、黄金瞳与血统共鸣>'+stable.text+'\n'+dynamic.text+'</龙文、黄金瞳与血统共鸣>'));
 const zhDynamic=source('zd','<角色事实>本轮召回的人物资料。</角色事实>');const zhStable=source('zs','<世界设定>稳定的世界基础资料。</世界设定>',{constant:true});
 assert.equal(plan(record([zhDynamic,zhStable])).canApply,true);
});

test('separate, split, mismatched or incomplete Chinese tag scopes are never ignored',()=>{
 assert.equal(plan(record([dynamic,stable],'<前段>'+dynamic.text+'</前段><后段>'+stable.text+'</后段>')).canApply,false);
 for(const bad of [
  source('split','<秘党>跨条目开始的内容。',{constant:true}),
  source('badclose','<秘党>角色事实。</另一个标签>',{constant:true}),
  source('partial','<秘党 不完整的开标签',{constant:true}),
  source('unsupported','<🔒>未知标签作用域。</🔒>',{constant:true}),
 ])assert.equal(plan(record([dynamic,bad])).canApply,false);
 assert.equal(plan(record([dynamic,stable],'<前段>'+dynamic.text+'\n'+stable.text+'</后段>')).canApply,false);
});

test('constant activation never certifies dynamic state, relative clocks or dice as stable',()=>{
 for(const text of [
  '<简报>记忆系统私密简报：人物已离开。</简报>',
  '<变量>status_current_variables: hp=42</变量>',
  '<历史>5天前发生事件，大前天又发生变化。</历史>',
  '<状态>上周二见面，上周五分别。</状态>',
  '<骰池>本轮骰池：3、6、2。</骰池>',
  '<state>Current time: 08:01. Yesterday the gates closed.</state>',
 ]) {const p=plan(record([dynamic,source('dynamic-constant',text,{constant:true})]));assert.equal(p.canApply,false);assert.ok(p.exclusions.some(e=>e.reason==='dynamic-state-clock-or-dice'));}
});

test('synthetic, replay, imported and predicted evidence cannot masquerade as live frontend',()=>{
 for(const extra of [{synthetic:true},{replay:true},{imported:true},{predicted:true},{evidence:'offline-preview'}])assert.equal(plan({...record(),...extra}).canApply,false);
 assert.equal(plan(record(),{setup:{batchAuthorized:true}}).canApply,false);
 const r=record();r.groupId=null;const p=plan(r,{setup:{...setup,binding:{chatId:r.chatId,characterId:r.characterId,groupId:null}}});assert.equal(p.canApply,true);assert.equal(p.profile.binding.groupId,null);
});


test('third-party registry cannot forge official activation provenance to enter batch scope',()=>{
 const registry=new AdapterRegistry();
 registry.register({id:'world',version:'attacker-test',readSources:()=>[{...stable,id:'local-private-book:s',access:'write',adapter:null,provenance:'WORLD_INFO_ACTIVATED'}]});
 const sources=collectContextSources({},[dynamic.entry],registry);
 const forged=sources.find(s=>s.adapter);assert.equal(forged.id,'world:local-private-book:s');assert.equal(forged.provenance,'WORLD_INFO_ACTIVATED');assert.equal(forged.access,'read-only');
 const p=plan(record(sources,dynamic.text+'\n'+stable.text));
 assert.equal(p.canApply,false);assert.equal(p.counts.selectedEntries,0);assert.ok(p.exclusions.some(e=>e.reason==='third-party-adapter-diagnostic-only'));
});

test('official readonly collection remains eligible while spoofed native identity is excluded',()=>{
 const sources=collectContextSources({},[dynamic.entry,stable.entry],new AdapterRegistry());
 assert.ok(sources.every(s=>s.access==='read-only'&&!Object.hasOwn(s,'adapter')));
 assert.equal(plan(record(sources,dynamic.text+'\n'+stable.text)).canApply,true);
 const forged=structuredClone(stable);forged.id='extension:anything';
 const p=plan(record([dynamic,forged]));assert.equal(p.canApply,false);assert.ok(p.exclusions.some(e=>e.reason==='native-source-identity-mismatch'));
 for(const extra of [{adapter:null},{adapter:''},{adapterVersion:'pretend-native'}])assert.equal(plan(record([dynamic,{...stable,...extra}])).canApply,false);
});

test('explicit snapshot without current activation prevents string-only provenance claims',()=>{
 const r=record();r.snapshot={activationEventSeen:false,activeEntries:[]};assert.equal(plan(r).canApply,false);
 const r2=record();r2.world={activationEventSeen:false};assert.equal(plan(r2).canApply,false);
 const r3=record();r3.world={activationEventSeen:true,activeEntries:[dynamic.entry,stable.entry]};assert.equal(plan(r3).canApply,true);
});

test('literal paired pseudo-tag names support bounded ASCII/fullwidth punctuation without normalization',()=>{
 for(const name of ['世界（基础）','世界(基础)','世界[基础]','世界［基础］','世界【基础】','世界：基础','世界(基础)[补充]：阶段（二）']) {
  const r=record([dynamic,stable],`<${name}>`+dynamic.text+'\n'+stable.text+`</${name}>`);
  const p=plan(r);assert.equal(p.canApply,true,`${name}: ${p.reasons.join()}`);
  assert.ok(p.previewBody.messages[0].content.includes(`<${name}>`+stable.text+'\n'+dynamic.text+`</${name}>`));
 }
 const mismatch=record([dynamic,stable],'<世界（基础）>'+dynamic.text+'\n'+stable.text+'</世界(基础)>');assert.equal(plan(mismatch).canApply,false);
});

test('expanded literal names retain separate opening-offset scopes and reject split tags or macros',()=>{
 const split=record([dynamic,stable],'<世界（基础）>'+dynamic.text+'</世界（基础）><世界（基础）>'+stable.text+'</世界（基础）>');assert.equal(plan(split).canApply,false);
 const broken=source('broken','<角色（阶段二）>没有独立闭合。',{constant:true});assert.equal(plan(record([dynamic,broken])).canApply,false);
 const macro=record([dynamic,stable],'<世界{{stage}}>'+dynamic.text+'\n'+stable.text+'</世界{{stage}}>');assert.equal(plan(macro).canApply,false);
 const unsupported=record([dynamic,stable],'<世界@基础>'+dynamic.text+'\n'+stable.text+'</世界@基础>');assert.equal(plan(unsupported).canApply,false);
});

test('attribute-bearing self-closing tags stay self-closing and quoted greater-than support remains unchanged',()=>{
 for(const token of ['<tag x="1"/>','<tag x="1" />','<tag/>','<tag />']) {
  const r=record([dynamic,stable],'<世界（基础）>'+token+dynamic.text+'\n'+stable.text+'</世界（基础）>');assert.equal(plan(r).canApply,true,token);
 }
 const quoted=record([dynamic,stable],'<tag test="a > b">'+dynamic.text+'\n'+stable.text+'</tag>');assert.equal(plan(quoted).canApply,false);
});

test('unsupported tag diagnostics include only numeric scope offset and symbol code points',()=>{
 const r=record([dynamic,stable],'<敏感名字$内部>'+dynamic.text+'\n'+stable.text+'</敏感名字$内部>');
 const p=plan(r);assert.equal(p.canApply,false);const failure=p.exclusions.find(e=>e.reason==='unsafe-outer-markup:unsupported-tag-syntax')?.boundaryFailure;
 assert.ok(failure);assert.equal(failure.scope,'messages.0.content');assert.equal(Number.isSafeInteger(failure.offset),true);assert.deepEqual(failure.symbolCodePoints,['U+0024']);
 const printed=JSON.stringify(failure);assert.ok(!printed.includes('敏感'));assert.ok(!printed.includes('内部'));assert.deepEqual(Object.keys(failure).sort(),['offset','scope','symbolCodePoints']);
 const later=record([dynamic,stable],dynamic.text+'\n'+stable.text+'<后文$未知>保持原样</后文$未知>');assert.equal(plan(later).canApply,false,'unchanged unsupported suffix is still conservatively checked');
});
