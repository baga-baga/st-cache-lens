/** Provider usage is evidence, not a prediction. Currency conversion is never implicit. */
const has = (v,k) => Object.prototype.hasOwnProperty.call(v||{},k);
const validCount = x => typeof x==='number' && Number.isFinite(x) && x>=0 && Number.isInteger(x);
const count = x => validCount(x)?x:null;
const sum = (...v) => v.every(x=>x!==null)?v.reduce((a,b)=>a+b,0):null;
const equalCount = (a,b) => a===null||b===null||a===b;

/** Merge cumulative stream snapshots by field, never add repeated usage chunks. */
export function mergeStreamUsage(previous={},patch={}) {
    const result={...previous};
    for(const [key,value] of Object.entries(patch??{})) {
        if(['__proto__','prototype','constructor'].includes(key)) continue;
        if(value&&typeof value==='object'&&!Array.isArray(value)) result[key]=mergeStreamUsage(previous?.[key]??{},value);
        else if(value!==null&&value!==undefined) result[key]=value;
    }
    return result;
}

export function normalizeUsage(raw,interfaceType='auto') {
    const u=raw?.usage??raw;
    const base={interfaceType,ordinaryInput:null,cacheWrite:null,cacheRead:null,output:null,totalInput:null,
        cacheWrite5m:null,cacheWrite1h:null,cacheWrite30m:null,cacheWrite12h:null,
        cacheReadRatio:null,ratioDenominator:'cacheRead / totalInput; totalInput = ordinaryInput + cacheWrite + cacheRead',
        reported:false,complete:false,invalid:false,warnings:[],evidence:'provider-usage'};
    if(!u||typeof u!=='object')return base;
    const warnings=base.warnings;
    const output=count(u.output_tokens??u.completion_tokens);
    let type=String(interfaceType??'auto').toLowerCase();
    if(type==='auto'||type==='unknown') {
        if(has(u,'cache_creation_input_tokens')||has(u,'cache_read_input_tokens'))type='anthropic';
        else if(has(u,'prompt_cache_hit_tokens')||has(u,'prompt_cache_miss_tokens'))type='deepseek';
        else if(has(u,'input_tokens')||has(u,'input_tokens_details'))type='openai-responses';
        else if(has(u,'prompt_tokens'))type='openai-chat';
        else type='unknown';
    }
    base.interfaceType=type;
    base.output=output;
    if(/anthropic|claude-messages|anthropic-messages/.test(type)) {
        base.ordinaryInput=count(u.input_tokens);
        base.cacheWrite=count(u.cache_creation_input_tokens??0);
        base.cacheRead=count(u.cache_read_input_tokens??0);
        const d=u.cache_creation;
        if(d&&typeof d==='object') {
            base.cacheWrite5m=count(d.ephemeral_5m_input_tokens??0);
            base.cacheWrite1h=count(d.ephemeral_1h_input_tokens??0);
            if(!equalCount(sum(base.cacheWrite5m,base.cacheWrite1h),base.cacheWrite))warnings.push('Anthropic cache_creation TTL counts do not sum to cache_creation_input_tokens.');
        } else if(base.cacheWrite===0){base.cacheWrite5m=0;base.cacheWrite1h=0;}
        base.totalInput=sum(base.ordinaryInput,base.cacheWrite,base.cacheRead);
    } else if(type==='deepseek') {
        base.totalInput=count(u.prompt_tokens??u.input_tokens);
        const details=u.prompt_tokens_details??u.input_tokens_details??{};
        const hit=count(u.prompt_cache_hit_tokens),cached=count(details.cached_tokens);
        base.cacheRead=hit??cached;
        base.cacheWrite=0; // DeepSeek cache miss uses input-miss price, no separate write bucket.
        base.cacheWrite5m=base.cacheWrite1h=base.cacheWrite30m=base.cacheWrite12h=0;
        if(!equalCount(hit,cached))warnings.push('DeepSeek hit_tokens and cached_tokens disagree; they are aliases and must not be added.');
        const miss=count(u.prompt_cache_miss_tokens);
        base.ordinaryInput=miss??(base.totalInput!==null&&base.cacheRead!==null?base.totalInput-base.cacheRead:null);
        if(base.totalInput===null)base.totalInput=sum(base.ordinaryInput,base.cacheRead);
        if(!equalCount(sum(base.ordinaryInput,base.cacheRead),base.totalInput))warnings.push('DeepSeek hit + miss differs from total input.');
    } else if(/openai|chat-completions|responses/.test(type)) {
        const responses=type.includes('responses')||has(u,'input_tokens');
        const details=(responses?u.input_tokens_details:u.prompt_tokens_details)??{};
        base.totalInput=count(responses?u.input_tokens:u.prompt_tokens);
        base.cacheRead=count(details.cached_tokens??u.cached_tokens);
        // Legacy Chat Completions has no distinct billed-write bucket. New Responses may.
        base.cacheWrite=has(details,'cache_write_tokens')?count(details.cache_write_tokens):responses?null:0;
        const wd=details.cache_write_tokens_details;
        if(wd&&typeof wd==='object') {
            base.cacheWrite30m=count(wd.ttl_30m_tokens);
            base.cacheWrite12h=count(wd.ttl_12h_tokens);
            if(base.cacheWrite===null)base.cacheWrite=sum(base.cacheWrite30m,base.cacheWrite12h);
            if(!equalCount(sum(base.cacheWrite30m,base.cacheWrite12h),base.cacheWrite))warnings.push('OpenAI TTL write components do not sum to cache_write_tokens.');
        } else if(base.cacheWrite===0){base.cacheWrite30m=0;base.cacheWrite12h=0;}
        if(base.cacheWrite===null)warnings.push('Responses cache write count is not reported; ordinary input and billed cost remain unknown.');
        if(base.totalInput!==null&&base.cacheRead!==null&&base.cacheWrite!==null)base.ordinaryInput=base.totalInput-base.cacheRead-base.cacheWrite;
        if(base.cacheRead===null)warnings.push('Cache read count is not reported; do not substitute zero.');
    } else {
        base.totalInput=count(u.input_tokens??u.prompt_tokens);
        warnings.push('Unrecognized usage semantics; configure the actual interface schema before attributing cache charges.');
    }
    for(const key of ['ordinaryInput','cacheWrite','cacheRead','output','totalInput','cacheWrite5m','cacheWrite1h','cacheWrite30m','cacheWrite12h']) {
        if(base[key]!==null&&!validCount(base[key])){warnings.push(`Invalid ${key} count.`);base[key]=null;base.invalid=true;}
    }
    if(warnings.some(w=>/disagree|do not sum|differs from/.test(w)))base.invalid=true;
    base.reported=[base.totalInput,base.output,base.ordinaryInput,base.cacheRead,base.cacheWrite].some(x=>x!==null);
    base.complete=!base.invalid&&[base.ordinaryInput,base.cacheWrite,base.cacheRead,base.output,base.totalInput].every(x=>x!==null);
    base.cacheReadRatio=!base.invalid&&base.totalInput>0&&base.cacheRead!==null?base.cacheRead/base.totalInput:null;
    return base;
}

