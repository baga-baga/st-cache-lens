import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCacheLens } from '../index.js';
import { PROVIDER_RULES } from '../core/providers.js';

const delay=()=>new Promise(r=>setTimeout(r,25));
test('actual panel DOM: observed requests -> bounded preview -> live copy -> rollback, memory and zero-budget Agent',async()=>{
 const dom=new JSDOM('<div id="extensions_settings2"></div>',{url:'http://localhost:8000'});
 const old={};for(const [k,v]of Object.entries({document:dom.window.document,window:dom.window,localStorage:dom.window.localStorage,navigator:{locks:{request:async(name,options,fn)=>(fn||options)()}}})){old[k]=Object.getOwnPropertyDescriptor(globalThis,k);Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});}
 let hooks;
 const context={extensionSettings:{},saveSettingsDebounced(){},getWorldInfoNames:()=>[],chatId:'test-chat'};
 const panel=mountCacheLens({context,storageNamespace:'dom-test',adapterFactory:h=>{hooks=h;return {dispose(){},getSnapshot:()=>({}),getSources:()=>[],inspectWorldBook:async()=>({})};}});
 try{
  await delay();const root=document.getElementById('cache-lens-panel');assert.ok(root);assert.match(root.textContent,/仅观察到前端请求/);
  const q=s=>root.querySelector(s);const set=(id,value)=>{q(`[data-id="${id}"]`).value=value;};const click=async action=>{q(`[data-action="${action}"]`).click();await delay();};
  set('mode','preview');await click('save');
  const a='<lore>动态世界书段落</lore>',b='<rules>固定设定规则</rules>';
  const body={model:'fixture-model',chat_completion_source:'claude',messages:[{role:'system',content:a+'\n'+b},{role:'user',content:'继续'}]};
  const record={id:'dom-1',body,model:'fixture-model',provider:'claude',interfaceType:'anthropic',purpose:'main',observationLevel:'frontend',chatId:'test-chat',status:'complete',timestamp:1,usage:{input_tokens:100,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:10},sources:[{id:'lore1',kind:'world-info',text:a,name:'示例条目'},{id:'rules1',kind:'preset',text:b,name:'示例规则'}]};
  hooks.onRecord(record);await click('capture');assert.equal(root.querySelectorAll('[data-fragment]').length,2);
  root.querySelectorAll('[data-fragment]').forEach(e=>e.checked=true);q('[data-stable="1"]').checked=true;
  await click('copy');assert.match(q('[data-id="history"]').textContent,/"blocks": 2/);
  await click('candidate');assert.match(q('[data-id="preview"]').textContent,/"ok": true/);
  await click('apply');assert.match(q('[data-id="status"]').textContent,/已应用/);
  const transformed=await hooks.transform(structuredClone(body),{chatId:'test-chat',provider:'claude',model:'fixture-model',purpose:'main',interfaceType:'anthropic'});
  assert.equal(transformed.messages[0].content,b+'\n'+a);
  await click('rollback');const restored=await hooks.transform(structuredClone(body),{chatId:'test-chat',provider:'claude',model:'fixture-model',purpose:'main',interfaceType:'anthropic'});assert.deepEqual(restored,body);
  set('eventId','event-1');set('eventDate','2026-11-12');set('eventRelative','今天');set('eventText','确认一个不会被删除的剧情事实。');await click('append-memory');assert.match(q('[data-id="memory"]').textContent,/2026-11-12/);assert.match(q('[data-id="memory"]').textContent,/今天/);
  await click('agent');assert.match(q('[data-id="status"]').textContent,/预算/);
  hooks.onRecord({...record,id:'dom-2',body:null,sources:[],optimizationSkipped:true});q('[data-id="record"]').value='dom-2';q('[data-id="record"]').dispatchEvent(new dom.window.Event('change'));await delay();assert.match(q('[data-id="difference"]').textContent,/未观察到/);
  await click('capture');assert.match(q('[data-id="status"]').textContent,/完整|上下文/);
  for(let i=0;i<35;i++)hooks.onRecord({...record,id:'retention-'+i});
  assert.equal(panel.getRecords().length,30);
  assert.equal(q('[data-id="ledger"] tbody tr td:nth-child(2)').textContent,'37');
  // Exercise actual UI -> durable intent -> versioned remote mock -> full multi-observer restore.
  const originalFetch=globalThis.fetch;
  const policies={main:{policy:{enabled:false},version:'v0',inFlight:0},summary:{policy:{enabled:false},version:'s0',inFlight:0}};let revision=0;
  globalThis.fetch=async(url,init={})=>{const parsed=new URL(url,'http://localhost');const id=parsed.searchParams.get('observerId')||'main';const remote=policies[id];assert.ok(parsed.pathname.endsWith('/relay-policy'));if(init.method==='POST'){const next=JSON.parse(init.body);if(next.expectedVersion!==remote.version)return new Response('{}',{status:409});remote.policy=next.policy;remote.version='v'+(++revision);}return new Response(JSON.stringify(remote),{status:200,headers:{'Content-Type':'application/json'}});};
  try {
    const policy={enabled:true,interfaceType:'anthropic',endpointVerified:true,model:'claude-opus-5-5',stableSystemTexts:['stable'],ttl:'5m',maximumInputTokens:10000,rules:PROVIDER_RULES.anthropic};
    for(const observerId of ['main','summary']){set('observerId',observerId);await click('load-policy');set('policy',JSON.stringify(policy));q('[data-id="verifiedEndpoint"]').checked=true;await click('apply-policy');assert.equal(policies[observerId].policy.enabled,true);}
    assert.equal(context.extensionSettings.cache_lens.relayHistory.length,2);
    assert.equal(context.extensionSettings.cache_lens.pendingRelayIntent,null);
    await click('restore');assert.equal(policies.main.policy.enabled,false);assert.equal(policies.summary.policy.enabled,false);assert.equal(context.extensionSettings.cache_lens.relayHistory.length,0);assert.equal(context.extensionSettings.cache_lens.mode,'diagnose');
  }finally{globalThis.fetch=originalFetch;}
 }finally{panel?.dispose();dom.window.close();for(const [k,descriptor]of Object.entries(old)){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}}
});
