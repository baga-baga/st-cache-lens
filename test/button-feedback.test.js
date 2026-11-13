import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { mountCacheLens } from '../index.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) { for (let i=0;i<200;i++){if(check())return;await pause(5);}assert.fail('Timed out: '+label); }
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const server={configured:true,serverVersion:'0.1.1',capabilities:{agentCheck:true},config:{enabled:true,model:'synthetic-agent',interfaceType:'openai',endpoint:'https://example.invalid/v1/chat/completions',maxOutputTokens:1024,budget:{maxCalls:100,maxCost:10,currency:'USD'},prices:{input:1,output:1,currency:'USD'}},ledger:{calls:0,chargedOrReserved:0,currency:'USD'}};
const setup=()=>({schemaVersion:1,compatibility:{version:'1.19.0',verifiedSource:true},binding:{chatId:'synthetic-chat',characterId:'synthetic-card',groupId:null,provider:'custom',model:'synthetic-story',purpose:'main'},books:[],worldSettings:{world_info_budget:25,world_info_budget_cap:30000},preset:{prompts:[],order:[],orderStrategy:'global',settings:{}},extensionSources:[],snapshot:{},counts:{booksExpected:0,booksLoaded:0,books:0,entries:0},complete:true,truncated:false,optimizationBlocked:false,coverageUnknown:[],warnings:[],revision:{fingerprint:'synthetic-v1',algorithm:'SHA-256'}});
let serial=0;
async function harness({request,collector,locks,awaitReady=true,timeouts={}}={}){
 const dom=new JSDOM('<form id="parent-form"><div id="extensions_settings2"></div></form>',{url:'http://localhost:8000'}),descriptors={},calls=[];
 const lockAPI=locks||{request:async(_n,o,fn)=>(fn||o)()};
 const globals={document:dom.window.document,window:dom.window,localStorage:dom.window.localStorage,navigator:{locks:lockAPI},fetch:async(url,options={})=>{
  const route=String(url).split('/').at(-1),body=options.body?JSON.parse(options.body):null;calls.push({route,body,options});
  if(request){const custom=await request(route,body,options);if(custom)return custom;}
  let result=route==='status'?structuredClone(server):route==='agent-records'?{records:[]}:route==='agent-check'?{ok:true,modelVisible:true,model:'synthetic-agent'}:route==='agent'?{proposal:{expectedVersion:body.proposalContext.expectedVersion,reason:'合成检查结果。',operations:[]}}:null;
  assert.ok(result,'Unexpected request '+route);return {ok:true,status:200,json:async()=>result};
 }};
 for(const[key,value]of Object.entries(globals)){descriptors[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const events=new EventEmitter(),context={chatId:'synthetic-chat',characterId:'synthetic-card',groupId:null,extensionSettings:{cache_lens:{maxTests:100,maxCost:10,currency:'USD'}},saveSettingsDebounced(){},eventSource:events,eventTypes:{CHAT_CHANGED:'CHAT_CHANGED'}};
 let hooks,reads=0;
 const panel=mountCacheLens({context,locks:lockAPI,storageNamespace:'feedback-'+(++serial),operationTimeouts:{read:80,agent:150,setup:80,ready:80,...timeouts},setupCollector:async args=>{reads++;return collector?collector({args,count:reads,setup:setup()}):setup();},adapterFactory:value=>{hooks=value;return {dispose(){},getSnapshot:()=>({})};}});
 if(awaitReady)await panel.ready;
 const q=s=>document.querySelector('#cache-lens-panel '+s),button=name=>q(`[data-action="${name}"]`),feedback=name=>q(`[data-feedback="${name}"]`);
 return {dom,panel,context,hooks,calls,q,button,feedback,get reads(){return reads;},click:name=>button(name).click(),async close(){panel.dispose();await panel.flushObservations();dom.window.close();for(const[key,value]of Object.entries(descriptors)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}};
}

test('check click gives synchronous local feedback and disables duplicates while service status waits',async()=>{
 const gate=defer();const h=await harness({request:async route=>route==='status'?gate.promise:null});
 try{
  h.click('check-agent');assert.match(h.feedback('check-agent').textContent,/已收到/);assert.equal(h.button('check-agent').disabled,true);assert.equal(h.button('check-agent').getAttribute('aria-busy'),'true');assert.match(h.q('[data-id="agentConnection"]').textContent,/连接/);
  h.click('check-agent');await waitFor(()=>h.calls.length===1,'one pending status');
  gate.resolve({ok:true,status:200,json:async()=>structuredClone(server)});
  await waitFor(()=>!h.button('check-agent').disabled,'finished check');
  assert.equal(h.calls.filter(c=>c.route==='status').length,1);assert.equal(h.calls.filter(c=>c.route==='agent-check').length,1);assert.match(h.q('[data-id="agentConnection"]').textContent,/通过/);
 }finally{gate.resolve({ok:true,json:async()=>server});await h.close();}
});

test('server timeout includes a hung JSON response body and reports beside the connection button',async()=>{
 const body=defer();const h=await harness({request:async route=>route==='status'?{ok:true,status:200,json:()=>body.promise}:null});
 try{
  h.click('check-agent');await waitFor(()=>!h.button('check-agent').disabled,'body timeout');
  assert.match(h.feedback('check-agent').textContent,/超时/);assert.match(h.q('[data-id="agentConnection"]').textContent,/超时/);assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.signal.aborted,true);
  body.resolve(structuredClone(server));await pause(20);assert.equal(h.calls.length,1,'late status must not trigger model query');
 }finally{body.resolve(server);await h.close();}
});

test('duplicate and alternate paid buttons cannot enqueue a second audit; metadata-only audit needs no new story request',async()=>{
 const gate=defer();let first=true;const h=await harness({timeouts:{agent:500},request:async(route,body)=>{if(route==='agent'&&first){first=false;await gate.promise;return {ok:true,status:200,json:async()=>({proposal:{expectedVersion:body.proposalContext.expectedVersion,reason:'合成分页结果。',operations:[]}})};}return null;}});
 try{
  h.click('batch-agent');h.click('batch-agent');h.click('agent');
  assert.match(h.feedback('agent').textContent,/已有 Agent/);
  await waitFor(()=>h.calls.some(c=>c.route==='agent'),'pending paid page');h.click('batch-agent');gate.resolve();
  await waitFor(()=>!h.button('batch-agent').disabled,'single audit finishes');
  assert.equal(h.panel.getAgentAudit().status,'complete');assert.equal(h.calls.filter(c=>c.route==='agent').length,2,'one metadata page and one synthesis only');assert.equal(h.panel.getRecords().filter(r=>r.purpose==='main').length,0);
 }finally{gate.resolve();await h.close();}
});

test('in-flight assertion failure appears beside audit controls with zero network calls',async()=>{
 const h=await harness();try{
  h.hooks.onInFlight(1);h.click('batch-agent');await waitFor(()=>!h.button('batch-agent').disabled,'in-flight rejection');
  assert.match(h.q('[data-id="auditProgress"]').textContent,/请求|锁定/);assert.match(h.feedback('batch-agent').textContent,/请求|锁定/);assert.equal(h.calls.length,0);
 }finally{h.hooks.onInFlight(0);await h.close();}
});

test('timed-out setup cannot replace the report from a newer completed scan when it resolves late',async()=>{
 const gate=defer();const old=setup();old.revision.fingerprint='late-old';old.books=[{name:'old-book',loaded:true,entries:[]}];
 const h=await harness({collector:({count,setup:current})=>count===1?gate.promise:current});
 try{
  h.click('batch-agent');await waitFor(()=>!h.button('batch-agent').disabled,'setup timeout');assert.match(h.q('[data-id="auditProgress"]').textContent,/超时/);assert.equal(h.calls.length,0);
  h.click('batch-scan');await waitFor(()=>!h.button('batch-scan').disabled,'new local scan');const report=JSON.stringify(h.panel.getBatchReport());
  gate.resolve(old);await pause(30);assert.equal(JSON.stringify(h.panel.getBatchReport()),report);assert.equal(h.panel.getBatchReport().counts.books,0);assert.equal(h.calls.length,0);
 }finally{gate.resolve(old);await h.close();}
});

test('stop is active during initial local scan and prevents a late scan from causing paid calls',async()=>{
 const gate=defer();const h=await harness({collector:()=>gate.promise,timeouts:{setup:1000}});
 try{
  h.click('batch-agent');await waitFor(()=>h.reads===1,'initial scan');assert.equal(h.button('audit-stop').disabled,false);h.click('audit-stop');
  await waitFor(()=>!h.button('batch-agent').disabled,'cancelled initial scan');assert.match(h.q('[data-id="auditProgress"]').textContent,/停止/);assert.equal(h.calls.length,0);
  gate.resolve(setup());await pause(20);assert.equal(h.calls.length,0);assert.equal(h.panel.getBatchReport(),null);
 }finally{gate.resolve(setup());await h.close();}
});

test('ready lock timeout cancels the click and does not execute it after initialization eventually resolves',async()=>{
 const gate=defer();let released=false;const locks={request:async(_name,options,callback)=>{if(!released)await gate.promise;return (callback||options)();}};
 const h=await harness({locks,awaitReady:false});
 try{
  h.click('check-agent');await waitFor(()=>!h.button('check-agent').disabled,'ready timeout');assert.match(h.feedback('check-agent').textContent,/初始化.*超时/);assert.equal(h.calls.length,0);
  released=true;gate.resolve();await h.panel.ready;await pause(20);assert.equal(h.calls.length,0,'cancelled click must not resume later');
 }finally{released=true;gate.resolve();await h.panel.ready;await h.close();}
});

test('extension controls are non-submit buttons even when mounted inside a host form',async()=>{
 const h=await harness();let submissions=0;h.dom.window.document.querySelector('form').addEventListener('submit',event=>{submissions++;event.preventDefault();});
 try{assert.ok([...h.dom.window.document.querySelectorAll('#cache-lens-panel button')].every(b=>b.type==='button'));h.click('audit-setup');await waitFor(()=>!h.button('audit-setup').disabled,'setup navigation');assert.equal(submissions,0);assert.equal(h.calls.length,0);}finally{await h.close();}
});
