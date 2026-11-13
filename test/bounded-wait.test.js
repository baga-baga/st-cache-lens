import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedWait } from '../adapters/bounded-wait.js';

test('bounded read aborts on deadline, ignores late completion and never retries',async()=>{
 let release,calls=0,signal;const delayed=new Promise(resolve=>{release=resolve;});
 await assert.rejects(boundedWait(s=>{calls++;signal=s;return delayed;},{timeoutMs:15,message:'test deadline'}),e=>e.code==='LOCAL_OPERATION_TIMEOUT');
 assert.equal(signal.aborted,true);release('late');await Promise.resolve();assert.equal(calls,1);
});
test('pre-cancelled and active-cancelled bounded reads do not start or repeat work',async()=>{
 const before=new AbortController();before.abort();let calls=0;
 await assert.rejects(boundedWait(()=>{calls++;},{signal:before.signal}),e=>e.code==='LOCAL_OPERATION_ABORTED');assert.equal(calls,0);
 const during=new AbortController();let signal;
 const waiting=boundedWait(s=>{calls++;signal=s;return new Promise(()=>{});},{signal:during.signal,timeoutMs:100});
 await Promise.resolve();during.abort();await assert.rejects(waiting,e=>e.code==='LOCAL_OPERATION_ABORTED');assert.equal(calls,1);assert.equal(signal.aborted,true);
});
