import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsage,calculateCost,summarizeUsage,mergeStreamUsage} from '../core/usage.js';
const prices={currency:'USD',source:'configured example rates',updatedAt:'2026-11-12',input:4,cacheRead:0.2,cacheWrite:5,cacheWrite5m:5,cacheWrite1h:8,cacheWrite30m:5,cacheWrite12h:10,output:20};

test('Anthropic inputs are exclusive categories and cache reads not double counted',()=>{
    const n=normalizeUsage({input_tokens:100,cache_creation_input_tokens:800,cache_read_input_tokens:1200,output_tokens:50},'anthropic');
    assert.equal(n.totalInput,2100);assert.equal(n.ordinaryInput,100);assert.equal(n.cacheReadRatio,1200/2100);assert.equal(n.complete,true);
    assert.equal(calculateCost(n,prices).amount,(100*4+800*5+1200*.2+50*20)/1e6);
});

test('Anthropic mixed TTL components charged once',()=>{
    const n=normalizeUsage({input_tokens:100,cache_creation_input_tokens:800,cache_read_input_tokens:1200,output_tokens:50,cache_creation:{ephemeral_5m_input_tokens:300,ephemeral_1h_input_tokens:500}},'anthropic');
    const c=calculateCost(n,prices);assert.equal(c.amount,(100*4+300*5+500*8+1200*.2+50*20)/1e6);
    assert.ok(!c.components.some(x=>x.bucket==='cacheWrite'));
});

test('OpenAI legacy Chat total input includes cached tokens',()=>{
    const n=normalizeUsage({prompt_tokens:1000,prompt_tokens_details:{cached_tokens:600},completion_tokens:80},'openai');
    assert.equal(n.totalInput,1000);assert.equal(n.ordinaryInput,400);assert.equal(n.cacheRead,600);assert.equal(n.cacheWrite,0);
    assert.equal(calculateCost(n,prices).amount,(400*4+600*.2+80*20)/1e6);
});

test('OpenAI Responses 30m and 12h writes are non-overlapping exclusive input categories',()=>{
    const n=normalizeUsage({input_tokens:12000,input_tokens_details:{cached_tokens:4000,cache_write_tokens:7000,cache_write_tokens_details:{ttl_30m_tokens:3000,ttl_12h_tokens:4000}},output_tokens:0},'openai-responses');
    assert.equal(n.ordinaryInput,1000);assert.equal(n.cacheWrite,7000);assert.equal(n.totalInput,12000);
    const c=calculateCost(n,{currency:'USD',input:1,cacheRead:.1,cacheWrite30m:1.25,cacheWrite12h:2.5,output:1});
    assert.equal(c.amount,.01515);
});

test('Responses omitted write count cannot be fabricated as zero',()=>{
    const n=normalizeUsage({input_tokens:1000,input_tokens_details:{cached_tokens:600},output_tokens:80},'openai-responses');
    assert.equal(n.cacheWrite,null);assert.equal(n.ordinaryInput,null);assert.equal(n.complete,false);assert.equal(calculateCost(n,prices).amount,null);
});

test('DeepSeek aliases are not summed and its purpose remains external',()=>{
    const n=normalizeUsage({prompt_tokens:1000,prompt_cache_hit_tokens:700,prompt_cache_miss_tokens:300,prompt_tokens_details:{cached_tokens:700},completion_tokens:50},'deepseek');
    assert.equal(n.cacheRead,700);assert.equal(n.ordinaryInput,300);assert.equal(n.cacheWrite,0);assert.equal(n.totalInput,1000);assert.equal(n.cacheReadRatio,.7);
});

test('unknown compatible gateway usage never inferred from a Claude model name',()=>{
    const n=normalizeUsage({input_tokens:1000,output_tokens:20},'relay-unknown');
    assert.equal(n.totalInput,1000);assert.equal(n.ordinaryInput,null);assert.equal(n.complete,false);assert.equal(calculateCost(n,prices).amount,null);
});

test('missing usage, missing rate, or currency remain unknown',()=>{
    assert.equal(normalizeUsage(null).reported,false);assert.equal(calculateCost(normalizeUsage(null),prices).amount,null);
    const n=normalizeUsage({input_tokens:10,output_tokens:2},'anthropic');
    assert.equal(calculateCost(n,{currency:'USD',input:4}).amount,null);assert.equal(calculateCost(n,{input:4,output:20}).amount,null);
});

test('missing mixed TTL applicable price is not substituted from input price',()=>{
    const n=normalizeUsage({input_tokens:100,input_tokens_details:{cached_tokens:0,cache_write_tokens:100,cache_write_tokens_details:{ttl_30m_tokens:0,ttl_12h_tokens:100}},output_tokens:0},'openai-responses');
    const c=calculateCost(n,{currency:'USD',input:1,output:1,cacheWrite:2});
    assert.equal(c.amount,null);assert.ok(c.missing.includes('cacheWrite12h:price(cacheWrite12h)'));
});

test('inconsistent provider counts fail closed for cost calculation',()=>{
    const n=normalizeUsage({prompt_tokens:100,prompt_cache_hit_tokens:90,prompt_cache_miss_tokens:20,completion_tokens:3},'deepseek');
    assert.equal(n.invalid,true);assert.equal(calculateCost(n,prices).amount,null);
    const over=normalizeUsage({prompt_tokens:100,prompt_tokens_details:{cached_tokens:150},completion_tokens:3},'openai');
    assert.equal(over.invalid,true);assert.equal(over.ordinaryInput,null);
});

test('merge stream usage overwrites cumulative snapshots, preserving absent fields',()=>{
    const start={input_tokens:100,cache_read_input_tokens:600,output_tokens:0};
    const end=mergeStreamUsage(mergeStreamUsage(start,{output_tokens:20}),{output_tokens:40});
    assert.equal(end.output_tokens,40);assert.equal(end.input_tokens,100);assert.equal(end.cache_read_input_tokens,600);
});

test('summary groups purpose/provider/model and never cross-sums currencies',()=>{
    const usage={prompt_tokens:1000,prompt_tokens_details:{cached_tokens:600},completion_tokens:80};
    const records=[{purpose:'main',model:'claude',provider:'gateway',interfaceType:'openai',usage,prices},
        {purpose:'summary',model:'deepseek',provider:'gateway',interfaceType:'openai',usage,prices:{...prices,currency:'CNY'}},
        {purpose:'optimizer',model:'small',provider:'gateway',interfaceType:'openai',usage:null,prices}];
    const groups=summarizeUsage(records);assert.equal(groups.length,3);assert.equal(groups[0].requests,1);assert.equal(groups[1].currency,'CNY');
    assert.equal(groups[2].cost,null);assert.equal(groups[2].unknownUsageRequests,1);
});

test('zero-token categories require no invented price',()=>{
    const n=normalizeUsage({input_tokens:0,output_tokens:0},'anthropic');
    assert.equal(calculateCost(n,{currency:'USD'}).amount,0);assert.equal(n.cacheReadRatio,null);
});

test('untrusted streamed usage cannot modify prototypes',()=>{
    const patch=JSON.parse('{"__proto__":{"polluted":true},"output_tokens":5}');
    const result=mergeStreamUsage({},patch);assert.equal(result.output_tokens,5);assert.equal(result.polluted,undefined);assert.equal({}.polluted,undefined);
});
