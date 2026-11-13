/** Batch local setup analysis. Narrative text is data; this module never writes or sends requests. */
import { analyzePair, diagnoseDuplicates, estimateTokens, flattenContext, requestGroupKey } from './diagnostics.js';
import { normalizeUsage } from './usage.js';

const clone = v => v === undefined ? undefined : structuredClone(v);
const arr = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const textOf = value => typeof value?.content === 'string' ? value.content : typeof value?.text === 'string' ? value.text : '';
const quantity = (value,kind='estimate',method='UTF-8 bytes / 3; estimate, not a tokenizer or hard upper bound') => ({value:finite(value)?value:null,kind:finite(value)?kind:'unknown',unit:'tokens',method});
const knownPurpose = value => ['main','summary','agent'].includes(value)?value:'unknown';
const protocol = value => ['anthropic','openai','openai-chat','openai-responses','deepseek'].includes(value)?value:'unknown';
const sourceId = source => String(source?.id ?? source?.entryId ?? '');
const protectedDynamicText = text => /\{\{|status_current_variables|记忆系统私密简报|当前状态简报|骰池|dice\s*pool/i.test(text);
const entryNativeKey = (book,uid) => JSON.stringify([String(book??''),String(uid??'')]);
const hasBody = record => !!record?.body && ['messages','system','tools','input','instructions','prompt'].some(k=>Object.hasOwn(record.body,k));
const isWorld = source => ['world-info','world_info','worldbook'].includes(source?.kind??source?.type);
const entrySettings = entry => Object.fromEntries(['constant','vectorized','disable','position','depth','role','order','scanDepth','ignoreBudget','selective','selectiveLogic','useProbability','probability','excludeRecursion','preventRecursion','delayUntilRecursion','groupOverride','groupWeight','useGroupScoring','sticky','cooldown','delay'].filter(k=>typeof entry[k]==='boolean'||finite(entry[k])).map(k=>[k,entry[k]]));
const scopeOf = entry => JSON.stringify([entry.position??null,entry.depth??null,entry.role??null]);
function tokenSum(entries){return entries.reduce((n,e)=>n+estimateTokens(textOf(e)).value,0);}
function configBudget(settings,snapshot,limits){
    const percent=settings?.world_info_budget??settings?.budgetPercent??null;
    const cap=settings?.world_info_budget_cap??settings?.budgetCap??null;
    const context=limits.contextTokens;
    const derived=finite(percent)&&finite(context)&&context>0?Math.floor(context*percent/100):null;
    const configured=derived!==null?(finite(cap)&&cap>0?Math.min(derived,cap):derived):finite(cap)&&cap>0?cap:null;
    return {configuredPercent:finite(percent)?percent:null,configuredTokenCap:finite(cap)?cap:null,
        derivedLimit:quantity(configured,'configured-limit','Derived from configured context × WI percentage and positive token cap; not actual usage.'),
        observedScanLimit:quantity(snapshot?.budgetTokens,'observed-limit','Last captured WI scan budget, possibly a dry run; not actual included tokens.')};
}
function triggerMode(entry){
    if(entry.disable===true)return 'disabled';
    if(entry.constant===true)return 'constant';
    if(entry.vectorized===true)return 'vector';
    if(arr(entry.key).length || arr(entry.keysecondary).length)return 'keyword';
    return 'conditional-or-unknown';
}
function safeGlobalSettings(settings){
    const keys=['world_info_depth','world_info_budget','world_info_budget_cap','world_info_recursive','world_info_min_activations','world_info_min_activations_depth_max','world_info_max_recursion_steps','world_info_case_sensitive','world_info_match_whole_words','world_info_character_strategy','world_info_use_group_scoring'];
    return Object.fromEntries(keys.filter(k=>typeof settings?.[k]==='boolean'||finite(settings?.[k])).map(k=>[k,settings[k]]));
}
function numericImpact(finding){
    const result={};for(const [k,v]of Object.entries(finding))if(finite(v)||typeof v==='boolean')result[k]=v;return result;
}

/**
 * Canonical setup comes from the read-only ST collector. Missing evidence remains unknown.
 * Output is local; only agentDigest is intended for external optimization-model input.
 */
export function analyzeSetup(setup={}, {records=[],limits={}}={}) {
    const maxRecords=Number.isSafeInteger(limits.maxAnalysisRecords)&&limits.maxAnalysisRecords>0?Math.min(limits.maxAnalysisRecords,100):12;
    const maxSources=Number.isSafeInteger(limits.maxAnalysisSourcesPerRecord)&&limits.maxAnalysisSourcesPerRecord>0?Math.min(limits.maxAnalysisSourcesPerRecord,2000):400;
    const digestLimit=Number.isSafeInteger(limits.maxDigestEntries)&&limits.maxDigestEntries>0?Math.min(limits.maxDigestEntries,1000):60;
    const digestByteLimit=Number.isSafeInteger(limits.maxDigestBytes)&&limits.maxDigestBytes>=4096?Math.min(limits.maxDigestBytes,20000):14000;
    const findings=[],warnings=[],actions=[];
    const add=(code,severity,targets,evidence,extra={})=>{const f={code,severity,targets:[...new Set(targets)],evidence,...extra};findings.push(f);return f;};
    const bookInput=arr(setup.books??setup.boundBooks),bookRows=[],entries=[],nativeToRef=new Map(),sourceToRef=new Map();
    const duplicateConfig=new Map(),orderGroups=new Map();
    const globalSettings=setup.worldSettings??setup.globalSettings??{};
    const budget=configBudget(globalSettings,setup.snapshot,limits);
    const positionSemanticsKnown=setup.compatibility?.verifiedSource===true&&setup.compatibility?.version==='1.19.0';
    let totalCharacters=0,wholeEstimate=0,missingBooks=0;
    for(const [bi,book]of bookInput.entries()){
        const bookRef=`b${bi+1}`,items=arr(book.entries??book.data?.entries),loaded=book.loaded!==false&&Array.isArray(book.entries??book.data?.entries) || book.loaded!==false&&!!(book.entries??book.data?.entries)&&typeof(book.entries??book.data?.entries)==='object';
        if(!loaded)missingBooks++;
        const counts={entries:items.length,enabled:0,disabled:0,constant:0,keyword:0,vector:0,conditionalOrUnknown:0,ignoreBudget:0,macrosOrState:0};
        let estimate=0,constantEstimate=0;
        for(const [ei,entry]of items.entries()){
            const ref=`${bookRef}:e${ei+1}`,text=textOf(entry),mode=triggerMode(entry),tokens=estimateTokens(text).value;
            estimate+=tokens;wholeEstimate+=tokens;totalCharacters+=text.length;
            counts[mode==='conditional-or-unknown'?'conditionalOrUnknown':mode]++;
            if(mode!=='disabled')counts.enabled++;
            if(entry.ignoreBudget===true&&mode!=='disabled')counts.ignoreBudget++;
            if(entry.constant===true&&mode!=='disabled')constantEstimate+=tokens;
            const dynamicSyntax=protectedDynamicText(text);if(dynamicSyntax)counts.macrosOrState++;
            const row={ref,bookRef,uid:entry.uid??entry.id??book.entryKeys?.[ei]??ei,name:entry.comment??entry.name??'',bookName:book.name??'',
                triggerMode:mode,configuredConstant:entry.constant===true,enabled:mode!=='disabled',settings:entrySettings(entry),keywordCount:arr(entry.key).length,secondaryKeywordCount:arr(entry.keysecondary).length,
                hasGroup:typeof entry.group==='string'&&!!entry.group,estimatedTokens:quantity(tokens),characters:text.length,
                hasMacroOrDynamicSyntax:dynamicSyntax,stabilityCandidate:mode==='constant'&&!dynamicSyntax&&(entry.useProbability!==true||entry.probability===100),
                observedStable:false,stable:false,observations:0,sourceCoverage:'not-yet-observed',triggerScope:scopeOf(entry)};
            entries.push(row);nativeToRef.set(entryNativeKey(book.name, row.uid),ref);sourceToRef.set(`world:${book.name}:${row.uid}`,ref);
            if(text.length>=40){const refs=duplicateConfig.get(text)||[];refs.push(ref);duplicateConfig.set(text,refs);}
            if(mode!=='disabled'&&finite(entry.order)){const key=JSON.stringify([scopeOf(entry),entry.order]);const refs=orderGroups.get(key)||[];refs.push(ref);orderGroups.set(key,refs);}
        }
        bookRows.push({ref:bookRef,name:book.name??'',boundBy:arr(book.boundBy).filter(x=>['global','character-primary','character-extra','chat','persona'].includes(x)),loaded:!!loaded,counts,
            wholeBook:loaded?quantity(estimate):quantity(null),constantVolume:loaded?quantity(constantEstimate):quantity(null),
            scope:'All entries in this bound book, including disabled entries; not the sent prompt.'});
    }
    const rowByRef=new Map(entries.map(row=>[row.ref,row]));
    const refForSource=source=>{
        const byId=sourceToRef.get(sourceId(source));if(byId)return byId;
        if(isWorld(source)){const e=source.entry??source;return nativeToRef.get(entryNativeKey(e.world??source.book,e.uid??source.entryId));}
        return null;
    };
    const activeRef=entry=>nativeToRef.get(entryNativeKey(entry.world??entry.book,entry.uid??entry.id));
    const constantRows=entries.filter(e=>e.enabled&&e.configuredConstant),ignoreRows=entries.filter(e=>e.enabled&&e.settings.ignoreBudget===true);
    const constantVolume=constantRows.reduce((n,e)=>n+e.estimatedTokens.value,0);
    if(wholeEstimate>=1500000)add('WHOLE_BOOK_VOLUME_1500000','warning',bookRows.map(b=>b.ref),'Whole-book estimate reaches 1,500,000 tokens; this is inventory size, not evidence that all entries were sent.',{estimatedTokens:wholeEstimate});
    if(finite(limits.maxInputTokens)&&wholeEstimate>limits.maxInputTokens)add('WHOLE_BOOK_LARGER_THAN_INPUT_LIMIT','info',bookRows.map(b=>b.ref),'Bound-book inventory exceeds the per-request limit. On-demand activation remains necessary; this alone does not forbid safe bounded requests.',{estimatedTokens:wholeEstimate});
    const constantThreshold=budget.derivedLimit.value??(finite(limits.maxInputTokens)?limits.maxInputTokens:null);
    if(constantThreshold!==null&&constantVolume>constantThreshold || constantRows.length>=20&&constantRows.length>=entries.filter(e=>e.enabled).length*.5)
        add('LARGE_CONSTANT_SET','warning',constantRows.map(e=>e.ref),'Configured constant material is large. Historical constant-flag inflation is not established without an earlier settings snapshot.',{entries:constantRows.length,estimatedTokens:constantVolume,historicalInflationConfirmed:false});
    if(ignoreRows.length)add('BUDGET_BYPASS_ENABLED','warning',ignoreRows.map(e=>e.ref),'Enabled entries bypass the WI budget. Actual inclusion and full-request input still require observation.',{entries:ignoreRows.length});
    const early=entries.filter(e=>e.enabled&&!e.configuredConstant&&e.settings.position===0);
    if(early.length)add(positionSemanticsKnown?'DYNAMIC_BEFORE_CHARACTER':'DYNAMIC_POSITION_ZERO','notice',early.map(e=>e.ref),positionSemanticsKnown?'Conditional material is configured before character content; actual preset placement and message scope determine prefix impact.':'Conditional entries use position 0; placement semantics need the actual supported ST version.',{placementConfirmedByVersion:positionSemanticsKnown});
    const sharedOrders=[];
    for(const [key,refs]of orderGroups)if(refs.length>1){const [scope,order]=JSON.parse(key);sharedOrders.push({scope,order,refs});}
    if(sharedOrders.length)add('SHARED_INSERTION_ORDER','info',sharedOrders.flatMap(g=>g.refs),'Several enabled entries share an insertion order within configured scopes. Equal order is not evidence of random or nondeterministic ordering.',{groups:sharedOrders.length,nondeterminismConfirmed:false});
    let duplicateGroups=[...duplicateConfig.entries()].filter(([,refs])=>refs.length>1).map(([text,refs])=>({refs,characters:text.length,estimatedTokens:estimateTokens(text),injectionConfirmed:false,automaticRemovalAllowed:false}));

    const presetInput=setup.preset??{},prompts=arr(presetInput.prompts),order=arr(presetInput.order??presetInput.prompt_order),orderKnown=Array.isArray(presetInput.order);
    const presetRows=prompts.map((p,i)=>{const selected=order.find(o=>o.identifier===p.identifier),ref=`p${i+1}`,text=textOf(p);sourceToRef.set(`preset:${p.identifier}`,ref);
        if(text.length>=40){const refs=duplicateConfig.get(text)||[];refs.push(ref);duplicateConfig.set(text,refs);}
        return {ref,identifier:p.identifier??null,name:p.name??'',enabled:orderKnown?selected?.enabled===true:typeof p.enabled==='boolean'?p.enabled:null,
            marker:p.marker===true,role:p.role??null,position:p.injection_position??p.position??null,depth:p.injection_depth??p.depth??null,order:p.injection_order??null,
            orderIndex:selected?order.indexOf(selected):null,characters:text.length,estimatedTokens:estimateTokens(text),hasMacroOrDynamicSyntax:protectedDynamicText(text)};});
    const extensionInput=arr(setup.extensionSources??setup.sources??setup.extensionPrompts),extensionRows=extensionInput.map((source,i)=>{
        const ref=`x${i+1}`;sourceToRef.set(sourceId(source),ref);
        if(source.key)sourceToRef.set(`extension:${source.key}`,ref);
        const kind=source.kind??source.type??(source.adapter==='builtin-memory'?'history-summary':'unknown-extension');
        return {ref,id:source.id??null,name:source.name??source.key??'',kind,adapter:source.adapter??null,access:'read-only',
            knownAdapter:source.adapter==='builtin-memory'||source.identityConfidence==='verified-builtin',role:source.role??null,position:source.position??null,depth:source.depth??null,
            characters:textOf(source).length,estimatedTokens:estimateTokens(textOf(source)),hasMacroOrDynamicSyntax:protectedDynamicText(textOf(source))};});
    duplicateGroups=[...duplicateConfig.entries()].filter(([,refs])=>refs.length>1).map(([text,refs])=>({refs,characters:text.length,estimatedTokens:estimateTokens(text),injectionConfirmed:false,automaticRemovalAllowed:false}));
    if(duplicateGroups.length)add('EXACT_TEXT_REPEATED_IN_CONFIG','notice',duplicateGroups.flatMap(g=>g.refs),'Exact full text occurs in multiple configuration entries or presets. Intentional duplication or mutually exclusive activation is possible; this is not yet duplicate injection.',{groups:duplicateGroups.length});
    if(extensionRows.some(s=>!s.knownAdapter))add('UNKNOWN_EXTENSIONS_READ_ONLY','info',extensionRows.filter(s=>!s.knownAdapter).map(s=>s.ref),'Unknown extension implementations remain read-only. Similar wording is not proof of shared origin or duplicate injection.');
    if(!orderKnown)add('PRESET_ORDER_UNKNOWN','warning',presetRows.map(p=>p.ref),'Current selected preset order was not collected; do not move content across unknown roles or scopes.');

    const chosen=arr(records).slice(-maxRecords),recordTruncated=records.length>chosen.length;
    let sourceTruncated=false;
    const groupMap=new Map(),requestRows=[],observationMap=new Map();
    const summarizeSources=record=>{
        const all=arr(record.sources);if(all.length>maxSources)sourceTruncated=true;
        const prioritized=[...all.filter(s=>(s.kind??s.type)!=='history'),...all.filter(s=>(s.kind??s.type)==='history')];
        return prioritized.slice(0,maxSources).map(s=>({...s,type:s.type??s.kind,label:s.label??s.name??s.id,text:s.text??s.content}));
    };
    for(const [ri,raw]of chosen.entries()){
        const record={...raw,sources:summarizeSources(raw)},ref=`r${ri+1}`,key=requestGroupKey(record),segments=hasBody(record)?flattenContext(record):[];
        let group=groupMap.get(key);if(!group){group={ref:`g${groupMap.size+1}`,chatId:record.chatId??'',provider:record.provider??'unknown',model:record.model??record.body?.model??'unknown',purpose:knownPurpose(record.purpose),interfaceType:record.interfaceType??'unknown',observationLevel:record.observationLevel??'unknown',requests:[],comparisons:[]};groupMap.set(key,group);}
        const normalized=normalizeUsage(record.usage,record.interfaceType??record.provider);
        const activeKnown=record.world?.activationEventSeen===true||arr(record.world?.activeEntries).length>0;
        const active=activeKnown?arr(record.world.activeEntries):null;
        const activeRefs=active?[...new Set(active.map(activeRef).filter(Boolean))]:null;
        const occurrences=[];
        for(const source of record.sources){const text=textOf(source);if(!text)continue;const target=refForSource(source)??sourceToRef.get(sourceId(source));
            const locations=[];for(const [si,segment]of segments.entries()){const start=segment.text.indexOf(text);if(start>=0)locations.push({segmentIndex:si,path:segment.path,role:segment.role,start,end:start+text.length,ambiguous:segment.text.indexOf(text,start+text.length)>=0});}
            if(target&&locations.length){for(const loc of locations)occurrences.push({ref:target,...loc});
                const obsKey=JSON.stringify([group.ref,target]);const history=observationMap.get(obsKey)||[];history.push({recordRef:ref,text,locations,settings:{role:source.role??null,position:source.position??null,depth:source.depth??null},configuredConstant:source.entry?.constant===true,foundExactlyOnce:locations.length===1&&!locations[0].ambiguous});observationMap.set(obsKey,history);}
        }
        occurrences.sort((a,b)=>a.segmentIndex-b.segmentIndex||a.start-b.start);
        const current={ref,id:record.id??null,groupRef:group.ref,status:record.status??'unknown',startedAt:record.startedAt??record.time??null,
            activeEntries:active?{known:true,count:active.length,refs:activeRefs,unmappedEntries:active.length-active.filter(e=>activeRef(e)).length,estimatedTokens:quantity(tokenSum(active)),evidence:'activation-event; may include dry-run or later-excluded material'}:{known:false,count:null,refs:null,estimatedTokens:quantity(null)},
            budget:quantity(record.world?.budgetTokens,'observed-limit','Captured scan budget, not sent tokens'),
            finalInput:quantity(normalized.totalInput,'provider-usage','Whole-request input reported by usage, including non-world content'),worldInfoFinalSentTokens:null,
            cacheRead:normalized.cacheRead,cacheWrite:normalized.cacheWrite,cacheReadRatio:normalized.cacheReadRatio,usageComplete:normalized.complete,
            exactSourceOccurrences:occurrences.map(o=>({...o})),sourceCoverage:record.sources.length?'recorded-sources-only':'no-recorded-source-map',bodyObserved:hasBody(record),
            observationLevel:record.observationLevel??'unknown',serverRoutingVisible:false};
        if(finite(limits.maxInputTokens)&&normalized.totalInput!==null&&normalized.totalInput>limits.maxInputTokens)add('REPORTED_INPUT_OVER_USER_LIMIT','error',[ref],'Provider usage reports total input above the configured per-request limit.',{inputTokens:normalized.totalInput});
        const previous=group.requests.at(-1);
        if(previous&&hasBody(previous._record)&&hasBody(record)){
            const diff=analyzePair(previous._record,record,{sources:record.sources,previousSources:previous._record.sources});
            const mapMatch=s=>({ref:refForSource(s)??sourceToRef.get(sourceId(s))??null,kind:s.type??'unknown',confidence:s.confidence??'unknown',identityConfirmed:s.identityConfirmed===true});
            const first=diff.firstDifference;
            const comparison={previous:previous.ref,current:ref,previousStatus:previous.status,currentStatus:current.status,
                includesFailedRequest:[previous.status,current.status].some(s=>['http-error','request-error','failed','observation-error'].includes(s)),
                stablePrefixCharacters:diff.stablePrefixCharacters,stablePrefixUnit:'UTF-16 code units; roles and block boundaries checked separately',appendOnly:diff.appendOnly,
                firstDifference:first?{kind:first.kind,path:first.currentPath??first.previousPath,offset:first.offset,previousSources:first.previousSources.map(mapMatch),sources:first.sources.map(mapMatch)}:null,
                flags:diff.findings.map(f=>({code:f.code,severity:f.severity,evidence:f.code==='SUMMARY_REWRITE'?'Source snapshot changed non-append-only; actual injection and semantic rewriting need separate verification.':f.code==='RELATIVE_TIME_TEXT_CHANGED'?'Time-word lists differ somewhere in the request; same-event date equivalence is not established.':f.evidence})),
                cacheParametersChanged:diff.cacheParametersChanged,stableObservedBreakpoints:diff.breakpoints.filter(bp=>bp.prefixUnchanged&&bp.stillConfigured).length,
                actualCacheRead:normalized.cacheRead,cacheCauseEstablished:false};
            if(previous.activeEntries.known&&current.activeEntries.known){const a=new Set(previous.activeEntries.refs),b=new Set(current.activeEntries.refs);
                comparison.activationChange={entered:[...b].filter(x=>!a.has(x)),exited:[...a].filter(x=>!b.has(x)),unmapped:previous.activeEntries.unmappedEntries+current.activeEntries.unmappedEntries};
                if(comparison.activationChange.entered.length||comparison.activationChange.exited.length)add('ACTIVATION_SET_CHANGED','notice',[...comparison.activationChange.entered,...comparison.activationChange.exited],'Observed activation-event membership changed. This does not prove entries were deleted or sorting became nondeterministic.',{previous:previous.ref,current:ref});
            }
            const prevOrder=previous.exactSourceOccurrences.filter(o=>rowByRef.has(o.ref)).map(o=>o.ref),nowOrder=occurrences.filter(o=>rowByRef.has(o.ref)).map(o=>o.ref);
            if(prevOrder.length>1&&new Set(prevOrder).size===prevOrder.length&&new Set(nowOrder).size===nowOrder.length&&JSON.stringify([...prevOrder].sort())===JSON.stringify([...nowOrder].sort())&&JSON.stringify(prevOrder)!==JSON.stringify(nowOrder))
                add('OBSERVED_ENTRY_ORDER_CHANGED','notice',nowOrder,'The same uniquely matched world entries appear in a different observed order. The cause may be deterministic settings or scope changes; randomness is not established.',{previous:previous.ref,current:ref,nondeterminismConfirmed:false});
            const firstRefs=[...(comparison.firstDifference?.previousSources??[]),...(comparison.firstDifference?.sources??[])].map(s=>s.ref).filter(Boolean);
            if(firstRefs.some(r=>rowByRef.has(r)&&!rowByRef.get(r).configuredConstant))add('DYNAMIC_WORLD_SOURCE_AT_EARLIEST_DIFF','notice',firstRefs,'The earliest observed difference overlaps exact-matched conditional world-source text. This is a local prefix change, not a proven unique cause of cache misses.',{previous:previous.ref,current:ref});
            group.comparisons.push(comparison);
        }
        if(segments.length){const duplicates=diagnoseDuplicates(record,{minChars:40,sources:record.sources});
            current.duplicateInjections=duplicates.map(d=>({code:d.code,characters:d.characters,occurrences:d.locations.length,paths:d.locations.map(l=>l.path),sourceRef:d.source?sourceToRef.get(d.source)??null:null,exactTextRepeated:true,automaticRemovalAllowed:false}));
            if(current.duplicateInjections.length)add('EXACT_REPEATED_REQUEST_TEXT','notice',[ref],'Exact text is repeated in the observed request. Roles and intended scope must be reviewed before removing any occurrence.',{groups:current.duplicateInjections.length});}
        current._record=record;group.requests.push(current);requestRows.push(current);
    }
    for(const [key,history]of observationMap){const [groupRef,target]=JSON.parse(key);if(history.length<2)continue;
        const group=[...groupMap.values()].find(g=>g.ref===groupRef);
        const contentStable=history.every(h=>h.text===history[0].text),scopeStable=history.every(h=>JSON.stringify(h.locations.map(l=>({path:l.path,role:l.role})))===JSON.stringify(history[0].locations.map(l=>({path:l.path,role:l.role})))&&JSON.stringify(h.settings)===JSON.stringify(history[0].settings));
        const exact=history.every(h=>h.foundExactlyOnce),binding=setup.binding;
        const boundGroup=!!binding&&['chatId','model','provider','purpose'].every(k=>binding[k]!==undefined&&String(binding[k])===String(group[k]));
        const row=rowByRef.get(target);if(row){row.observations+=history.length;row.sourceCoverage='exact-text-match-to-recorded-source';
            (row.stabilityByGroup??=[]).push({groupRef,observations:history.length,contentStable,scopeStable,exact,boundGroup,constantConfigurationObserved:history.every(h=>h.configuredConstant)});
            if(boundGroup){const checks=row.stabilityByGroup.filter(c=>c.boundGroup);row.observedStable=checks.every(c=>c.contentStable&&c.scopeStable&&c.exact);row.stable=row.stabilityCandidate&&row.observedStable&&checks.every(c=>c.constantConfigurationObserved);}}
        if(!scopeStable)add('SOURCE_SCOPE_CHANGED','notice',[target],'A matched source changed observed message position, role, injection depth or scope. Automatic cross-scope movement is not authorized.',{group:groupRef});
        if(!contentStable)add('OBSERVED_SOURCE_TEXT_CHANGED','notice',[target],'The same source identity had different observed text. This alone does not establish why it changed or whether its facts were altered.',{group:groupRef});
    }
    const requestGroups=[...groupMap.values()].map(group=>({...group,requests:group.requests.map(({_record,...r})=>r)}));
    const expectedBooks=Number.isSafeInteger(setup.counts?.booksExpected)?setup.counts.booksExpected:bookRows.length;
    missingBooks+=Math.max(0,expectedBooks-bookRows.length);
    const allKnown=bookInput.length===0?setup.complete===true&&expectedBooks===0:missingBooks===0;
    const counts={books:bookRows.length,booksExpected:expectedBooks,loadedBooks:bookRows.filter(b=>b.loaded).length,entries:entries.length,enabled:entries.filter(e=>e.enabled).length,disabled:entries.filter(e=>!e.enabled).length,
        constant:entries.filter(e=>e.triggerMode==='constant').length,keyword:entries.filter(e=>e.triggerMode==='keyword').length,vector:entries.filter(e=>e.triggerMode==='vector').length,conditionalOrUnknown:entries.filter(e=>e.triggerMode==='conditional-or-unknown').length,
        ignoreBudget:ignoreRows.length,presetPrompts:presetRows.length,extensionSources:extensionRows.length,observedRequestGroups:requestGroups.length,observedRequests:chosen.length};
    const complete=setup.complete===true&&setup.truncated!==true&&setup.optimizationBlocked!==true&&allKnown;
    if(!complete)warnings.push({code:'INCOMPLETE_SETUP_READ_ONLY',message:'Setup collection is incomplete, truncated, blocked or missing books. Automatic candidate preparation must remain disabled.'});
    if(recordTruncated||sourceTruncated)warnings.push({code:'BOUNDED_REQUEST_ANALYSIS',message:'Request/source analysis was bounded; omitted history cannot establish stability or absence of a problem.',recordsOmitted:Math.max(0,records.length-chosen.length),sourcesTruncated:sourceTruncated});
    if(!requestRows.length||requestRows.some(r=>!r.usageComplete))warnings.push({code:'USAGE_INCOMPLETE',message:'Some or all provider usage is unavailable; missing cache reads are not zero and actual cost cannot be established from fingerprints.'});
    const groupedTargets=code=>[...new Set(findings.filter(f=>f.code===code).flatMap(f=>f.targets))];
    const addAction=(id,kind,targets,reason,requires=[])=>actions.push({id,kind,targets,reason,requires,autoApplicable:false,paidCallsRequired:0});
    if(!complete)addAction('a-coverage','complete-local-inventory',bookRows.filter(b=>!b.loaded).map(b=>b.ref),'Resolve missing/bounded setup collection before preparing any structural change.');
    if(early.length||groupedTargets('DYNAMIC_WORLD_SOURCE_AT_EARLIEST_DIFF').length)addAction('a-structure','prepare-same-scope-structural-preview',[...early.map(e=>e.ref),...groupedTargets('DYNAMIC_WORLD_SOURCE_AT_EARLIEST_DIFF')],'Compare stable foundation and conditional retrieval positions without changing activation, facts, roles or budgets.',['fresh-complete-snapshot','exact-whole-fragment-match','same-role-and-scope','balanced-tags-and-macros','full-request-input-bound']);
    if(ignoreRows.length||findings.some(f=>f.code==='LARGE_CONSTANT_SET'))addAction('a-budget','review-budget-and-constant-volume',[...ignoreRows.map(e=>e.ref),...constantRows.map(e=>e.ref)],'Inspect configured volume and bypass flags locally; do not turn all entries constant or remove budgets.');
    if(duplicateGroups.length||findings.some(f=>f.code==='EXACT_REPEATED_REQUEST_TEXT'))addAction('a-duplicates','review-exact-repetition',groupedTargets('EXACT_TEXT_REPEATED_IN_CONFIG'),'Separate repeated configuration text from actual repeated injection; preserve intentional scope and facts.',['actual-request-occurrences','role-and-scope-review']);
    if(extensionRows.length)addAction('a-memory','read-only-memory-adapter-diagnosis',extensionRows.map(e=>e.ref),'Separate historical summary, current briefing, variables and other extension sources. Only an explicitly supported adapter may write their state.');
    if(requestRows.some(r=>r.finalInput.value===null||r.observationLevel==='frontend'))addAction('a-evidence','passive-server-observation',[],'Use normal play and optional server observation to obtain actual final payload and usage; never infer upstream cache support from model name.');
    const hasInputLimits=Number.isSafeInteger(limits.maxInputTokens)&&limits.maxInputTokens>0&&Number.isSafeInteger(limits.contextTokens)&&limits.contextTokens>0&&Number.isSafeInteger(limits.outputReserveTokens??0)&&(limits.outputReserveTokens??0)>=0&&limits.contextTokens>(limits.outputReserveTokens??0);
    const safety={canPrepareCandidate:complete&&hasInputLimits&&!sourceTruncated,automaticModificationAuthorized:false,requiresFreshSnapshot:true,requiresFullRequestGuard:true,requiresSameRoleAndScope:true,
        sourceTextNeverExecutable:true,unknownExtensionsReadOnly:true,noPaidRequests:true};
    const allDuplicateGroups=[...duplicateConfig.entries()].filter(([,refs])=>refs.length>1).map(([text,refs])=>({refs,characters:text.length,estimatedTokens:estimateTokens(text),injectionConfirmed:false,automaticRemovalAllowed:false}));
    const report={schemaVersion:1,kind:'batch-setup-diagnostic',counts,coverage:{complete,collectionComplete:setup.complete===true,truncated:setup.truncated===true,missingBooks,requestAnalysisTruncated:recordTruncated,sourceAnalysisTruncated:sourceTruncated,coverageUnknown:arr(setup.coverageUnknown).map(x=>typeof x==='string'?x:typeof x?.code==='string'?x.code:'UNKNOWN_COVERAGE')},safety,
        books:bookRows,inventory:{entries},worldQuantities:{wholeBook:quantity(allKnown?wholeEstimate:null),observedInventoryPartial:quantity(wholeEstimate),wholeBookCharacters:totalCharacters,budget,
            activated:requestRows.map(r=>({requestRef:r.ref,...r.activeEntries})),finalInput:requestRows.map(r=>({requestRef:r.ref,...r.finalInput})),worldInfoFinalSentTokens:null,
            note:'Whole-book inventory, configured/observed budget, activation events and whole-request provider input are separate quantities; exact world-only sent tokens are unknown.'},
        settingsFindings:findings,sharedOrders,duplicateGroups:allDuplicateGroups,preset:{orderKnown,orderStrategy:typeof presetInput.orderStrategy==='string'?presetInput.orderStrategy:null,prompts:presetRows},extensions:extensionRows,requestGroups,actions,warnings,
        limitations:['This is a local read-only diagnostic, not evidence of real cache savings or a unique cache-miss cause.','Configured constant activation is not proof that rendered text never changes. Probability 100 is not constant activation.','Equal insertion order is not proof of nondeterminism. Related facts are not duplicate text.','Source matching is exact text correspondence, not cryptographic provenance. Unknown or ambiguous identities remain uncertain.','Character prefix lengths are UTF-16 code units, not tokenizer counts or API cache reads.']};
    report.agentDigest={schemaVersion:1,kind:'local-setup-metadata-only',counts,coverage:{complete,requestAnalysisTruncated:recordTruncated,sourceAnalysisTruncated:sourceTruncated,digestEntriesTruncated:entries.length>digestLimit},
        safety,worldQuantities:{wholeBook:report.worldQuantities.wholeBook,budget,worldInfoFinalSentTokens:null},globalSettings:safeGlobalSettings(globalSettings),
        books:bookRows.map(b=>({ref:b.ref,loaded:b.loaded,counts:b.counts,wholeBook:b.wholeBook,constantVolume:b.constantVolume})),
        entries:entries.slice(0,digestLimit).map(e=>({ref:e.ref,bookRef:e.bookRef,triggerMode:e.triggerMode,settings:e.settings,keywordCount:e.keywordCount,secondaryKeywordCount:e.secondaryKeywordCount,hasGroup:e.hasGroup,estimatedTokens:e.estimatedTokens,hasMacroOrDynamicSyntax:e.hasMacroOrDynamicSyntax,stabilityCandidate:e.stabilityCandidate,observedStable:e.observedStable,stable:e.stable})),
        preset:presetRows.map(p=>({ref:p.ref,enabled:p.enabled,marker:p.marker,role:['system','user','assistant','developer','tool'].includes(p.role)?p.role:null,position:finite(p.position)?p.position:null,depth:finite(p.depth)?p.depth:null,order:finite(p.order)?p.order:null,orderIndex:p.orderIndex,characters:p.characters,hasMacroOrDynamicSyntax:p.hasMacroOrDynamicSyntax})),
        extensions:extensionRows.map(e=>({ref:e.ref,knownAdapter:e.knownAdapter,access:'read-only',position:finite(e.position)?e.position:null,depth:finite(e.depth)?e.depth:null,role:finite(e.role)?e.role:null,characters:e.characters})),
        findings:findings.slice(0,60).map(f=>({code:f.code,severity:f.severity,targets:f.targets.slice(0,20),targetsOmitted:Math.max(0,f.targets.length-20),...numericImpact(f)})),
        groups:requestGroups.map(g=>({ref:g.ref,purpose:g.purpose,interfaceType:protocol(g.interfaceType),requests:g.requests.map(r=>({ref:r.ref,status:['complete','completed','http-error','request-error','pending'].includes(r.status)?r.status:'unknown',bodyObserved:r.bodyObserved,finalInput:r.finalInput,cacheRead:r.cacheRead,cacheWrite:r.cacheWrite,usageComplete:r.usageComplete,activeEntryCount:r.activeEntries.count})),comparisons:g.comparisons.map(c=>({previous:c.previous,current:c.current,includesFailedRequest:c.includesFailedRequest,stablePrefixCharacters:c.stablePrefixCharacters,appendOnly:c.appendOnly,firstDifference:c.firstDifference?{kind:c.firstDifference.kind,path:c.firstDifference.path,offset:c.firstDifference.offset,previousSources:c.firstDifference.previousSources.map(s=>({ref:s.ref,confidence:s.confidence})),sources:c.firstDifference.sources.map(s=>({ref:s.ref,confidence:s.confidence}))}:null,actualCacheRead:c.actualCacheRead,cacheCauseEstablished:false}))})),
        actions:actions.map(a=>({id:a.id,kind:a.kind,targets:a.targets.slice(0,20),targetsOmitted:Math.max(0,a.targets.length-20),requires:a.requires,autoApplicable:false,paidCallsRequired:0})),noPromptText:true,noPrivateBookNames:true,noExternalCallMade:true};
    const digest=report.agentDigest;
    const digestBytes=()=>new TextEncoder().encode(JSON.stringify(digest)).length;
    while(digest.entries.length&&digestBytes()>digestByteLimit)digest.entries.pop();
    if(digestBytes()>digestByteLimit){
        digest.coverage.otherSectionsTruncated=true;
        digest.books=digest.books.slice(0,10);digest.preset=digest.preset.slice(0,10);digest.extensions=digest.extensions.slice(0,10);
        digest.findings=digest.findings.slice(0,12).map(f=>({...f,targets:f.targets.slice(0,5),targetsOmitted:f.targetsOmitted+Math.max(0,f.targets.length-5)}));
        digest.actions=digest.actions.slice(0,8).map(a=>({...a,targets:a.targets.slice(0,5),targetsOmitted:a.targetsOmitted+Math.max(0,a.targets.length-5)}));
        digest.groups=digest.groups.slice(-4).map(g=>({...g,requests:g.requests.slice(-2),comparisons:g.comparisons.slice(-1)}));
    }
    while(digest.groups.length&&digestBytes()>digestByteLimit)digest.groups.shift();
    while(digest.books.length&&digestBytes()>digestByteLimit)digest.books.pop();
    while(digest.findings.length&&digestBytes()>digestByteLimit)digest.findings.pop();
    while(digest.actions.length&&digestBytes()>digestByteLimit)digest.actions.pop();
    const refreshDigestCoverage=()=>{
        digest.coverage.digestEntriesTruncated=entries.length>digest.entries.length;
        digest.coverage.entriesOmitted=entries.length-digest.entries.length;
        digest.coverage.booksOmitted=bookRows.length-digest.books.length;
        digest.coverage.findingsOmitted=findings.length-digest.findings.length;
        digest.coverage.groupsOmitted=requestGroups.length-digest.groups.length;
        digest.coverage.presetPromptsOmitted=presetRows.length-digest.preset.length;
        digest.coverage.extensionsOmitted=extensionRows.length-digest.extensions.length;
        digest.coverage.digestTruncated=digest.coverage.digestEntriesTruncated||digest.coverage.otherSectionsTruncated===true||digest.coverage.booksOmitted>0||digest.coverage.findingsOmitted>0||digest.coverage.groupsOmitted>0||digest.coverage.presetPromptsOmitted>0||digest.coverage.extensionsOmitted>0;
    };
    refreshDigestCoverage();
    while(digestBytes()>digestByteLimit){
        const list=[digest.entries,digest.preset,digest.extensions,digest.groups,digest.books,digest.findings,digest.actions].find(a=>a.length);
        if(!list)break;
        list.pop();digest.coverage.otherSectionsTruncated=true;refreshDigestCoverage();
    }
    return report;
}
