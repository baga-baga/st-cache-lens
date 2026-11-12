import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzePair,flattenContext,mapSources,projectContext,diagnoseWorldInfo,diagnoseDuplicates,estimateTokens,requestGroupKey} from '../core/diagnostics.js';
const msg=(content,role='system')=>({role,content});
const req=(messages,extra={})=>({purpose:'main',provider:'anthropic',model:'same-model',observationLevel:'frontend',body:{messages},...extra});

test('front dynamic world insertion locates earliest exact change and source',()=>{
    const old=req([msg('规则\n人物A\n历史开始')]);
    const now=req([msg('规则\n黑王真相与圣婴计划\n人物A\n历史开始')]);
    const r=analyzePair(old,now,{sources:[{id:'wi-9',type:'world-info',text:'黑王真相与圣婴计划',book:'dragon'}]});
    assert.equal(r.stablePrefixCharacters,3);assert.equal(r.firstDifference.currentPath,'messages[0].content');
    assert.equal(r.firstDifference.sources[0].id,'wi-9');assert.equal(r.firstDifference.sources[0].confidence,'exact-text-match');
    assert.equal(r.stablePrefix.serverHitConfirmed,false);assert.match(r.visibility,/仅观察到前端请求/);
});

test('appended conversation preserves complete old context',()=>{
    const old=req([msg('Rules'),msg('Hello','user')]);
    const now=req([...old.body.messages,msg('Welcome','assistant'),msg('Continue','user')]);
    const r=analyzePair(old,now);assert.equal(r.appendOnly,true);assert.equal(r.stablePrefixCharacters,10);assert.equal(r.firstDifference.kind,'append');
});

test('same characters in different message roles are not same context',()=>{
    const r=analyzePair(req([msg('hello','user')]),req([msg('hello','system')]));
    assert.equal(r.equal,false);assert.equal(r.firstDifference.kind,'structure');assert.equal(r.stablePrefixCharacters,0);
});

test('blank and invisible characters are retained and escaped',()=>{
    const r=analyzePair(req([msg('a\u200bb')]),req([msg('a b')]));
    assert.equal(r.stablePrefixCharacters,1);assert.equal(r.firstDifference.previousCharacter.codePoint,'U+200B');
    assert.match(r.firstDifference.previousExcerpt.escaped,/\\u200b/);assert.equal(r.firstDifference.currentCharacter.escaped,'\\u0020');
    assert.equal(analyzePair(req([msg('x\r\ny')]),req([msg('x\ny')])).firstDifference.previousCharacter.codePoint,'U+000D');
});

test('Unicode is not normalized (composed versus decomposed)',()=>{
    assert.equal(analyzePair(req([msg('é')]),req([msg('e\u0301')])).stablePrefixCharacters,0);
});

test('authentication headers, request ids, transport timestamps are not context',()=>{
    const a={messages:[msg('same')],headers:{authorization:'secret1'},request_id:'1',timestamp:1};
    const b={...a,headers:{authorization:'secret2'},request_id:'2',timestamp:2};
    assert.deepEqual(projectContext(a),{messages:[msg('same')]});assert.equal(analyzePair(a,b).equal,true);
});

test('model and purpose group separation prevents Claude/DeepSeek cross attribution',()=>{
    assert.notEqual(requestGroupKey(req([])),requestGroupKey(req([],{purpose:'summary'})));
    const r=analyzePair(req([msg('A')]),req([msg('B')],{model:'deepseek',purpose:'summary'}));
    assert.equal(r.comparable,false);assert.equal(r.findings[0].code,'INCOMPARABLE_REQUEST_GROUP');
});

test('summary rewrite and relative date difference are evidence, not proven semantics',()=>{
    const a='历史剧情摘要：5天前见面，大前天战斗'; const b='历史剧情摘要：上周二见面，上周五战斗';
    const r=analyzePair(req([msg(a)]),req([msg(b)]),{previousSources:[{id:'sum',type:'summary',text:a}],sources:[{id:'sum',type:'summary',text:b}]});
    assert.ok(r.findings.some(x=>x.code==='SUMMARY_REWRITE'));assert.ok(r.findings.some(x=>x.code==='RELATIVE_TIME_TEXT_CHANGED'));
});

