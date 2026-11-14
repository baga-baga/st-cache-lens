import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { AgentService } from '../server/agent.mjs';
import { ServiceError } from '../server/network.mjs';
import { init, serviceForRequest } from '../server/index.mjs';

async function directoryFor(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-lens-network-service-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

async function registeredRoutes() {
    const routes = new Map();
    await init({
        get: (route, handler) => routes.set(`GET ${route}`, handler),
        post: (route, handler) => routes.set(`POST ${route}`, handler),
    });
    return routes;
}

function responseCapture() {
    return {
        headers: {}, statusCode: 200, body: null,
        setHeader(key, value) { this.headers[key] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

test('model GET can succeed before a POST disconnect; safe cause persists without retry or budget refund', { timeout: 5000 }, async t => {
    const directory = await directoryFor(t);
    const requests = [];
    const server = http.createServer(async (request, response) => {
        let bytes = 0;
        for await (const chunk of request) bytes += chunk.length;
        requests.push({ method: request.method, path: request.url, bytes });
        if (request.method === 'GET') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ id: 'network-test-model' }));
        } else request.socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const service = new AgentService(directory);
    const config = {
        endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        interfaceType: 'openai', model: 'network-test-model', apiKey: 'sk-isolated-fixture-not-a-real-key',
        allowLocal: true, enabled: true, maxOutputTokens: 256,
        budget: { maxCalls: 1, maxCost: 1, currency: 'USD' },
        prices: { input: 1, output: 2, currency: 'USD', source: 'isolated local fixture', updatedAt: '2026-11-14' },
    };
    await service.configure(config);
    const check = await service.checkAgent();
    assert.equal(check.ok, true);
    assert.equal(check.generationVerified, false);
    assert.equal((await service.status()).ledger.calls, 0);
    let failure;
    await assert.rejects(service.run({ diagnostics: { finding: 'fixture data only' } }), error => {
        failure = error;
        return error.code === 'UPSTREAM_CONNECTION_FAILED';
    });
    assert.equal(failure.network.reason, 'ECONNRESET');
    assert.equal(failure.network.route, 'direct');
    assert.equal(failure.network.requestMayHaveBeenSent, true);
    assert.equal(failure.network.responseHeadersReceived, false);
    assert.ok(['send', 'wait-headers'].includes(failure.network.phase));
    const status = await service.status();
    const record = service.state.records[0];
    assert.equal(status.busy, false);
    assert.equal(status.ledger.calls, 1);
    assert.ok(record.reservedCost > 0);
    assert.equal(status.ledger.chargedOrReserved, record.reservedCost);
    assert.equal(record.actualCost, null);
    assert.equal(record.usage, null);
    assert.equal(record.spendGuard, 'reservation-retained-usage-unknown');
    assert.equal(record.status, 'failed');
    assert.deepEqual(record.network, failure.network);
    assert.doesNotMatch(JSON.stringify(record), /sk-isolated|127\.0\.0\.1|fixture data only|socket hang up/);
    const reloaded = new AgentService(directory);
    await reloaded.load();
    assert.deepEqual(reloaded.state.records[0].network, record.network);
    assert.deepEqual((await reloaded.status()).ledger, status.ledger);
    await assert.rejects(reloaded.run({ diagnostics: {} }), /AGENT_BUDGET_EXHAUSTED/);
    assert.deepEqual(requests.map(request => request.method), ['GET', 'POST']);
    assert.equal(requests[0].bytes, 0);
    assert.ok(requests[1].bytes > 0);
});

test('authenticated Agent routes expose only the safe network schema, never raw transport details', async t => {
    const directory = await directoryFor(t);
    const request = { user: { directories: { root: directory } }, body: {} };
    const service = serviceForRequest(request);
    const routes = await registeredRoutes();
    const error = new ServiceError('UPSTREAM_CONNECTION_FAILED', 502);
    error.message = 'Bearer sk-private-fixture-secret https://internal.invalid/private';
    error.network = {
        version: 1, reason: 'ECONNRESET', phase: 'wait-headers', route: 'direct',
        requestMayHaveBeenSent: true, responseHeadersReceived: false, elapsedMs: 42,
        headers: { authorization: error.message }, address: '127.0.0.1', stack: error.message,
        endpoint: 'https://internal.invalid/private', message: error.message,
    };
    service.checkAgent = async () => { throw error; };
    service.run = async () => { throw error; };
    for (const route of ['POST /agent-check', 'POST /agent']) {
        const response = responseCapture();
        await routes.get(route)(request, response);
        assert.equal(response.statusCode, 502);
        assert.equal(response.headers['Cache-Control'], 'no-store');
        assert.deepEqual(response.body, {
            error: 'UPSTREAM_CONNECTION_FAILED',
            network: {
                version: 1, reason: 'ECONNRESET', phase: 'wait-headers', route: 'direct',
                requestMayHaveBeenSent: true, responseHeadersReceived: false, elapsedMs: 42,
            },
        });
        assert.doesNotMatch(JSON.stringify(response.body), /sk-private|127\.0\.0\.1|internal\.invalid|Bearer|"(?:headers|stack|endpoint|message)":/);
    }
});

test('legacy service errors keep their shape and ordinary errors cannot inject network metadata', async t => {
    const directory = await directoryFor(t);
    const request = { user: { directories: { root: directory } }, body: {} };
    const service = serviceForRequest(request);
    const routes = await registeredRoutes();
    service.checkAgent = async () => { throw new ServiceError('AGENT_CHECK_FAILED', 502); };
    const legacy = responseCapture();
    await routes.get('POST /agent-check')(request, legacy);
    assert.deepEqual(legacy.body, { error: 'AGENT_CHECK_FAILED' });
    service.checkAgent = async () => {
        const error = new Error('private diagnostic text');
        error.network = { version: 1, reason: 'ECONNRESET', phase: 'connect', route: 'direct', requestMayHaveBeenSent: false, responseHeadersReceived: false, elapsedMs: 1 };
        throw error;
    };
    const ordinary = responseCapture();
    await routes.get('POST /agent-check')(request, ordinary);
    assert.equal(ordinary.statusCode, 500);
    assert.deepEqual(ordinary.body, { error: 'CACHE_LENS_SERVER_ERROR' });
});