const rateNumber = x => typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
/** Prices are currency units / million tokens. Missing applicable prices produce unknown cost. */
export function calculateCost(normalized,prices={}) {
    const n=normalized?.ordinaryInput!==undefined?normalized:normalizeUsage(normalized,prices.interfaceType??'auto');
    const rates=prices.rates??prices;
    const currency=typeof prices.currency==='string'&&prices.currency?prices.currency:null;
    const components=[],missing=[];
    const add=(bucket,tokens,rateKey)=>{
        const rate=rateNumber(rates[rateKey]);
        const amount=tokens===0?0:tokens!==null&&rate!==null?tokens*rate/1e6:null;
        if(amount===null)missing.push(tokens===null?`${bucket}:usage`:`${bucket}:price(${rateKey})`);
        components.push({bucket,tokens,rate,rateKey,amount});
    };
    add('ordinaryInput',n.ordinaryInput,'input');
    add('cacheRead',n.cacheRead,'cacheRead');
    if(n.cacheWrite5m!==null&&n.cacheWrite1h!==null&&(n.cacheWrite5m+n.cacheWrite1h)===n.cacheWrite) {
        add('cacheWrite5m',n.cacheWrite5m,'cacheWrite5m');add('cacheWrite1h',n.cacheWrite1h,'cacheWrite1h');
    } else if(n.cacheWrite30m!==null&&n.cacheWrite12h!==null&&(n.cacheWrite30m+n.cacheWrite12h)===n.cacheWrite) {
        add('cacheWrite30m',n.cacheWrite30m,'cacheWrite30m');add('cacheWrite12h',n.cacheWrite12h,'cacheWrite12h');
    } else add('cacheWrite',n.cacheWrite,'cacheWrite');
    add('output',n.output,'output');
    if(!currency)missing.push('currency');
    if(n.invalid)missing.push('invalid-usage');
    const knownSubtotal=components.reduce((s,x)=>s+(x.amount??0),0);
    return {amount:missing.length?null:knownSubtotal,knownSubtotal,currency,source:prices.source??null,updatedAt:prices.updatedAt??null,
        components,missing,complete:missing.length===0,evidence:'calculated-from-provider-usage-and-configured-rates',
        isPlatformBill:false,note:'Configured-rate calculation; reseller markups, tiers and platform adjustments require platform billing evidence.'};
}

