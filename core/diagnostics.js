/** Exact, non-normalizing request diagnostics. All text here is data, never code. */
const own = (v, k) => Object.prototype.hasOwnProperty.call(v || {}, k);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const bodyOf = value => value?.body ?? value?.request ?? value?.payload ?? value ?? {};
const json = value => JSON.stringify(value);
const contextKeys = ['tools', 'system', 'messages', 'input', 'prompt', 'instructions'];

export function estimateTokens(text) {
    const bytes = new TextEncoder().encode(String(text ?? '')).length;
    return { value: Math.ceil(bytes / 3), kind: 'estimate', method: 'UTF-8 bytes / 3; not a tokenizer or upper bound', unit: 'tokens' };
}

/** Only model context. Never include transport headers, request IDs or credentials. */
export function projectContext(request) {
    const body = bodyOf(request);
    const result = {};
    for (const key of contextKeys) if (own(body, key)) result[key] = clone(body[key]);
    return result;
}

export function requestGroupKey(record) {
    const body = bodyOf(record);
    // Purpose is not inferred from model names: a DeepSeek request can be main or summary.
    return JSON.stringify([record?.provider ?? record?.interfaceType ?? body.chat_completion_source ?? 'unknown',
        record?.endpoint ?? record?.upstreamOrigin ?? '', record?.path ?? '', record?.interfaceType ?? '', record?.model ?? body.model ?? 'unknown', record?.purpose ?? 'unknown',
        record?.chatId ?? '', record?.observationLevel ?? record?.layer ?? 'frontend']);
}

function stripCache(value) {
    if (Array.isArray(value)) return value.map(stripCache);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'cache_control' && k !== 'prompt_cache_breakpoint').map(([k,v]) => [k,stripCache(v)]));
    return value;
}

/** Segments preserve content exactly; metadata preserves roles, block order and boundaries. */
export function flattenContext(request) {
    const body = bodyOf(request);
    const segments = [];
    const add = (path, text, meta = {}, cacheControl) => segments.push({ path, text: String(text ?? ''), ...meta,
        ...(cacheControl ? { cacheControl: clone(cacheControl) } : {}) });
    const content = (value, path, role, extra = {}) => {
        if (typeof value === 'string') { add(path, value, { role, type: 'string', ...extra }); return; }
        if (Array.isArray(value)) {
            // Empty content still has a meaningful boundary.
            if (!value.length) add(path, '', { role, type: 'empty-array', ...extra });
            value.forEach((block, i) => {
                const p = `${path}[${i}]`;
                if (typeof block === 'string') add(p, block, { role, type: 'string-block', ...extra });
                else if (block && typeof block === 'object') {
                    const key = typeof block.text === 'string' ? 'text' : typeof block.content === 'string' ? 'content' : null;
                    if (key) {
                        const other = { ...block }; delete other[key]; delete other.cache_control; delete other.prompt_cache_breakpoint;
                        add(`${p}.${key}`, block[key], { role, type: block.type ?? 'text', blockMetadata: other, ...extra }, block.cache_control ?? block.prompt_cache_breakpoint);
                    } else add(p, json(stripCache(block)), { role, type: block.type ?? 'object-block', ...extra }, block.cache_control ?? block.prompt_cache_breakpoint);
                } else add(p, json(block), { role, type: 'scalar-block', ...extra });
            });
            return;
        }
        add(path, json(stripCache(value)), { role, type: 'object', ...extra }, value?.cache_control);
    };
    if (own(body, 'tools')) {
        if (Array.isArray(body.tools)) body.tools.forEach((tool,i) => add(`tools[${i}]`,json(stripCache(tool)),{role:'tool-definition',type:'tool'},tool?.cache_control));
        else add('tools',json(stripCache(body.tools)),{role:'tool-definition',type:'tool'});
    }
    if (own(body,'system')) content(body.system,'system','system');
    if (own(body,'instructions')) content(body.instructions,'instructions','system');
    for (const key of ['messages','input']) {
        if (!own(body,key)) continue;
        if (Array.isArray(body[key])) body[key].forEach((message,i) => {
            const path = `${key}[${i}]`;
            if (!message || typeof message !== 'object') { content(message,path,'unknown'); return; }
            const metadata = { ...message }; delete metadata.content; delete metadata.role; delete metadata.cache_control; delete metadata.prompt_cache_breakpoint;
            if (own(message,'content')) content(message.content,`${path}.content`,message.role ?? 'unknown',{messageMetadata:metadata});
            else add(path,json(stripCache(message)),{role:message.role ?? 'unknown',type:message.type ?? 'message-object'});
        });
        else content(body[key],key,'user');
    }
    if (own(body,'prompt')) content(body.prompt,'prompt','prompt');
    return segments;
}

