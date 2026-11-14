import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { mountCacheLens } from '../index.js';

const realTimeout = globalThis.setTimeout;
const pause = ms => new Promise(resolve => realTimeout(resolve, ms));
async function waitFor(predicate, label) {
    for (let i = 0; i < 160; i++) { if (predicate()) return; await pause(5); }
    assert.fail(`Timed out waiting for ${label}`);
}
function fixture() {
    const book = 'synthetic-audit-book', dynamic = '<lore>人物的完整召回资料。</lore>', stable = '<lore>世界的固定基础资料。</lore>';
    const source = (uid, content, constant) => ({ id: `world:${book}:${uid}`, kind: 'world-info', name: `synthetic-source-${uid}`, provenance: 'WORLD_INFO_ACTIVATED', content, text: content,
        entry: { uid, world: book, content, constant, key: constant ? [] : ['人物'], position: 0, depth: 4, role: 0, order: 100, disable: false } });
    const sources = [source(1, dynamic, false), source(2, stable, true)];
    const record = { id: 'audit-main-request', chatId: 'audit-chat', characterId: 'audit-card', groupId: null, model: 'synthetic-main-model', provider: 'claude', interfaceType: 'anthropic', purpose: 'main', observationLevel: 'frontend', status: 'complete', startedAt: '2026-11-13T08:00:00.000Z', sources,
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
        body: { model: 'synthetic-main-model', chat_completion_source: 'claude', messages: [{ role: 'system', content: `<world_info>\n${dynamic}\n${stable}\n</world_info>` }, { role: 'user', content: '继续剧情' }] } };
    const setup = { schemaVersion: 1, compatibility: { version: '1.19.0', verifiedSource: true }, binding: { chatId: record.chatId, characterId: record.characterId, groupId: null, provider: record.provider, model: record.model, purpose: 'main' },
        books: [{ id: 'book-1', name: book, boundBy: ['character-primary'], loaded: true, entries: sources.map(s => structuredClone(s.entry)), entryKeys: ['1', '2'], options: {} }],
        worldSettings: { world_info_budget: 25, world_info_budget_cap: 30000, world_info_recursive: true }, preset: { prompts: [], order: [], orderStrategy: 'global', settings: {} }, extensionSources: [],
        snapshot: { activeEntries: sources.map(s => structuredClone(s.entry)), activationEventSeen: true, budgetTokens: 30000 }, counts: { booksExpected: 1, booksLoaded: 1, books: 1, entries: 2 },
        complete: true, truncated: false, optimizationBlocked: false, coverageUnknown: [], warnings: [], revision: { algorithm: 'SHA-256', fingerprint: 'synthetic-audit-revision', requiresRecaptureBeforeApply: true } };
    return { record, setup, dynamic, stable };
}
const prices = { input: 1, output: 1, currency: 'USD', source: 'synthetic-test-only', updatedAt: '2026-11-13' };
const server = { configured: true, serverVersion: '0.1.1', config: { enabled: true, model: 'synthetic-agent', interfaceType: 'openai', maxOutputTokens: 1024, budget: { maxCalls: 100, maxCost: 10, currency: 'USD' }, prices }, ledger: { calls: 0, chargedOrReserved: 0, currency: 'USD' } };
function response(payload, i, operations = []) {
    return { proposal: { expectedVersion: payload.proposalContext.expectedVersion, reason: '已检查设置；真实服务端缓存仍需实际证据。', operations }, record: { id: `audit-paid-${i}`, model: 'synthetic-agent', provider: 'openai', interfaceType: 'openai', time: '2026-11-13T08:05:00.000Z', status: 'completed', usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }, prices, actualCost: 0.00003 } };
}
let serial = 0;
async function harness({ budget = true, agentReply, collector, agentError = null, agentNetwork = null, agentRecords = [], historyError = false, invalidAgentJSON = false } = {}) {
    const f = fixture(), dom = new JSDOM('<div id="extensions_settings2"></div>', { url: 'http://localhost:8000' });
    const descriptors = {}, fetches = [], paid = [], locks = { request: async (_name, options, callback) => (callback || options)() };
    const globals = { document: dom.window.document, window: dom.window, localStorage: dom.window.localStorage, navigator: { locks },
        setTimeout: (fn, ms, ...args) => realTimeout(fn, ms === 600 ? 20 : ms, ...args),
        fetch: async (url, options = {}) => {
            fetches.push({ url, options });
            const route = String(url).split('/').at(-1);
            let result;
            if (route === 'status') result = structuredClone(server);
            else if (route === 'agent-records') {
                if(historyError)return {ok:false,status:503,json:async()=>({error:'ARBITRARY_PRIVATE_SERVER_TEXT'})};
                result = { records: agentRecords };
            }
            else if (route === 'agent') {
                const payload = JSON.parse(options.body); paid.push(payload);
                if(invalidAgentJSON)return {ok:true,status:200,json:async()=>{throw new Error('synthetic private response body');}};
                if(agentError)return {ok:false,status:502,json:async()=>({error:agentError,network:agentNetwork})};
                result = agentReply ? await agentReply(payload, paid.length) : response(payload, paid.length);
            } else throw new Error(`Unexpected network operation: ${route}`);
            return { ok: true, status: 200, json: async () => structuredClone(result) };
        } };
    for (const [key, value] of Object.entries(globals)) { descriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
    const eventSource = new EventEmitter(), eventTypes = Object.fromEntries(['CHAT_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'WORLDINFO_SETTINGS_UPDATED', 'CHARACTER_EDITED'].map(key => [key, key]));
    const context = { chatId: f.record.chatId, characterId: f.record.characterId, groupId: null, extensionSettings: { cache_lens: { maxTests: budget ? 100 : 0, maxCost: budget ? 10 : 0, currency: 'USD' } }, saveSettingsDebounced() {}, eventSource, eventTypes };
    let setup = structuredClone(f.setup), hooks, reads = 0;
    const panel = mountCacheLens({ context, storageNamespace: `audit-ui-${++serial}`, locks,
        setupCollector: async args => { reads++; return collector ? collector({ args, count: reads, setup: structuredClone(setup), context }) : structuredClone(setup); },
        adapterFactory: value => { hooks = value; return { dispose() {}, getSnapshot: () => ({}), getSources: () => [], inspectWorldBook: async () => ({}) }; } });
    await panel.ready;
    const root = document.getElementById('cache-lens-panel'), q = selector => root.querySelector(selector);
    return { f, panel, context, hooks, paid, fetches, q, get reads() { return reads; },
        emit(record = f.record) { hooks.onRecord(structuredClone(record)); },
        click(action) { q(`[data-action="${action}"]`).click(); },
        mutateSetup(fn) { fn(setup); },
        async done() { await waitFor(() => panel.getAgentAudit() && q('[data-action="audit-stop"]').disabled, 'audit completion'); },
        async close() { panel.dispose(); await panel.flushObservations(); dom.window.close(); for (const [key, descriptor] of Object.entries(descriptors)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
    };
}

test('missing selected character stops full audit before paid calls and exports collection cause', async () => {
    const h=await harness();
    try{
        h.mutateSetup(setup=>{
            setup.character=null;setup.binding.characterId=null;setup.books=[];setup.complete=false;
            setup.counts={booksExpected:0,booksLoaded:0,books:0,entries:0};
            setup.coverageUnknown=['CURRENT_CHARACTER_UNSELECTED'];
            setup.warnings=[{code:'CURRENT_CHARACTER_UNSELECTED',privateName:'synthetic-private-name'}];
            setup.preset.prompts=Array.from({length:87},(_,i)=>({identifier:`p-${i}`,content:'synthetic private preset',enabled:true}));
        });
        h.click('batch-agent');await h.done();
        const result=h.panel.getAgentAudit();
        assert.equal(result.reason,'AUDIT_COLLECTION_INCOMPLETE');assert.equal(result.calls,0);
        assert.equal(result.coverage.collection.currentCharacterSelected,false);
        assert.equal(result.coverage.collection.totals.presetsPrepared,87);
        assert.ok(result.collectionIssues.includes('CURRENT_CHARACTER_UNSELECTED'));
        assert.equal(h.fetches.length,0);assert.equal(h.paid.length,0);
        assert.equal(h.q('[data-action="audit-export"]').hidden,false);
        assert.match(h.q('[data-id="auditResult"]').textContent,/先打开要检查的角色聊天/);
        assert.doesNotMatch(JSON.stringify(result),/synthetic-private-name|synthetic private preset/);
    }finally{await h.close();}
});

test('unknown world bindings stop paid audit without guessing no books are bound', async()=>{
    const h=await harness();
    try{
        h.mutateSetup(setup=>{setup.books=[];setup.counts={booksExpected:0,booksLoaded:0};setup.complete=false;setup.coverageUnknown=['GLOBAL_BINDINGS_UNKNOWN'];setup.warnings=[{code:'WORLD_MODULE_UNAVAILABLE'}];});
        h.click('batch-agent');await h.done();
        assert.equal(h.paid.length,0);assert.equal(h.fetches.length,0);
        assert.ok(h.panel.getAgentAudit().collectionIssues.includes('WORLD_MODULE_UNAVAILABLE'));
        assert.match(h.q('[data-id="auditResult"]').textContent,/公开接口未能加载/);
    }finally{await h.close();}
});

test('paid audit exports bounded server error and stage, with no automatic retry',async()=>{
    const h=await harness({agentError:'AGENT_HTTP_400'});
    try{
        h.click('batch-agent');await h.done();
        const result=h.panel.getAgentAudit();
        assert.equal(result.status,'partial');assert.equal(result.reviewedPages,0);assert.equal(result.calls,1);
        assert.equal(result.failure.code,'AGENT_HTTP_400');assert.equal(result.failure.httpStatus,502);assert.equal(result.failure.upstreamHttpStatus,400);
        assert.equal(result.failure.stage,'page-call');assert.equal(result.failure.page,1);
        assert.equal(h.paid.length,1);assert.match(h.q('[data-id="auditResult"]').textContent,/AGENT_HTTP_400/);
        assert.doesNotMatch(h.q('[data-id="auditProgress"]').textContent,/已发生调用仍计费/);
    }finally{await h.close();}
});

test('audit network failure shows safe transport reason and exports it without retry or application',async()=>{
    const network={version:1,reason:'ECONNRESET',phase:'wait-headers',route:'direct',requestMayHaveBeenSent:true,responseHeadersReceived:false,elapsedMs:1723};
    const h=await harness({agentError:'UPSTREAM_CONNECTION_FAILED',agentNetwork:{...network,message:'synthetic-private-error',address:'192.0.2.1',headers:{authorization:'synthetic-key'}}});
    try{
        h.click('batch-agent');await h.done();
        const result=h.panel.getAgentAudit();
        assert.equal(result.reason,'AUDIT_STOPPED_AFTER_ERROR');assert.equal(result.calls,1);
        assert.deepEqual(result.failure.network,network);assert.equal(result.failure.stage,'page-call');
        assert.equal(h.paid.length,1);assert.equal(result.selectedCandidateId,null);
        assert.match(h.q('[data-id="auditResult"]').textContent,/ECONNRESET/);
        assert.match(h.q('[data-id="auditResult"]').textContent,/等待 API 响应/);
        assert.doesNotMatch(JSON.stringify(result),/synthetic-private-error|192\.0\.2\.1|synthetic-key/);
    }finally{await h.close();}
});

test('free recovery renders a network cause with zero budget and only reads existing records',async()=>{
    const network={version:1,reason:'ENETUNREACH',phase:'connect',route:'direct',requestMayHaveBeenSent:false,responseHeadersReceived:false,elapsedMs:17};
    const h=await harness({budget:false,agentRecords:[{status:'failed',error:'UPSTREAM_CONNECTION_FAILED',network}]});
    try{
        h.click('audit-recover');await waitFor(()=>!h.q('[data-action="audit-recover"]').disabled,'network history read');
        assert.deepEqual(h.panel.getAgentAudit().recovery.history.recentFailures[0].failure.network,network);
        assert.match(h.q('[data-id="auditResult"]').textContent,/ENETUNREACH/);
        assert.equal(h.paid.length,0);assert.ok(h.fetches.every(f=>f.options.method==='GET'));
    }finally{await h.close();}
});

test('free recovery reads existing failures with zero budget and never correlates them to the audit',async()=>{
    const h=await harness({budget:false,agentRecords:[{id:'baf91b50-8683-4c41-8a4d-6cd07bb99661',time:'2026-11-13T08:05:00.000Z',status:'failed',error:'AGENT_PROPOSAL_NOT_JSON',apiKey:'synthetic-private-key',body:'synthetic private story',model:'synthetic-private-model',actualCost:0.0002,reservedCost:0.03,currency:'USD',spendGuard:'usage-priced',usage:{prompt_tokens:20,completion_tokens:10}}]});
    try{
        h.click('audit-recover');await waitFor(()=>!h.q('[data-action="audit-recover"]').disabled,'free recovery completion');
        const result=h.panel.getAgentAudit();
        assert.equal(result.status,'diagnostic-only');assert.equal(result.recovery.modelCallsMade,0);
        assert.equal(result.recovery.history.correlatedToAudit,false);
        assert.equal(result.recovery.history.recentFailures[0].failure.code,'AGENT_PROPOSAL_NOT_JSON');
        assert.equal(h.paid.length,0);
        assert.deepEqual(h.fetches.map(f=>f.url.split('/').at(-1)).sort(),['agent-records','status']);
        assert.ok(h.fetches.every(f=>f.options.method==='GET'));
        assert.doesNotMatch(JSON.stringify(result),/synthetic-private-key|synthetic private story|synthetic-private-model/);
        assert.match(h.q('[data-id="auditResult"]').textContent,/JSON/);
        assert.equal(h.q('[data-action="audit-export"]').hidden,false);
    }finally{await h.close();}
});

test('free recovery keeps local evidence exportable when server history is unavailable',async()=>{
    const h=await harness({budget:false,historyError:true});
    try{
        h.click('audit-recover');await waitFor(()=>!h.q('[data-action="audit-recover"]').disabled,'failed history read');
        const result=h.panel.getAgentAudit();
        assert.ok(result.recovery.collection);assert.equal(result.recovery.history,null);
        assert.equal(result.recovery.historyFailure.code,'AUDIT_UNKNOWN_ERROR');assert.equal(result.recovery.historyFailure.httpStatus,503);
        assert.equal(h.paid.length,0);assert.equal(result.recovery.modelCallsMade,0);
        assert.doesNotMatch(JSON.stringify(result),/ARBITRARY_PRIVATE_SERVER_TEXT/);
    }finally{await h.close();}
});

test('browser network and invalid service JSON failures export distinct safe codes without raw text',async()=>{
    for(const [options,code] of [[{agentReply:async()=>{throw new TypeError('synthetic private endpoint/key');}},'CLIENT_NETWORK_ERROR'],[{invalidAgentJSON:true},'SERVER_RESPONSE_INVALID_JSON']]){
        const h=await harness(options);
        try{
            h.click('batch-agent');await h.done();const result=h.panel.getAgentAudit();
            assert.equal(result.failure.code,code);assert.equal(result.failure.stage,'page-call');assert.equal(result.calls,1);
            assert.equal(h.paid.length,1);assert.doesNotMatch(JSON.stringify(result),/synthetic private/);
        }finally{await h.close();}
    }
});

test('one-click audit collects current configuration before refusing zero budget without any network', async () => {
    const h = await harness({ budget: false });
    try {
        h.emit(); h.click('batch-agent');
        await waitFor(() => /未配置 Agent 付费预算/.test(h.q('[data-id="status"]').textContent), 'local zero-budget result');
        assert.equal(h.reads, 1);
        assert.equal(h.panel.getBatchReport().counts.entries, 2);
        assert.equal(h.fetches.length, 0);
        assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
    } finally { await h.close(); }
});

test('configured one-click audit reviews pages and synthesis without editing prompt or settings', async () => {
    const h = await harness();
    try {
        h.emit(); const before = JSON.stringify(h.context.extensionSettings), body = JSON.stringify(h.f.record.body);
        h.click('batch-agent'); await h.done();
        const result = h.panel.getAgentAudit();
        assert.equal(result.status, 'complete', JSON.stringify(result));
        assert.equal(result.reviewedPages, result.totalPages);
        assert.equal(h.paid.length, result.totalPages + 1);
        assert.equal(JSON.stringify(h.context.extensionSettings), before);
        assert.equal(JSON.stringify(h.panel.getRecords().find(r => r.id === h.f.record.id).body), body);
        assert.equal(h.panel.getRecords().filter(r => r.purpose === 'agent').length, h.paid.length);
        assert.equal(h.q('[data-action="audit-apply"]').hidden, true);
        assert.equal(h.q('[data-id="auditExcerpts"]').checked, false);
        assert.equal(JSON.stringify(h.paid).includes('人物的完整召回资料'), false);
        assert.equal(h.fetches.some(f => !/\/(?:status|agent|agent-records)$/.test(f.url)), false);
    } finally { await h.close(); }
});

test('direct stop during an active audit call prevents every subsequent paid call', async () => {
    let release;
    const h = await harness({ agentReply: (payload, i) => new Promise(resolve => { release = () => resolve(response(payload, i)); }) });
    try {
        h.emit(); h.click('batch-agent'); await waitFor(() => !!release, 'first pending Agent call');
        h.click('audit-stop');
        assert.match(h.q('[data-id="auditProgress"]').textContent, /停止后续/);
        release(); await h.done();
        assert.equal(h.paid.length, 1);
        assert.notEqual(h.panel.getAgentAudit().status, 'complete');
        assert.equal(h.q('[data-action="audit-apply"]').hidden, true);
        assert.equal(h.panel.getRecords().filter(r => r.purpose === 'agent').length, 1);
    } finally { if (release) release(); await h.close(); }
});

test('configuration change during an active audit invalidates the outcome and prevents further calls', async () => {
    let release;
    const h = await harness({ agentReply: (payload, i) => new Promise(resolve => { release = () => resolve(response(payload, i)); }) });
    try {
        h.emit(); h.click('batch-agent'); await waitFor(() => !!release, 'pending audit');
        h.mutateSetup(setup => { setup.revision.fingerprint = 'different-configuration'; });
        h.context.eventSource.emit('WORLDINFO_SETTINGS_UPDATED');
        release(); await h.done();
        assert.equal(h.paid.length, 1);
        assert.notEqual(h.panel.getAgentAudit().status, 'complete');
        assert.equal(h.q('[data-action="audit-apply"]').hidden, true);
        assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
    } finally { if (release) release(); await h.close(); }
});

test('untrusted final Agent write operations are rejected without changing settings', async () => {
    const h = await harness({ agentReply: (payload, i) => response(payload, i, payload.proposalContext.allowedOperations?.includes('select_candidate') ? [{ type: 'write_file', path: '/root/config.yaml', content: 'unsafe' }] : []) });
    try {
        h.emit(); const before = JSON.stringify(h.context.extensionSettings);
        h.click('batch-agent'); await h.done();
        assert.notEqual(h.panel.getAgentAudit().status, 'complete');
        assert.equal(h.paid.length, h.panel.getAgentAudit().totalPages + 1);
        assert.equal(JSON.stringify(h.context.extensionSettings), before);
        assert.equal(h.q('[data-action="audit-apply"]').hidden, true);
    } finally { await h.close(); }
});

const selectCandidate = (payload, i) => response(payload, i, payload.proposalContext.allowedOperations?.includes('select_candidate') ? [{ type: 'select_candidate', candidateId: 'current-batch' }] : []);
test('Agent candidate selection is preview-only until applied, then existing rollback restores linked settings', async () => {
    const h = await harness({ agentReply: selectCandidate });
    try {
        h.emit(); h.click('batch-agent'); await h.done();
        assert.equal(h.panel.getAgentAudit().status, 'complete');
        assert.equal(h.panel.getAgentAudit().selectedCandidateId, 'current-batch');
        assert.equal(h.q('[data-action="audit-apply"]').hidden, false);
        assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
        const before = structuredClone(h.context.extensionSettings.cache_lens), count = h.paid.length;
        h.click('audit-apply'); await waitFor(() => h.context.extensionSettings.cache_lens.batchPolicy.enabled, 'validated policy application');
        const meta = { ...h.f.record, sources: structuredClone(h.f.record.sources), snapshot: { activationEventSeen: true, generation: { type: 'normal', dryRun: false } } }; delete meta.body;
        const changed = await h.hooks.transform(structuredClone(h.f.record.body), meta);
        assert.ok(changed.messages[0].content.indexOf(h.f.stable) < changed.messages[0].content.indexOf(h.f.dynamic));
        h.click('batch-rollback'); await waitFor(() => !h.context.extensionSettings.cache_lens.batchPolicy.enabled, 'policy rollback');
        assert.equal(h.context.extensionSettings.cache_lens.mode, before.mode);
        assert.equal(h.context.extensionSettings.cache_lens.batchFollow, before.batchFollow);
        assert.deepEqual(h.context.extensionSettings.cache_lens.baselineIds, before.baselineIds);
        assert.equal(h.paid.length, count);
        assert.deepEqual(await h.hooks.transform(structuredClone(h.f.record.body), { ...h.f.record }), h.f.record.body);
    } finally { await h.close(); }
});

test('Agent selected candidate is rechecked before application and refuses silently changed configuration', async () => {
    const h = await harness({ agentReply: selectCandidate });
    try {
        h.emit(); h.click('batch-agent'); await h.done();
        assert.equal(h.q('[data-action="audit-apply"]').hidden, false);
        h.mutateSetup(setup => { setup.revision.fingerprint = 'changed-without-event'; });
        h.click('audit-apply');
        await waitFor(() => /已改变|重新扫描/.test(h.q('[data-id="status"]').textContent), 'fresh recheck refusal');
        assert.equal(h.context.extensionSettings.cache_lens.batchPolicy.enabled, false);
        assert.equal(h.context.extensionSettings.cache_lens.batchHistory.length, 0);
    } finally { await h.close(); }
});