/** Grouped ledger keeps body, summary and optimization calls separate; never cross-sums currencies. */
export function summarizeUsage(records=[],priceTable={}) {
    const groups=new Map();
    for(const record of records) {
        const model=record.model??record.body?.model??'unknown';
        const provider=record.provider??record.interfaceType??'unknown';
        const purpose=record.purpose??'unknown';
        const price=record.prices??priceTable[`${provider}:${model}`]??priceTable[model]??{};
        const normalized=record.normalizedUsage??normalizeUsage(record.usage,record.interfaceType??provider);
        const cost=calculateCost(normalized,price);
        const key=JSON.stringify([purpose,provider,model,cost.currency]);
        let group=groups.get(key);
        if(!group){group={key,purpose,provider,model,currency:cost.currency,requests:0,usageRequests:0,pricedRequests:0,
            ordinaryInput:0,cacheWrite:0,cacheRead:0,output:0,totalInput:0,knownCost:0,cost:null,cacheReadRatio:null,
            unknownUsageRequests:0,unknownCostRequests:0,latencyMs:[],platformBills:[]};groups.set(key,group);}
        group.requests++;
        if(normalized.complete){group.usageRequests++;for(const k of ['ordinaryInput','cacheWrite','cacheRead','output','totalInput'])group[k]+=normalized[k];}
        else group.unknownUsageRequests++;
        if(cost.complete){group.pricedRequests++;group.knownCost+=cost.amount;}else group.unknownCostRequests++;
        if(Number.isFinite(record.latencyMs)&&record.latencyMs>=0)group.latencyMs.push(record.latencyMs);
        if(record.platformBill&&Number.isFinite(record.platformBill.amount)&&record.platformBill.currency)group.platformBills.push({...record.platformBill,evidence:'user-imported-platform-bill'});
    }
    for(const group of groups.values()) {
        group.cost=group.unknownCostRequests?null:group.knownCost;
        group.cacheReadRatio=group.totalInput>0?group.cacheRead/group.totalInput:null;
        group.ratioDenominator='cache reads / total input, for requests with complete normalized usage only';
        group.meanLatencyMs=group.latencyMs.length?group.latencyMs.reduce((a,b)=>a+b,0)/group.latencyMs.length:null;
    }
    return [...groups.values()];
}
