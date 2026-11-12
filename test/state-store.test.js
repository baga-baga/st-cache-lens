import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserStateStore } from '../adapters/state-store.js';
import { stableStringify } from '../core/optimizer.js';
function fixture() {
  const values=new Map(); const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  let queue=Promise.resolve();const locks={request:(_name,_options,fn)=>{const r=queue.then(fn);queue=r.catch(()=>{});return r;}};
  return {storage,locks};
}
test('durable compare-and-swap allows one of two stale tabs and preserves full linked state',async()=>{
 const env=fixture(),a=createBrowserStateStore({key:'cache-lens:test',...env}),b=createBrowserStateStore({key:'cache-lens:test',...env});
 const initial={state:{version:0},memory:{events:[]},mode:'preview'};await a.initialize(initial);
 const old=stableStringify(initial);
 const results=await Promise.all([a.compareAndSwap(old,{...initial,state:{version:1},mode:'automatic'}),b.compareAndSwap(old,{...initial,state:{version:2}})]);
 assert.deepEqual(results,[true,false]);assert.equal(b.read().state.version,1);assert.equal(b.read().mode,'automatic');
});
test('quota and request-in-flight guard failures leave stored state untouched',async()=>{
 const env=fixture(),store=createBrowserStateStore({key:'cache-lens:test',...env});const initial={v:1};await store.initialize(initial);const snapshot=stableStringify(initial);
 await assert.rejects(store.compareAndSwap(snapshot,{v:2},{guard:()=>{throw new Error('request active')}}),/request active/);assert.deepEqual(store.read(),initial);
 env.storage.setItem=()=>{throw new Error('quota exceeded')};
 await assert.rejects(store.compareAndSwap(snapshot,{v:2}),/quota/);assert.deepEqual(store.read(),initial);
});
test('a browser without cross-tab locking fails closed and can still read existing state',async()=>{
 const env=fixture();env.storage.setItem('cache-lens:test','{"v":1}');const store=createBrowserStateStore({key:'cache-lens:test',storage:env.storage,locks:{}});
 assert.equal(store.read().v,1);await assert.rejects(store.compareAndSwap('{"v":1}',{v:2}),/Web Locks/);
});
