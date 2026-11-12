import test from 'node:test';
import assert from 'node:assert/strict';
import { transformRequest, validateCachePolicy, defaultAnthropicRules } from '../server/transform.mjs';
const config={interfaceType:'anthropic',cachePolicy:{enabled:true,interfaceType:'anthropic',endpointVerified:true,model:'claude-opus-5-5',stableSystemTexts:['stable'],ttl:'5m',maximumInputTokens:10000,rules:defaultAnthropicRules}};
test('relay adds real structured breakpoint without changing data/roles',()=>{
 const body={model:'claude-opus-5-5',system:[{type:'text',text:'stable'},{type:'text',text:'time today'}],messages:[{role:'user',content:'go'}]};
 const record={};const result=transformRequest(body,{config,record});assert.deepEqual(result.system[0].cache_control,{type:'ephemeral',ttl:'5m'});assert.equal(body.system[0].cache_control,undefined);assert.equal(result.system[1].text,'time today');assert.equal(record.transformation.minimumVerified,false);
 body.system[0].text='changed';assert.deepEqual(transformRequest(body,{config,record}),body);
});
test('unknown interface, model alias and TTL reject; input 1.5 million refused',()=>{
 assert.throws(()=>validateCachePolicy({...config.cachePolicy,interfaceType:'openai'}));
 assert.throws(()=>validateCachePolicy({...config.cachePolicy,model:'proxy/opus'}));
 const body={model:'claude-opus-5-5',system:[{type:'text',text:'stable'}],messages:[{role:'user',content:'x'.repeat(1500000)}]};const record={};assert.throws(()=>transformRequest(body,{config,record}),error=>error.statusCode===413);assert.equal(record.transformation.requestBlocked,true);
 body.system[0].text='changed';assert.throws(()=>transformRequest(body,{config,record}),error=>error.statusCode===413);
});
test('existing controls and unverified tools prefix are preserved without new claims',()=>{
 const base={model:'claude-opus-5-5',system:[{type:'text',text:'stable'}],messages:[{role:'user',content:'go'}]};
 for(const body of [
   {...base,tools:[{name:'changing_tool',input_schema:{type:'object'}}]},
   {...base,cache_control:{type:'ephemeral'}},
   {...base,system:[{type:'text',text:'stable',cache_control:{type:'ephemeral'}}]},
 ]) { const record={};assert.deepEqual(transformRequest(body,{config,record}),body);assert.equal(record.transformation.applied,false); }
});
test('matching cache policy refuses input whose text-only bound cannot be established',()=>{
 const body={model:'claude-opus-5-5',system:[{type:'text',text:'stable'}],messages:[{role:'user',content:[{type:'image',source:{type:'base64',data:'abc'}}]}]};
 assert.throws(()=>transformRequest(body,{config}),error=>error.statusCode===422);
 const unrelated={...body,model:'different-model'};assert.deepEqual(transformRequest(unrelated,{config}),unrelated);
});
