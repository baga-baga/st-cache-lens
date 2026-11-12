import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRelay, UsageObserver } from '../server/relay.mjs';

const relayToken = 'local-secret-token-at-least-24-characters';
const apiKey = 'mock-upstream-key-never-export';
const headers = { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function harness(t, handler, config = {}, options = {}) {
    const upstream = http.createServer(handler); const base = await listen(upstream);
    const relay = createRelay({ interfaceType: 'anthropic', upstreamBaseUrl: base, allowLocalUpstream: true, apiKey, relayToken, ...config }, options);
    const relayBase = await listen(relay);
    t.after(async () => { relay.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => relay.close(r)), new Promise(r => upstream.close(r))]); });
    return { relayBase, base, relay, upstream };
}
async function recordList(base) { const r = await fetch(`${base}/__cache_lens/records`, { headers }); return await r.json(); }
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); }
async function post(base, request, path = '/v1/messages', more = {}) { return fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, ...more }, body: JSON.stringify(request) }); }

test('relay observes actual JSON request and usage, strips request credentials, preserves nested model data', async t => {
    let received;
    const { relayBase } = await harness(t, async (req, res) => {
        received = { headers: req.headers, body: JSON.parse(await body(req)), path: req.url };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'test-model', content: [{ type: 'text', text: 'secret output not retained' }], usage: { input_tokens: 12, cache_creation_input_tokens: 30, cache_read_input_tokens: 100, output_tokens: 7 } }));
    }, { modelPurpose: { 'test-model': 'main' } });
    const request = { model: 'test-model', system: '规则\n\u200b 保留空白', messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'example', input_schema: { properties: { apiKey: { type: 'string' } } } }], metadata: { key: 'private' }, api_key: 'must-not-record' };
    const response = await post(relayBase, request, '/v1/messages', { 'x-api-key': relayToken, 'x-random-secret': 'not-forwarded' });
    assert.equal(response.status, 200); await response.text();
    assert.equal(received.headers['x-api-key'], apiKey); assert.equal(received.headers.authorization, undefined); assert.equal(received.headers['x-random-secret'], undefined);
    assert.deepEqual(received.body, request);
    const data = await recordList(relayBase); const record = data.records[0];
    assert.equal(record.observationLevel, 'server-relay'); assert.equal(record.purpose, 'main'); assert.equal(record.body.system, request.system);
    assert.deepEqual(record.body.tools, request.tools); assert.equal(record.body.metadata, undefined); assert.equal(record.body.api_key, undefined);
    assert.equal(record.usage.cache_read_input_tokens, 100); assert.equal(record.usage.input_tokens, 12);
    assert.equal(record.completion, 'complete'); assert.equal(record.transformed, false); assert.equal(record.requestSha256.length, 64);
    assert.ok(!JSON.stringify(data).includes(apiKey)); assert.ok(!JSON.stringify(data).includes(relayToken)); assert.ok(!JSON.stringify(data).includes('secret output not retained'));
});

test('Anthropic stream forwarded intact and merges start/delta usage without counting twice', async t => {
    const sse = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":1}}}\n\nevent: content_block_delta\ndata: {"delta":{"text":"你好"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9,"cache_creation":{"ephemeral_5m_input_tokens":20}}}\n\ndata: [DONE]\n\n';
    const { relayBase } = await harness(t, async (req, res) => {
        await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
        const bytes = Buffer.from(sse); for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7)); res.end();
    });
    const response = await post(relayBase, { model: 'm', messages: [], stream: true });
    assert.equal(await response.text(), sse);
    const record = (await recordList(relayBase)).records[0];
    assert.equal(record.usage.output_tokens, 9); assert.equal(record.usage.input_tokens, 10); assert.equal(record.usage.cache_creation.ephemeral_5m_input_tokens, 20);
    assert.equal(record.purpose, 'unknown');
});

test('OpenAI stream handles final usage and /v1 upstream base without duplicate v1', async t => {
    let path;
    const upstream = http.createServer(async (req, res) => { path = req.url; assert.equal(req.headers.authorization, `Bearer ${apiKey}`); await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens":5}}\n\ndata: [DONE]\n\n'); });
    const up = await listen(upstream);
    const relay = createRelay({ interfaceType: 'openai', upstreamBaseUrl: `${up}/v1`, allowLocalUpstream: true, apiKey, relayToken }); const relayBase = await listen(relay);
    t.after(async () => { relay.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => relay.close(r)), new Promise(r => upstream.close(r))]); });
    const response = await post(relayBase, { model: 'm', messages: [], stream: true }, '/v1/chat/completions'); await response.text();
    assert.equal(path, '/v1/chat/completions');
    const record = (await recordList(relayBase)).records[0]; assert.equal(record.usage.prompt_tokens_details.cached_tokens, 80); assert.equal(record.provider, 'openai');
});