test('summary fixed-depth-like movement tracks exact text change in position',()=>{
    const s=msg('历史剧情摘要：已经发生A。');
    const r=analyzePair(req([s,msg('B','user')]),req([msg('B','user'),s,msg('C','user')]));
    const finding=r.findings.find(x=>x.code==='SUMMARY_POSITION_MOVED');assert.ok(finding);assert.match(finding.evidence,/hypothesis/);
});

test('historical summary, state briefing, variables and dice stay separate heuristic types',()=>{
    const sources=mapSources(req([msg('历史剧情摘要'),msg('记忆系统私密简报'),msg('status_current_variables'),msg('骰池 d20')]));
    assert.deepEqual(sources.map(x=>x.heuristics[0].type),['historical-summary','current-briefing','variable-snapshot','dice-pool']);
    assert.ok(sources.every(x=>x.heuristics[0].identityConfirmed===false));
});

test('stable breakpoint before dynamic suffix is retained without claiming a hit',()=>{
    const system=[{type:'text',text:'Stable rules',cache_control:{type:'ephemeral'}},{type:'text',text:'State one'}];
    const a={provider:'anthropic',purpose:'main',observationLevel:'server',body:{system,messages:[msg('Go','user')]}};
    const b=structuredClone(a);b.body.system[1].text='State two';
    const r=analyzePair(a,b);assert.equal(r.breakpoints[0].prefixUnchanged,true);assert.equal(r.breakpoints[0].stillConfigured,true);
    assert.equal(r.breakpoints[0].serverHitConfirmed,false);assert.ok(r.findings.some(x=>x.code==='STABLE_EXPLICIT_BREAKPOINT'));
});

test('changing only cache configuration is separate from context contents',()=>{
    const a={system:[{type:'text',text:'same',cache_control:{type:'ephemeral'}}]};
    const b=structuredClone(a);b.system[0].cache_control.ttl='1h';
    const r=analyzePair(a,b);assert.equal(r.equal,true);assert.equal(r.cacheParametersChanged,true);
});

test('block boundary and order are preserved',()=>{
    const a={system:[{type:'text',text:'ab'},{type:'text',text:'cd'}]};
    const b={system:[{type:'text',text:'a'},{type:'text',text:'bcd'}]};
    assert.equal(analyzePair(a,b).equal,false);assert.equal(flattenContext(a).length,2);
});

test('tools and images affect context comparison',()=>{
    const a={tools:[{name:'foo',input_schema:{type:'object'}}],messages:[msg([{type:'image',source:{type:'base64',data:'AAA'}}],'user')]};
    const b=structuredClone(a);b.messages[0].content[0].source.data='BBB';
    assert.equal(analyzePair(a,b).equal,false);
});

test('exact duplicates diagnosed, related content is not deduplicated',()=>{
    const text='人物A的完整设定'.repeat(8);
    const r=diagnoseDuplicates(req([msg(text),msg(text,'user'),msg(text+'续篇')]),{minChars:20});
    assert.equal(r.length,1);assert.equal(r[0].locations.length,2);assert.equal(r[0].safeToRemove,false);
});

test('source repeated inside a combined block is detected only by exact matching',()=>{
    const text='固定规则：秘密只有到第三幕才能揭露。';
    const r=diagnoseDuplicates(req([msg(text+'\n状态更新\n'+text)]),{minChars:5,sources:[{id:'fact',text}]});
    assert.equal(r[0].code,'EXACT_DUPLICATE_SOURCE');assert.equal(r[0].locations.length,2);
});

test('1.5M whole-book tokens are distinct from budget, active, and unknown sent',()=>{
    const r=diagnoseWorldInfo({entries:[{uid:1,content:'huge',constant:false}],activeEntries:[],budgetTokens:12000,tokenCounter:()=>1500000,maxInputTokens:200000});
    assert.equal(r.wholeBook.value,1500000);assert.equal(r.budget.value,12000);assert.equal(r.activated.value,0);assert.equal(r.finalSent.value,null);
    assert.ok(r.findings.some(x=>x.code==='LARGE_BOOK_TOTAL'));assert.ok(!r.findings.some(x=>x.code==='SENT_INPUT_OVER_LIMIT'));
});