function classifyText(text) {
    const categories = [];
    if (/历史剧情摘要|剧情总结|历史摘要|story\s*summary|previous\s*summary|memory\s*summary/i.test(text)) categories.push('historical-summary');
    if (/记忆系统私密简报|当前状态简报|current\s*(?:status|state)|private\s*briefing/i.test(text)) categories.push('current-briefing');
    if (/status_current_variables|变量快照/i.test(text)) categories.push('variable-snapshot');
    if (/骰池|骰点|dice\s*pool|\bd[12689]\d*\b/i.test(text)) categories.push('dice-pool');
    return categories;
}

/** sources: [{id,type,label,text,entryId,book,adapter,confidence}]. Exact fragments only. */
export function mapSources(request, sources = []) {
    const segments = flattenContext(request);
    return segments.map(segment => {
        const matches = [];
        for (const source of sources) {
            const fragment = source?.text ?? source?.content;
            if (typeof fragment !== 'string' || fragment.length === 0) continue;
            let from = 0, found;
            while ((found = segment.text.indexOf(fragment,from)) !== -1) {
                matches.push({ id: source.id ?? source.entryId ?? null, type: source.type ?? source.kind ?? 'unknown', label: source.label ?? source.name ?? source.id ?? '',
                    book: source.book ?? source.entry?.world ?? null, adapter: source.adapter ?? null, start: found, end: found + fragment.length,
                    confidence: 'exact-text-match', identityConfirmed: source.identityConfirmed === true || source.identityConfidence === 'verified-builtin',
                    note: 'Exact text occurrence; attribution may be ambiguous when multiple sources share text.' });
                from = found + Math.max(fragment.length,1);
                if (matches.length >= 1000) break;
            }
        }
        const heuristics = classifyText(segment.text).map(type => ({ type, confidence: 'heuristic-label', identityConfirmed: false }));
        return { ...segment, sources: matches, heuristics };
    });
}

