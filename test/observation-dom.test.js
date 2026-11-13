import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCacheLens } from '../index.js';

const delay=()=>new Promise(resolve=>setTimeout(resolve,30));
test('actual panel reload preserves redacted usage and comparisons, keeps failed baseline visible, and never optimizes archived prompts',async()=>{
 const dom=new JSDOM('<div id="extensions_settings2"></div>',{url:'http://localhost:8000'});
 const old={};for(const [k,v]of Object.entries({document:dom.window.document,window:dom.window,localStorage:dom.window.localStorage,navigator:{locks:{request:async(name,options,fn)=>(fn||options)()}}})){old[k]=Object.getOwnPropertyDescriptor(globalThis,k);Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});}
 let hooks,panel;const context={extensionSettings:{},saveSettingsDebounced(){},getWorldInfoNames:()=>[]};
 const mount=(name='archive-dom')=>mountCacheLens({context,storageNamespace:name,adapterFactory:h=>{hooks=h;return {dispose(){},getSnapshot:()=>({})};}});
 const record=(id,content,status='complete')=>({id,model:'test-model',provider:'custom',interfaceType:'openai',purpose:'main',chatId:'PRIVATE_CHAT',observationLevel:'frontend',status,startedAt:`2026-11-12T16:0${id.slice(-1)}:00.000Z`,body:{messages:[{role:'system',content}]},sources:[{id:'PRIVATE_SOURCE',text:content}],usage:status==='complete'?{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:40}}:null});
 try{
  panel=mount();await panel.ready;
  hooks.onRecord(record('case-1','PRIVATE_TEXT_甲'));
  hooks.onRecord(record('case-2','PRIVATE_TEXT_乙','http-error'));
  hooks.onRecord(record('case-3','PRIVATE_TEXT_丙'));
  await panel.flushObservations();
  const saved=localStorage.getItem('cache-lens:observations:v1:archive-dom');assert.ok(saved);assert.equal(saved.includes('PRIVATE_'),false);assert.match(saved,/cached_tokens/);
  panel.dispose();panel=mount();await panel.ready;
  assert.equal(panel.getRecords().length,3);assert.ok(panel.getRecords().every(r=>r.archived&&!r.body&&r.sources.length===0));
  const root=document.getElementById('cache-lens-panel'),q=s=>root.querySelector(s);
  assert.match(q('[data-id="archiveStatus"]').textContent,/已恢复 3/);
  assert.equal(q('[data-id="ledger"] tbody tr td:nth-child(2)').textContent,'3');
  q('[data-id="record"]').value='case-3';q('[data-id="record"]').dispatchEvent(new dom.window.Event('change'));
  assert.match(q('[data-id="differenceSummary"]').textContent,/比较对象是一次失败请求/);
  assert.equal(panel.getDiagnostics().comparison.previousStatus,'http-error');assert.equal(panel.getDiagnostics().firstDifference.path,'messages[0].content');
  q('[data-action="capture"]').click();await delay();assert.match(q('[data-id="status"]').textContent,/完整上下文/);
  hooks.onRecord(record('case-4','PRIVATE_TEXT_丁'));await panel.flushObservations();
  q('[data-id="record"]').value='case-4';q('[data-id="record"]').dispatchEvent(new dom.window.Event('change'));
  assert.equal(panel.getDiagnostics().firstDifference,null,'old metadata must not serve as raw comparison baseline');
  hooks.onRecord(record('case-5','PRIVATE_TEXT_戊'));await panel.flushObservations();assert.equal(panel.getRecords().find(r=>r.id==='case-5').diagnostic.comparison.previousStartedAt,'2026-11-12T16:04:00.000Z');
  q('[data-action="clear"]').click();await delay();assert.equal(panel.getRecords().length,0);
  panel.dispose();panel=mount();await panel.ready;assert.equal(panel.getRecords().length,0);
 }finally{panel?.dispose();dom.window.close();for(const [k,descriptor]of Object.entries(old)){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}}
});

test('corrupt archive can be explicitly cleared; failed removal preserves current observations',async()=>{
 const dom=new JSDOM('<div id="extensions_settings2"></div>',{url:'http://localhost:8000'});const oldDocument=globalThis.document;globalThis.document=dom.window.document;
 const map=new Map([['cache-lens:observations:v1:corrupt-user','{broken']]);let failClear=false,hooks,panel;
 const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>{if(failClear)throw Error('storage denied');map.delete(k);}};
 const locks={request:async(name,options,fn)=>(fn||options)()};const context={extensionSettings:{},saveSettingsDebounced(){},getWorldInfoNames:()=>[]};
 const mount=()=>mountCacheLens({context,storageNamespace:'corrupt-user',storage,locks,adapterFactory:h=>{hooks=h;return {dispose(){},getSnapshot:()=>({})};}});
 const emit=id=>hooks.onRecord({id,provider:'custom',interfaceType:'openai',model:'m',purpose:'main',observationLevel:'frontend',status:'complete',body:{messages:[{role:'user',content:'PRIVATE'}]}});
 try{
  panel=mount();await panel.ready;let root=document.getElementById('cache-lens-panel');assert.match(root.querySelector('[data-id="archiveStatus"]').textContent,/损坏/);
  emit('first');assert.equal(map.get('cache-lens:observations:v1:corrupt-user'),'{broken');
  failClear=true;root.querySelector('[data-action="clear"]').click();await delay();assert.equal(panel.getRecords().length,1);assert.equal(map.get('cache-lens:observations:v1:corrupt-user'),'{broken');
  failClear=false;root.querySelector('[data-action="clear"]').click();await delay();assert.equal(panel.getRecords().length,0);assert.equal(map.has('cache-lens:observations:v1:corrupt-user'),false);
  emit('second');await panel.flushObservations();assert.ok(map.get('cache-lens:observations:v1:corrupt-user').includes('second'));
  panel.dispose();panel=mount();await panel.ready;assert.equal(panel.getRecords()[0].id,'second');assert.equal(panel.getRecords()[0].body,undefined);
 }finally{panel?.dispose();dom.window.close();globalThis.document=oldDocument;}
});