test('activated and sent over limits are explicit; missing data remains unknown',()=>{
    const r=diagnoseWorldInfo({entries:[],activeEntries:[{content:'huge'}],budgetTokens:10000,sentTokens:1500100,tokenCounter:()=>1500000,maxInputTokens:200000});
    assert.ok(r.findings.some(x=>x.code==='ACTIVATED_INPUT_OVER_LIMIT'));assert.ok(r.findings.some(x=>x.code==='SENT_INPUT_OVER_LIMIT'));
    assert.equal(diagnoseWorldInfo().activeEntryCount,null);assert.equal(diagnoseWorldInfo().activated.kind,'unknown');
});

test('estimated token counts never labeled precise',()=>{
    assert.equal(estimateTokens('你好 world').kind,'estimate');assert.equal(diagnoseWorldInfo({entries:[{content:'abc'}]}).wholeBook.kind,'estimate');
});

test('OpenAI Responses explicit breakpoint metadata stays separate from context text',()=>{
    const a={input:[msg([{type:'input_text',text:'stable',prompt_cache_breakpoint:{mode:'explicit',ttl:'30m'}},{type:'input_text',text:'variable A'}],'developer')],prompt_cache_options:{mode:'explicit'}};
    const b=structuredClone(a);b.input[0].content[1].text='variable B';
    const r=analyzePair(a,b);assert.equal(r.breakpoints[0].prefixUnchanged,true);
    const c=structuredClone(a);c.input[0].content[0].prompt_cache_breakpoint.ttl='12h';
    assert.equal(analyzePair(a,c).equal,true);assert.equal(analyzePair(a,c).cacheParametersChanged,true);
});

test('structural mismatch after first segment has correct zero offset',()=>{
    const r=analyzePair(req([msg('123456'),msg('next','user')]),req([msg('123456'),msg('next','system')]));
    assert.equal(r.firstDifference.offset,0);assert.equal(r.stablePrefixCharacters,6);assert.equal(r.stablePrefix.tokens.value,2);
});

test('adapter kind and builtin memory key identify summaries without a text heading',()=>{
    const before={id:'extension:1_memory',kind:'history-summary',text:'甲见过乙。',identityConfidence:'verified-builtin'};
    const after={...before,text:'甲与乙已会面。'};
    const r=analyzePair(req([msg(before.text)]),req([msg(after.text)]),{previousSources:[before],sources:[after]});
    assert.ok(r.findings.some(x=>x.code==='SUMMARY_REWRITE'));
    const mapped=mapSources(req([msg(before.text)]),[before]);assert.equal(mapped[0].sources[0].type,'history-summary');assert.equal(mapped[0].sources[0].identityConfirmed,true);
    const moved=analyzePair(req([msg(before.text),msg('hello','user')]),req([msg('hello','user'),msg(before.text)]),{previousSources:[before],sources:[before]});
    assert.ok(moved.findings.some(x=>x.code==='SUMMARY_POSITION_MOVED'));
});

test('thinking and effort changes are configuration evidence, not forced cache misses',()=>{
    const a={messages:[msg('same')],thinking:{type:'enabled',budget_tokens:1024},output_config:{effort:'low'}};
    const b={messages:[msg('same')],thinking:{type:'enabled',budget_tokens:2048},output_config:{effort:'high'}};
    const r=analyzePair(a,b);assert.equal(r.equal,true);assert.equal(r.requestConfigurationChanges.length,2);
    assert.match(r.requestConfigurationChanges[0].cacheImpact,/not proof/);
});

test('unobserved whole book stays unknown rather than zero',()=>{
    assert.equal(diagnoseWorldInfo().wholeBook.kind,'unknown');assert.equal(diagnoseWorldInfo().wholeBook.value,null);
    assert.equal(diagnoseWorldInfo({books:[]}).wholeBook.value,0);
});

test('server relay is marked as outgoing server evidence and grouped by upstream',()=>{
    const a=req([msg('a')],{observationLevel:'server-relay',upstreamOrigin:'https://one.example'});
    const b=req([msg('b')],{observationLevel:'server-relay',upstreamOrigin:'https://two.example'});
    const r=analyzePair(a,b);assert.equal(r.comparable,false);assert.match(r.visibility,/outgoing request/);
});