test('auth, routes, host and byte limits reject before upstream calls', async t => {
    let calls = 0;
    const { relayBase } = await harness(t, (_req, res) => { calls += 1; res.end('{}'); }, { maxInputBytes: 1024 });
    assert.equal((await fetch(`${relayBase}/__cache_lens/records`)).status, 401);
    const wrongHostStatus = await new Promise((resolve, reject) => { const request = http.get(`${relayBase}/__cache_lens/status`, { headers: { ...headers, host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await post(relayBase, { model: 'm' }, '/v1/evil')).status, 404);
    assert.equal((await post(relayBase, { model: 'm', system: 'x'.repeat(1500) })).status, 413);
    assert.equal(calls, 0);
    assert.throws(() => createRelay({ interfaceType: 'anthropic', upstreamBaseUrl: 'https://api.example.com', apiKey, relayToken, host: '0.0.0.0' }), /loopback/);
    assert.throws(() => createRelay({ interfaceType: 'anthropic', upstreamBaseUrl: 'https://api.example.com', apiKey, relayToken: 'short' }), /24/);
});

test('bounded records eviction, clearing and absent usage remain unknown', async t => {
    const { relayBase } = await harness(t, async (req, res) => { await body(req); res.end('{"result":"no usage"}'); }, { maxRecords: 2 });
    for (let i = 0; i < 3; i++) { const r = await post(relayBase, { model: `m${i}`, messages: [] }); await r.text(); }
    const list = (await recordList(relayBase)).records; assert.deepEqual(list.map(r => r.model), ['m1', 'm2']); assert.equal(list[0].usage, null);
    const r = await fetch(`${relayBase}/__cache_lens/records`, { method: 'DELETE', headers }); assert.equal(r.status, 200); assert.equal((await recordList(relayBase)).records.length, 0);
});

test('redirects fail closed and no credentials reach redirect destination', async t => {
    let redirected = 0;
    const destination = http.createServer((_req, res) => { redirected += 1; res.end('{}'); }); const dest = await listen(destination);
    t.after(async () => { destination.closeAllConnections(); await new Promise(r => destination.close(r)); });
    const { relayBase } = await harness(t, async (req, res) => { await body(req); res.writeHead(302, { location: dest }); res.end(); });
    const response = await post(relayBase, { model: 'm', messages: [] }); assert.equal(response.status, 502); assert.equal(redirected, 0);
});

test('UsageObserver bounds large content frames and still captures later usage', () => {
    const observer = new UsageObserver({ sse: true, maxBytes: 1024 });
    observer.feed(Buffer.from(`data: {"text":"${'x'.repeat(3000)}`));
    observer.feed(Buffer.from('"}\n\ndata: {"usage":{"input_tokens":17,"output_tokens":4}}\n\n'));
    assert.deepEqual(observer.finish(), { input_tokens: 17, output_tokens: 4 }); assert.equal(observer.truncated, true);
});

test('optional transformer keeps before and actual sent body evidence', async t => {
    let received;
    const { relayBase } = await harness(t, async (req, res) => { received = JSON.parse(await body(req)); res.end('{}'); }, {}, {
        transformRequest: b => ({ body: { ...b, cache_control: { type: 'ephemeral' } }, metadata: { reason: 'unit-test-only' } }),
    });
    const response = await post(relayBase, { model: 'm', messages: [] }); await response.text();
    const record = (await recordList(relayBase)).records[0]; assert.equal(record.transformed, true); assert.equal(record.beforeBody.cache_control, undefined); assert.deepEqual(record.body.cache_control, received.cache_control); assert.notEqual(record.requestSha256, record.sentSha256);
});

test('policy endpoint CAS guards changes and rejects during active request', async t => {
    let release; let started;
    const began = new Promise(r => { started = r; }); const waiting = new Promise(r => { release = r; });
    const { relayBase } = await harness(t, async (req, res) => { await body(req); started(); await waiting; res.end('{}'); }, {}, { validateCachePolicy: p => p && typeof p.enabled === 'boolean' });
    const initial = await (await fetch(`${relayBase}/__cache_lens/policy`, { headers })).json();
    const commit = async data => fetch(`${relayBase}/__cache_lens/policy`, { method: 'POST', headers, body: JSON.stringify(data) });
    assert.equal((await commit({ policy: { enabled: false }, expectedVersion: 'stale' })).status, 409);
    const changed = await commit({ policy: { enabled: false }, expectedVersion: initial.version }); assert.equal(changed.status, 200); const snapshot = await changed.json(); assert.notEqual(snapshot.version, initial.version);
    const pending = post(relayBase, { model: 'm', messages: [] }); await began;
    assert.equal((await commit({ policy: { enabled: false }, expectedVersion: snapshot.version })).status, 409);
    release(); await (await pending).text();
    assert.equal((await commit({ policy: { enabled: false }, expectedVersion: snapshot.version })).status, 200);
});

test('compressed provider response passes through intact with explicit usage visibility limit', async t => {
    const { gzipSync } = await import('node:zlib');
    const responseBody = JSON.stringify({ content: [{ type: 'text', text: '完整响应' }], usage: { input_tokens: 15 } });
    const { relayBase } = await harness(t, async (req, res) => { await body(req); res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(gzipSync(responseBody)); });
    const response = await post(relayBase, { model: 'm', messages: [] }); assert.equal(await response.text(), responseBody);
    const record = (await recordList(relayBase)).records[0]; assert.equal(record.usage, null); assert.match(record.usageObservationUnavailable, /without local decompression/);
});

test('default cache policy transform records real outgoing block marker and its reason', async t => {
    const { defaultAnthropicRules } = await import('../server/transform.mjs');
    let received;
    const { relayBase } = await harness(t, async (req, res) => { received = JSON.parse(await body(req)); res.end('{"usage":{"input_tokens":20,"cache_read_input_tokens":0}}'); }, {
        cachePolicy: { enabled: true, interfaceType: 'anthropic', model: 'claude-opus-5-5', endpointVerified: true, stableSystemTexts: ['稳定设定'], ttl: '5m', maximumInputTokens: 10000, rules: defaultAnthropicRules },
    });
    const response = await post(relayBase, { model: 'claude-opus-5-5', system: [{ type: 'text', text: '稳定设定' }], messages: [{ role: 'user', content: '继续' }] }); await response.text();
    assert.deepEqual(received.system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
    const record = (await recordList(relayBase)).records[0]; assert.equal(record.transformed, true); assert.equal(record.transformation.applied, true); assert.equal(record.transformation.minimumVerified, false); assert.equal(record.transmission, 'upstream-responded');
});

test('DeepSeek usage semantics identified by observed hit/miss fields without model guessing', async t => {
    const { relayBase } = await harness(t, async (req, res) => { await body(req); res.end('{"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20,"completion_tokens":5}}'); }, { interfaceType: 'openai' });
    const response = await post(relayBase, { model: 'arbitrary-alias', messages: [] }, '/v1/chat/completions'); await response.text();
    const record = (await recordList(relayBase)).records[0]; assert.equal(record.interfaceType, 'deepseek'); assert.equal(record.provider, 'openai'); assert.equal(record.transportInterfaceType, 'openai'); assert.equal(record.purpose, 'unknown');
});

test('configured hard input ceiling blocks 1.5-million-character request before any upstream call', async t => {
    let calls = 0;
    const { relayBase } = await harness(t, (_req, res) => { calls += 1; res.end('{}'); }, { maxInputTokens: 200000 });
    const response = await post(relayBase, { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(1500000) }] });
    assert.equal(response.status, 413); assert.equal((await response.json()).error, 'input_token_bound_exceeded'); assert.equal(calls, 0);
    const record = (await recordList(relayBase)).records[0]; assert.equal(record.transmission, 'not-attempted'); assert.equal(record.inputGuard.exact, false); assert.ok(record.inputGuard.value > 1500000); assert.equal(record.inputGuard.allowedInput, 200000);
});

test('known ordinary text under both ceilings forwards and reserves actual maximum output', async t => {
    let calls = 0;
    const { relayBase } = await harness(t, async (req, res) => { calls += 1; await body(req); res.end('{}'); }, { maxInputTokens: 10000, contextTokens: 8000, outputReserveTokens: 1000 });
    const response = await post(relayBase, { model: 'm', max_tokens: 2000, system: [{ type: 'text', text: '规则', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hello' }] }); await response.text();
    assert.equal(response.status, 200); assert.equal(calls, 1);
    const record = (await recordList(relayBase)).records[0]; assert.equal(record.inputGuard.outputReserveTokens, 2000); assert.equal(record.inputGuard.allowedInput, 6000); assert.equal(record.inputGuard.ok, true); assert.equal(record.inputGuard.exact, false);
});

test('configured ceiling refuses multimodal or hidden history; unconfigured diagnostic mode still forwards', async t => {
    let guardedCalls = 0;
    const guard = await harness(t, async (req, res) => { guardedCalls += 1; await body(req); res.end('{}'); }, { interfaceType: 'openai', maxInputTokens: 10000 });
    const multimodal = { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }] }] };
    const blocked = await post(guard.relayBase, multimodal, '/v1/chat/completions'); assert.equal(blocked.status, 422); assert.equal((await blocked.json()).error, 'input_bound_unavailable');
    const hidden = await post(guard.relayBase, { model: 'm', input: 'continue', previous_response_id: 'resp-hidden' }, '/v1/responses'); assert.equal(hidden.status, 422); assert.equal(guardedCalls, 0);
    let plainCalls = 0;
    const plain = await harness(t, async (req, res) => { plainCalls += 1; await body(req); res.end('{}'); }, { interfaceType: 'openai' });
    const forwarded = await post(plain.relayBase, multimodal, '/v1/chat/completions'); assert.equal(forwarded.status, 200); await forwarded.text(); assert.equal(plainCalls, 1);
    assert.equal((await recordList(plain.relayBase)).records[0].inputGuard.enabled, false);
});

test('guard also checks transformed payload and rejects expansion before upstream', async t => {
    let calls = 0;
    const { relayBase } = await harness(t, (_req, res) => { calls += 1; res.end('{}'); }, { maxInputTokens: 5000 }, { transformRequest: request => ({ ...request, system: 'x'.repeat(10000) }) });
    const response = await post(relayBase, { model: 'm', messages: [] }); assert.equal(response.status, 413); assert.equal(calls, 0);
});

test('context limit requires a bounded output allowance and cannot be bypassed by a larger output request', async t => {
    let calls = 0;
    const { relayBase } = await harness(t, (_req, res) => { calls += 1; res.end('{}'); }, { contextTokens: 8000 });
    const missing = await post(relayBase, { model: 'm', messages: [] }); assert.equal(missing.status, 422); assert.equal((await missing.json()).error, 'output_reserve_unbounded');
    const excessive = await post(relayBase, { model: 'm', messages: [], max_tokens: 5000 }); assert.equal(excessive.status, 413); assert.equal(calls, 0);
});

test('configured input guard rejects unrecognized provider fields and malformed modalities without forwarding', async t => {
    let calls = 0;
    const { relayBase } = await harness(t, async (req, res) => { calls += 1; await body(req); res.end('{}'); }, { interfaceType: 'openai', maxInputTokens: 10000 });
    for (const extra of [{ remote_context: 'unknown-provider-material' }, { context_management: {} }, { modalities: 'audio' }]) {
        const response = await post(relayBase, { model: 'm', messages: [{ role: 'user', content: 'hello' }], ...extra }, '/v1/chat/completions');
        assert.equal(response.status, 422); assert.equal((await response.json()).error, 'input_bound_unavailable');
    }
    assert.equal(calls, 0);
});

test('blocked real cache transform retains rejection metadata and no upstream transmission', async t => {
    const { defaultAnthropicRules } = await import('../server/transform.mjs');
    let calls = 0;
    const { relayBase } = await harness(t, async (req, res) => { calls += 1; await body(req); res.end('{}'); }, {
        cachePolicy: { enabled: true, interfaceType: 'anthropic', model: 'claude-opus-5-5', endpointVerified: true, stableSystemTexts: ['稳定设定'], ttl: '5m', maximumInputTokens: 100, rules: defaultAnthropicRules },
    });
    const response = await post(relayBase, { model: 'claude-opus-5-5', system: [{ type: 'text', text: '稳定设定' }], messages: [{ role: 'user', content: '继续' }] });
    assert.equal(response.status, 413); assert.equal(calls, 0);
    const record = (await recordList(relayBase)).records[0]; assert.equal(record.transmission, 'not-attempted'); assert.equal(record.transformation.applied, false); assert.equal(record.transformation.requestBlocked, true);
});