function escapedWindow(text, offset, radius = 42) {
    if (text === undefined) return null;
    const start = Math.max(0,offset-radius), end = Math.min(text.length,offset+radius);
    return { start, end, escaped: JSON.stringify(text.slice(start,end)).replace(/[\u007f-\u009f\u00a0\u2000-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`) };
}
function pointAt(text, offset) {
    if (text === undefined || offset >= text.length) return { value: null, codePoint: 'END', escaped: '<END>' };
    const n = text.codePointAt(offset), value = String.fromCodePoint(n);
    return { value, codePoint: `U+${n.toString(16).toUpperCase().padStart(4,'0')}`,
        escaped: /^\s$|[\u007f-\u009f\u200b-\u200f\u2060-\u206f\ufeff]$/u.test(value) ? `\\u${n.toString(16).padStart(4,'0')}` : JSON.stringify(value) };
}
function segmentMeta(segment) {
    if (!segment) return null;
    return json({path:segment.path,role:segment.role,type:segment.type,blockMetadata:segment.blockMetadata,messageMetadata:segment.messageMetadata});
}
function cacheSettings(request) {
    const body = bodyOf(request);
    return { topLevel: body.cache_control ?? null, promptCacheKey: body.prompt_cache_key ?? null,
        promptCacheRetention: body.prompt_cache_retention ?? null, promptCacheOptions: body.prompt_cache_options ?? null,
        toolChoice: body.tool_choice ?? null,
        blocks: flattenContext(request).filter(x=>x.cacheControl).map(x=>({path:x.path,cacheControl:x.cacheControl})) };
}
function sourceAt(segment, offset) {
    return segment?.sources?.filter(s=>s.start <= offset && s.end > offset) ?? [];
}
function summaryChanges(before, after, previousSources, currentSources) {
    const findings=[];
    const known = /summary|摘要|memory/i;
    for (const prior of previousSources) {
        if (!known.test(`${prior.type??prior.kind??''} ${prior.label??''} ${prior.id??''}`)) continue;
        const next = currentSources.find(s=>s.id === prior.id && prior.id != null);
        if (!next) continue;
        const a=prior.text??prior.content??'', b=next.text??next.content??'';
        if (a && a === b) {
            const oldPositions = flattenContext(before).filter(s=>s.text.includes(a)).map(s=>s.path);
            const newPositions = flattenContext(after).filter(s=>s.text.includes(b)).map(s=>s.path);
            if(oldPositions.length === 1 && newPositions.length === 1 && oldPositions[0] !== newPositions[0]) findings.push({code:'SUMMARY_POSITION_MOVED',source:prior.id,severity:'notice',from:oldPositions[0],to:newPositions[0],confirmed:true,evidence:'Identified summary source text moved to another message/block; fixed-depth cause remains a hypothesis.'});
        }
        if (a !== b && !b.startsWith(a)) findings.push({code:'SUMMARY_REWRITE',source:prior.id,severity:'notice',evidence:'Same identified summary source changed earlier content.',confirmed:true});
    }
    const aSegments=flattenContext(before), bSegments=flattenContext(after);
    for (const oldSegment of aSegments) {
        if (!classifyText(oldSegment.text).includes('historical-summary')) continue;
        const newSegment=bSegments.find(s=>s.text===oldSegment.text);
        if (newSegment && newSegment.path!==oldSegment.path) findings.push({code:'SUMMARY_POSITION_MOVED',severity:'notice',from:oldSegment.path,to:newSegment.path,
            confirmed:true,evidence:'Exact summary text moved between observed message/block positions; fixed-depth injection is a hypothesis.'});
        if (!newSegment) {
            const atPath=bSegments.find(s=>s.path===oldSegment.path);
            if (atPath && classifyText(atPath.text).includes('historical-summary') && !atPath.text.startsWith(oldSegment.text)) {
                findings.push({code:'SUMMARY_TEXT_CHANGED',severity:'notice',path:oldSegment.path,confirmed:true,
                    evidence:'Summary-labeled content changed. Plugin identity and rewriting mechanism are unconfirmed.'});
            }
        }
    }
    const a=aSegments.map(x=>x.text).join('\n'),b=bSegments.map(x=>x.text).join('\n');
    const dates = text => text.match(/\d+\s*天前|大前天|前天|昨天|今天|明天|上周[一二三四五六日天]|上星期[一二三四五六日天]|\b(?:yesterday|today|tomorrow|\d+ days? ago|last (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\b/gi)??[];
    const ad=dates(a),bd=dates(b);
    if (json(ad)!==json(bd) && ad.length && bd.length) findings.push({code:'RELATIVE_TIME_TEXT_CHANGED',severity:'notice',before:ad.slice(0,30),after:bd.slice(0,30),confirmed:true,
        evidence:'Date wording differs; temporal equivalence is not established and must not be silently rewritten.'});
    return findings;
}

export function analyzePair(previous, current, options = {}) {
    const previousSources = options.previousSources ?? previous?.sources ?? [];
    const currentSources = options.sources ?? current?.sources ?? [];
    const a=mapSources(previous,previousSources), b=mapSources(current,currentSources);
    const comparable = requestGroupKey(previous) === requestGroupKey(current);
    let stable=0,index=0,offset=0,kind=null;
    for (;index<Math.min(a.length,b.length);index++) {
        if (segmentMeta(a[index]) !== segmentMeta(b[index])) {kind='structure';offset=0;break;}
        const x=a[index].text,y=b[index].text;
        for(offset=0;offset<Math.min(x.length,y.length)&&x[offset]===y[offset];offset++);
        stable+=offset;
        if(offset!==x.length||offset!==y.length){kind='content';break;}
    }
    const equal=kind===null&&a.length===b.length;
    const appendOnly=kind===null&&b.length>a.length;
    if(kind===null&&!equal){kind=appendOnly?'append':'removal';offset=0;}
    const first=equal?null:{kind,segmentIndex:index,previousPath:a[index]?.path??null,currentPath:b[index]?.path??null,
        offset:kind==='structure'?0:offset,indexUnit:'UTF-16 code units; no whitespace or Unicode normalization',
        previousCharacter:pointAt(a[index]?.text,kind==='structure'?0:offset),currentCharacter:pointAt(b[index]?.text,kind==='structure'?0:offset),
        previousExcerpt:escapedWindow(a[index]?.text,kind==='structure'?0:offset),currentExcerpt:escapedWindow(b[index]?.text,kind==='structure'?0:offset),
        previousSources:sourceAt(a[index],offset),sources:sourceAt(b[index],offset),heuristics:b[index]?.heuristics??a[index]?.heuristics??[]};
    const settingsBefore=cacheSettings(previous), settingsAfter=cacheSettings(current);
    const configurationKeys = ['thinking','output_config','output_format','reasoning','reasoning_effort','response_format','json_schema','context_management','previous_response_id','conversation','truncation','parallel_tool_calls','modalities','audio','function_call'];
    const configChanges = configurationKeys.filter(key=>json(bodyOf(previous)[key])!==json(bodyOf(current)[key])).map(key=>({key,before:clone(bodyOf(previous)[key])??null,after:clone(bodyOf(current)[key])??null,evidence:'observed-request-field',cacheImpact:'provider-and-model-dependent; not proof of cache invalidation'}));
    let end=0;
    const breakpoints=a.map((s,i)=>{end+=s.text.length;return {path:s.path,segmentIndex:i,characterEnd:end,cacheControl:s.cacheControl};})
        .filter(s=>s.cacheControl).map(bp=>({...bp,prefixUnchanged:bp.segmentIndex<index||(equal&&bp.segmentIndex===index),
            stillConfigured:settingsAfter.blocks.some(x=>x.path===bp.path&&json(x.cacheControl)===json(bp.cacheControl)),
            serverHitConfirmed:false,note:'Matching local prefix and cache parameter only; server eligibility, TTL and actual reads require provider evidence.'}));
    const findings=summaryChanges(previous,current,previousSources,currentSources);
    if(configChanges.length)findings.push({code:'REQUEST_CONFIGURATION_CHANGED',severity:'notice',confirmed:true,fields:configChanges.map(x=>x.key),evidence:'Model-facing configuration changed. Actual cache impact depends on interface/model rules; this is not transport-header evidence.'});
    if(!comparable)findings.unshift({code:'INCOMPARABLE_REQUEST_GROUP',severity:'warning',confirmed:true,evidence:'Provider/endpoint/model/purpose/chat/observation layer differ. Do not attribute differences to one cache.'});
    if(first&&first.kind!=='append')findings.push({code:'CONTEXT_PREFIX_CHANGED',severity:'notice',confirmed:true,evidence:'The observed model context differs at the reported boundary; not proof of the unique cache-miss cause.'});
    if(breakpoints.some(x=>x.prefixUnchanged&&x.stillConfigured)&&!equal&&!appendOnly)findings.push({code:'STABLE_EXPLICIT_BREAKPOINT',severity:'info',confirmed:true,
        evidence:'At least one explicit breakpoint remains before the first observed change. Later dynamic content need not invalidate that earlier prefix.'});
    return { comparable,equal,appendOnly,firstDifference:first,stablePrefixCharacters:stable,
        stablePrefix:{characters:stable,unit:'UTF-16 code units of content; boundaries and roles checked separately',tokens:estimateTokens(a.slice(0,index).map(s=>s.text).join('')+(a[index]?.text.slice(0,offset)??'')),evidence:'local-comparison',serverHitConfirmed:false},
        previousCharacters:a.reduce((n,s)=>n+s.text.length,0),currentCharacters:b.reduce((n,s)=>n+s.text.length,0),
        requestConfigurationChanges:configChanges,cacheParametersChanged:json(settingsBefore)!==json(settingsAfter),cacheSettings:{before:settingsBefore,after:settingsAfter},breakpoints,findings,
        observationLevel:current?.observationLevel??current?.layer??'frontend',
        visibility:['server','server-relay'].includes(current?.observationLevel??current?.layer)?'Observed SillyTavern outgoing request; intermediary transformations remain invisible.':'仅观察到前端请求；服务端转换和中转站内部路由不可见。' };
}

export function diagnoseDuplicates(request, { minChars = 40, sources = [] } = {}) {
    const segments=flattenContext(request),groups=new Map();
    for(const s of segments){if(s.text.length<minChars)continue;const list=groups.get(s.text)??[];list.push({path:s.path,start:0,end:s.text.length});groups.set(s.text,list);}
    const findings=[];
    for(const [text,locations] of groups)if(locations.length>1)findings.push({code:'EXACT_DUPLICATE_BLOCK',text,characters:text.length,locations,confirmed:true,
        safeToRemove:false,note:'Exact repeated content; intentional role/scope differences must be reviewed before removal.'});
    for(const source of sources){const text=source.text??source.content;if(typeof text!=='string'||text.length<minChars)continue;const locations=[];
        for(const s of segments){let start=0,i;while((i=s.text.indexOf(text,start))!==-1){locations.push({path:s.path,start:i,end:i+text.length});start=i+text.length;if(locations.length>=1000)break;}}
        if(locations.length>1&&!findings.some(f=>f.text===text))findings.push({code:'EXACT_DUPLICATE_SOURCE',source:source.id??null,text,characters:text.length,locations,confirmed:true,safeToRemove:false});
    }
    return findings;
}

function entriesOf(book){const e=book?.entries??book?.data?.entries??[];return Array.isArray(e)?e:Object.values(e);}
function quantity(value,kind,method){return {value:Number.isFinite(value)&&value>=0?value:null,kind:value==null?'unknown':kind,unit:'tokens',method};}

/** Do not confuse an entire book with activated content or final wire input. */
export function diagnoseWorldInfo({books,entries,activeEntries,budgetTokens=null,sentTokens=null,tokenCounter,maxInputTokens=null}={}){
    const all=entries??(Array.isArray(books)?books.flatMap(entriesOf):undefined);
    const count = values => {
        if(!Array.isArray(values))return quantity(null,'unknown','not observed');
        let total=0,exact=true;
        for(const e of values){const t=e?.content??e?.text??'';
            if(typeof tokenCounter==='function'){const result=tokenCounter(t);if(Number.isFinite(result))total+=result;else if(Number.isFinite(result?.value)){total+=result.value;exact=exact&&result.kind==='exact';}else {total+=estimateTokens(t).value;exact=false;}}
            else {total+=estimateTokens(t).value;exact=false;}}
        return quantity(total,exact?'exact':'estimate',exact?'configured tokenizer; fragments counted independently':'UTF-8 bytes / 3; fragments counted independently');
    };
    const wholeBook=count(all),activated=count(activeEntries);
    const finalSent = typeof sentTokens==='object'&&sentTokens!==null?{...sentTokens,unit:'tokens'}:quantity(sentTokens,sentTokens===null?'unknown':'reported','whole request provider usage or explicitly supplied count; includes non-world content');
    const budget=quantity(budgetTokens,'configured-limit','world info allocation, not measured usage');
    const findings=[];
    if(wholeBook.value>=1500000)findings.push({code:'LARGE_BOOK_TOTAL',severity:'warning',evidence:'Entire-book total is at least 1,500,000 tokens; this alone does not prove that many were sent.'});
    if(activated.value!==null&&budgetTokens!==null&&activated.value>budgetTokens)findings.push({code:'ACTIVATED_OVER_BUDGET',severity:'warning',evidence:'Observed/estimated activated content exceeds configured WI budget; inspect ignoreBudget and actual inclusion.'});
    if(maxInputTokens!==null&&finalSent.value!==null&&finalSent.value>maxInputTokens)findings.push({code:'SENT_INPUT_OVER_LIMIT',severity:'error',evidence:'Final input count exceeds user input limit.'});
    if(maxInputTokens!==null&&activated.value!==null&&activated.value>maxInputTokens)findings.push({code:'ACTIVATED_INPUT_OVER_LIMIT',severity:'error',evidence:'Activated-content count exceeds user limit before other prompt content.'});
    return {wholeBook,budget,activated,finalSent,quantities:{wholeBook,budget,activated,finalSent},entryCount:Array.isArray(all)?all.length:null,activeEntryCount:Array.isArray(activeEntries)?activeEntries.length:null,
        fields:(all??[]).map(e=>({id:e.uid??e.id??null,book:e.world??e.book??null,name:e.comment??e.name??'',constant:e.constant??null,selective:e.selective??null,
            vectorized:e.vectorized??null,key:clone(e.key??[]),keysecondary:clone(e.keysecondary??[]),disable:e.disable??null,
            excludeRecursion:e.excludeRecursion??null,preventRecursion:e.preventRecursion??null,delayUntilRecursion:e.delayUntilRecursion??null,
            scanDepth:e.scanDepth??null,useProbability:e.useProbability??null,probability:e.probability??null,group:e.group??null,
            groupOverride:e.groupOverride??null,groupWeight:e.groupWeight??null,ignoreBudget:e.ignoreBudget??null,position:e.position??null,depth:e.depth??null,
            order:e.order??null,role:e.role??null,sticky:e.sticky??null,cooldown:e.cooldown??null,delay:e.delay??null})),findings};
}
