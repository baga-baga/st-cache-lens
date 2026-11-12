import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPolicyTransaction, recoverPolicyIntent, rollbackPolicyTransaction, advanceHistoryAfterRollback, rebasePolicyHistory } from '../adapters/relay-control.js';
const copy=v=>structuredClone(v);
function fixture() {
 let state={policy:{enabled:false},version:'v0',inFlight:0},counter=0,intent=null,history=[],writes=0;
 const api=async(action,body)=>{if(action==='get')return copy(state);assert.equal(action,'set');assert.equal(body.expectedVersion,state.version);if(state.inFlight)throw new Error('busy');writes++;state={policy:copy(body.policy),version:'v'+(++counter),inFlight:0};return copy(state);};
 const options={observerId:'main',api,saveIntent:async v=>{intent=copy(v)},commitHistory:async(entry,committed)=>{history.push(copy(entry));intent=copy(committed)},clearIntent:async id=>{assert.equal(id,intent.id);intent=null},onCompensated:async({state:current,intent:i})=>{history=rebasePolicyHistory(history,i.observerId,current)}};
 return {options,get state(){return state},set state(v){state=v},get intent(){return intent},get history(){return history},set history(v){history=v},get writes(){return writes}};
}
const enabled={enabled:true,ttl:'5m'};
test('durable intent precedes remote CAS and committed history; cleanup is safe',async()=>{
 const f=fixture();const result=await applyPolicyTransaction({...f.options,policy:enabled,expectedVersion:'v0'});
 assert.equal(result.changed,true);assert.deepEqual(f.state.policy,enabled);assert.equal(f.history.length,1);assert.equal(f.intent,null);
});
test('failed initial durable save performs no remote write',async()=>{
 const f=fixture();await assert.rejects(applyPolicyTransaction({...f.options,policy:enabled,expectedVersion:'v0',saveIntent:async()=>{throw new Error('quota')}}),/quota/);assert.equal(f.writes,0);
});
test('failed history commit compensates exact remote version and preserves old policy',async()=>{
 const f=fixture();await assert.rejects(applyPolicyTransaction({...f.options,policy:enabled,expectedVersion:'v0',commitHistory:async()=>{throw new Error('quota')}}),e=>{assert.equal(e.code,'LOCAL_COMMIT_FAILED');assert.equal(e.recovery.status,'restored');return true});
 assert.deepEqual(f.state.policy,{enabled:false});assert.equal(f.state.version,'v2');assert.equal(f.history.length,0);assert.equal(f.intent,null);
});
test('concurrent remote update is not overwritten during compensation',async()=>{
 const f=fixture();await assert.rejects(applyPolicyTransaction({...f.options,policy:enabled,expectedVersion:'v0',commitHistory:async()=>{f.state={policy:{enabled:true,ttl:'1h'},version:'external',inFlight:0};throw new Error('conflict')}}),e=>{assert.equal(e.recovery.status,'concurrent-change');return true});
 assert.equal(f.state.policy.ttl,'1h');assert.ok(f.intent);assert.equal(f.writes,1);
});
test('network loss after remote write leaves ownership uncertain and does not blindly restore',async()=>{
 const f=fixture();const api=async(action,body)=>{const result=await f.options.api(action,body);if(action==='set')throw new Error('network lost');return result;};
 await assert.rejects(applyPolicyTransaction({...f.options,api,policy:enabled,expectedVersion:'v0'}),e=>{assert.equal(e.recovery.status,'uncertain-remote-ownership');return true});
 assert.equal(f.writes,1);assert.deepEqual(f.state.policy,enabled);assert.equal(f.intent.phase,'prepared');
});
test('committed intent cleanup failure never undoes a committed policy',async()=>{
 const f=fixture();const result=await applyPolicyTransaction({...f.options,policy:enabled,expectedVersion:'v0',clearIntent:async()=>{throw new Error('local quota')}});
 assert.equal(result.intentPending,true);assert.equal(f.intent.phase,'committed');assert.deepEqual(f.state.policy,enabled);
 const recovered=await recoverPolicyIntent({...f.options,intent:f.intent});assert.equal(recovered.status,'committed-cleanup');assert.equal(f.writes,1);
});
test('crash recovery restores only exact known applied version and rechecks in-flight',async()=>{
 const f=fixture();await applyPolicyTransaction({...f.options,policy:enabled,expectedVersion:'v0'});
 const intent={schemaVersion:1,id:'crash',observerId:'main',before:{enabled:false},after:enabled,expectedVersion:'v0',appliedVersion:'v1',phase:'applied'};
 f.state.inFlight=1;const busy=await recoverPolicyIntent({intent,api:f.options.api,clearIntent:async()=>{}});assert.equal(busy.status,'request-in-progress');
 f.state.inFlight=0;const recovered=await recoverPolicyIntent({intent,api:f.options.api,clearIntent:async()=>{}});assert.equal(recovered.status,'restored');assert.deepEqual(f.state.policy,{enabled:false});
});
test('multi-round undo rebases prior observer version and preserves other observers',async()=>{
 const f=fixture();await applyPolicyTransaction({...f.options,policy:enabled,expectedVersion:'v0'});
 await applyPolicyTransaction({...f.options,policy:{enabled:true,ttl:'1h'},expectedVersion:'v1'});
 const last=f.history.at(-1);
 await rollbackPolicyTransaction({...f.options,entry:last,commitHistory:async(entry,committed)=>{f.history=advanceHistoryAfterRollback(f.history,last,{policy:entry.after,version:entry.version,inFlight:0});await f.options.saveIntent(committed)}});
 assert.equal(f.history.length,1);assert.equal(f.history[0].version,'v3');assert.deepEqual(f.state.policy,enabled);
 const prior=f.history.at(-1);await rollbackPolicyTransaction({...f.options,entry:prior,commitHistory:async(entry,committed)=>{f.history=advanceHistoryAfterRollback(f.history,prior,{policy:entry.after,version:entry.version,inFlight:0});await f.options.saveIntent(committed)}});
 assert.deepEqual(f.state.policy,{enabled:false});assert.equal(f.history.length,0);
});
test('compensating a failed new edit rebases the older active stack version',async()=>{
 const f=fixture();await applyPolicyTransaction({...f.options,policy:enabled,expectedVersion:'v0'});
 await assert.rejects(applyPolicyTransaction({...f.options,policy:{enabled:true,ttl:'1h'},expectedVersion:'v1',commitHistory:async()=>{throw new Error('quota')}}));
 assert.equal(f.history[0].version,'v3');assert.deepEqual(f.history[0].after,f.state.policy);
});
