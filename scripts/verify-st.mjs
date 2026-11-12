// Uses a disposable official SillyTavern checkout. All upstream responses are local synthetic fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRelay } from '../server/relay.mjs';
const args=process.argv.slice(2),st=args[args.indexOf('--st')+1];
if(!st||!args.includes('--isolated-test-copy'))throw new Error('Use --st /disposable/SillyTavern --isolated-test-copy; never point this verifier at your playing instance.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const installer=spawnSync(process.execPath,[path.join(root,'scripts/install.mjs'),'--st',path.resolve(st),'--frontend','--server'],{encoding:'utf8'});if(installer.status)throw new Error(installer.stderr);
const hostVersion=JSON.parse(await readFile(path.join(st,'package.json'),'utf8')).version;
let seen=[], modelLookups=0;
const mock=http.createServer(async(req,res)=>{if(req.method==='GET'&&req.url==='/v1/models/synthetic-visible-model'){assert.equal(req.headers.authorization,'Bearer synthetic-check-key');modelLookups++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic-visible-model',object:'model'}));return;}let text='';for await(const chunk of req)text+=chunk;const b=JSON.parse(text);seen.push(b);assert.equal(req.headers['x-api-key'],'synthetic-upstream-key');res.setHeader('Content-Type',b.stream?'text/event-stream':'application/json');const usage={input_tokens:20,cache_creation_input_tokens:100,cache_read_input_tokens:0,output_tokens:5};if(b.stream){res.end('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{usage:{...usage,output_tokens:0}}})+'\n\nevent: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'synthetic response'}})+'\n\nevent: message_delta\ndata: '+JSON.stringify({type:'message_delta',usage:{output_tokens:5}})+'\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');}else res.end(JSON.stringify({id:'synthetic',type:'message',role:'assistant',model:b.model,content:[{type:'text',text:'synthetic response'}],usage}));});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const relayToken='synthetic-local-token-with-32-characters';
const relay=createRelay({interfaceType:'anthropic',upstreamBaseUrl:`http://127.0.0.1:${mock.address().port}`,apiKey:'synthetic-upstream-key',relayToken,allowLocalUpstream:true,modelPurpose:{'claude-opus-5-5':'main'}});
await new Promise(r=>relay.listen(0,'127.0.0.1',r));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
let log='';
const child=spawn(process.execPath,['server.js','--port',String(port),'--listen','false','--browserLaunchEnabled','false'],{cwd:path.resolve(st),env:{...process.env,SILLYTAVERN_ENABLESERVERPLUGINS:'true',SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE:'false'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',v=>{log+=v;});child.stderr.on('data',v=>{log+=v;});
const base=`http://127.0.0.1:${port}`;
try{
 let ready=false;for(let i=0;i<120;i++){if(child.exitCode!==null)throw new Error('ST exited: '+log.slice(-2000));try{const r=await fetch(base+'/csrf-token');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'ST startup timeout');
 const csrfResponse=await fetch(base+'/csrf-token');const cookie=csrfResponse.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');const {token}=await csrfResponse.json();
 const request=async(url,body)=>{const r=await fetch(base+url,{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':token},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200,await r.clone().text());return r;};
 assert.match(await(await request('/scripts/extensions/third-party/st-cache-lens/index.js')).text(),/mountCacheLens/);
 const status=await(await request('/api/plugins/cache-lens/status')).json();assert.equal(status.configured,false);assert.equal(status.serverVersion,'0.1.1');assert.equal(status.capabilities.agentCheck,true);
 const checked=await(await request('/api/plugins/cache-lens/agent-check',{interfaceType:'openai',endpoint:`http://127.0.0.1:${mock.address().port}/v1/chat/completions`,model:'synthetic-visible-model',apiKey:'synthetic-check-key',allowLocal:true})).json();assert.equal(checked.modelVisible,true);assert.equal(checked.generationVerified,false);assert.equal(modelLookups,1);assert.equal(seen.length,0);const afterCheck=await(await request('/api/plugins/cache-lens/status')).json();assert.deepEqual(afterCheck.ledger,status.ledger);assert.equal(afterCheck.configured,false);
 await request('/api/plugins/cache-lens/observer-config',{relayBaseUrl:`http://127.0.0.1:${relay.address().port}`,relayToken});
 for(const stream of [false,true]){const r=await request('/api/backends/chat-completions/generate',{chat_completion_source:'claude',model:'claude-opus-5-5',reverse_proxy:`http://127.0.0.1:${relay.address().port}/v1`,proxy_password:relayToken,use_sysprompt:true,max_tokens:128,stream,messages:[{role:'system',content:'Stable synthetic rule'},{role:'user',content:'Synthetic test only'}]});const text=await r.text();assert.match(text,/synthetic response/);}
 const observed=await(await request('/api/plugins/cache-lens/relay-records')).json();assert.equal(observed.records.length,2);assert.equal(observed.records[0].usage.cache_creation_input_tokens,100);assert.equal(observed.records[1].usage.output_tokens,5);assert.ok(Array.isArray(seen[0].system));assert.equal(seen[0].system[0].text,'Stable synthetic rule');assert.equal(JSON.stringify(observed).includes('synthetic-upstream-key'),false);assert.equal(JSON.stringify(observed).includes(relayToken),false);
 const report={hostVersion,hostSource:'official release checkout',checks:['extension HTTP module served','server plugin authenticated route','CSRF-protected settings route','official ST Claude conversion -> relay -> mock upstream','nonstream JSON forwarded','Anthropic SSE forwarded','relay usage preserved where ST nonstream omits it','no credentials in observation records','CSRF-protected unsaved Agent model check makes only GET with no generation','Agent model check preserves zero budget and unsaved configuration'],passed:10,paidApiCalls:0,providerCacheImprovementVerified:false,syntheticUpstream:true};
 console.log(JSON.stringify(report,null,2));if(args.includes('--output'))await writeFile(args[args.indexOf('--output')+1],JSON.stringify(report,null,2));
}finally{child.kill('SIGTERM');await Promise.all([new Promise(r=>relay.close(r)),new Promise(r=>mock.close(r))]);}
