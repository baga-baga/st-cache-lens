import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { validateProxyUrl } from '../server/network.mjs';

const endpoint = 'https://api.openai.com/v1/chat/completions';
const networkModule = new URL('../server/network.mjs', import.meta.url).href;
const agentModule = new URL('../server/agent.mjs', import.meta.url).href;
const testKey = 'sk-fixture-credentials-must-stay-inside-verified-TLS';

test('proxy configuration requires explicit HTTP loopback port and official OpenAI origin', () => {
    assert.equal(validateProxyUrl(undefined), '');
    assert.equal(validateProxyUrl('', { endpoint }), '');
    for (const [input, expected] of [
        ['http://127.0.0.1:7890', 'http://127.0.0.1:7890/'],
        ['http://localhost:7890/', 'http://127.0.0.1:7890/'],
        ['http://[::1]:7890', 'http://[::1]:7890/'],
        ['http://127.0.0.1:80/', 'http://127.0.0.1:80/'],
    ]) assert.equal(validateProxyUrl(input, { endpoint }), expected);
    for (const input of [
        'socks5://127.0.0.1:7890', 'https://127.0.0.1:7890', 'http://127.0.0.1',
        'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://user:key@127.0.0.1:7890',
        'http://127.0.0.1:7890/v1', 'http://127.0.0.1:7890/?secret=key', 'http://127.0.0.1:7890/#x',
        'http://127.1:7890', 'http://2130706433:7890', 'http://0177.0.0.1:7890',
    ]) assert.throws(() => validateProxyUrl(input, { endpoint }), /PROXY_URL_INVALID/);
    for (const input of ['http://198.18.0.1:7890', 'http://192.168.1.1:7890', 'http://127.0.0.2:7890', 'http://proxy.example:7890', 'http://[::ffff:127.0.0.1]:7890']) {
        assert.throws(() => validateProxyUrl(input, { endpoint }), /PROXY_LOOPBACK_REQUIRED/);
    }
    for (const target of ['https://api.openai.com.evil.test/v1', 'https://api.openai.com.:443/v1', 'https://api.openai.com:444/v1', 'http://api.openai.com/v1', 'https://10.0.0.1/v1', 'https://user:key@api.openai.com/v1']) {
        assert.throws(() => validateProxyUrl('http://127.0.0.1:7890', { endpoint: target }), /PROXY_OPENAI_ONLY/);
    }
});

async function certificates(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-lens-connect-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const run = promisify(execFile);
    const command = (...args) => run('openssl', args, { cwd: directory });
    await command('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Cache Lens isolated test CA', '-keyout', 'ca.key', '-out', 'ca.pem');
    for (const [name, hostname] of [['valid', 'api.openai.com'], ['wrong', 'wrong.example.test']]) {
        await command('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${hostname}`, '-keyout', `${name}.key`, '-out', `${name}.csr`);
        await fs.writeFile(path.join(directory, `${name}.ext`), `subjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\n`);
        await command('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
    }
    return { directory, ca: path.join(directory, 'ca.pem'), async pair(name = 'valid') {
        return { key: await fs.readFile(path.join(directory, `${name}.key`)), cert: await fs.readFile(path.join(directory, `${name}.pem`)) };
    } };
}

async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return server.address().port;
}

async function proxyFixture(t, { tlsOptions, responder, status = 200, extraHead = '', stall = false, stallTls = false } = {}) {
    const requests = [], connects = [], plaintext = [];
    let targetPort;
    if (tlsOptions) {
        targetPort = await listen(t, https.createServer(tlsOptions, async (req, res) => {
            let body = '';
            for await (const chunk of req) body += chunk;
            requests.push({ method: req.method, url: req.url, headers: req.headers, body, servername: req.socket.servername });
            if (responder) responder(req, res);
            else res.end(JSON.stringify({ ok: true }));
        }));
    }
    const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    proxy.on('connect', (req, socket, head) => {
        connects.push({ target: req.url, headers: req.headers, head: head.toString() });
        socket.on('data', data => plaintext.push(data));
        socket.on('error', () => {});
        if (stall) return;
        if (status !== 200) { socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\n\r\n`); return; }
        socket.write(`HTTP/1.1 200 Connection Established\r\n\r\n${extraHead}`);
        if (extraHead || stallTls) return;
        const target = net.connect(targetPort, '127.0.0.1');
        target.on('error', () => socket.destroy());
        socket.on('close', () => target.destroy());
        target.on('close', () => socket.destroy());
        socket.pipe(target); target.pipe(socket);
    });
    const port = await listen(t, proxy);
    return { proxyUrl: `http://127.0.0.1:${port}`, requests, connects, plaintext };
}

async function child(options, { ca, mode = 'network', directory } = {}) {
    const script = `
        import dns from 'node:dns';
        import dnsPromises from 'node:dns/promises';
        import { openUpstream, readLimited } from ${JSON.stringify(networkModule)};
        import { AgentService } from ${JSON.stringify(agentModule)};
        const config = ${JSON.stringify(options)};
        let dnsCalls = 0;
        dns.lookup = () => { dnsCalls++; throw new Error('TARGET_DNS_MUST_NOT_RUN'); };
        dnsPromises.lookup = async () => { dnsCalls++; if(config.fakeDns) return [{address:'198.18.0.2',family:4}]; throw new Error('TARGET_DNS_MUST_NOT_RUN'); };
        let output;
        try {
            if (${JSON.stringify(mode)} === 'agent') {
                const service = new AgentService(${JSON.stringify(directory)});
                const draft = { interfaceType:'openai', endpoint:${JSON.stringify(endpoint)}, model:'test-model', apiKey:${JSON.stringify(testKey)}, proxyUrl:config.proxyUrl };
                const check = await service.checkAgent(draft);
                const before = await service.status();
                await service.configure({...draft, enabled:true, maxOutputTokens:256, budget:{maxCalls:1,maxCost:1,currency:'USD'}, prices:{input:1,output:2,currency:'USD',source:'isolated fixture',updatedAt:'2026-11-13'}});
                const result = await service.run({diagnostics:{finding:'dynamic world info'}});
                output = {ok:true,check,beforeCalls:before.ledger.calls,result,status:await service.status()};
            } else {
                const controller = new AbortController();
                let abortTimer;
                if(config.abortAfter !== undefined) abortTimer=setTimeout(()=>controller.abort(),config.abortAfter);
                if(config.abortBefore) controller.abort();
                try {
                    const response = await openUpstream(config.endpoint || ${JSON.stringify(endpoint)}, {method:config.method || 'POST',headers:{Authorization:${JSON.stringify(`Bearer ${testKey}`)},'Content-Type':'application/json',Host:'wrong.test','Proxy-Authorization':'do-not-forward'},body:config.method==='GET'?undefined:'{"test":"private payload"}',timeoutMs:config.timeoutMs || 1500,signal:controller.signal,proxyUrl:config.proxyUrl});
                    output={ok:true,status:response.statusCode,body:await readLimited(response)};
                } finally { clearTimeout(abortTimer); }
            }
        } catch(error) { output={ok:false,code:error.code || error.message}; }
        console.log(JSON.stringify({...output,dnsCalls}));
    `;
    const env = { ...process.env };
    delete env.NODE_EXTRA_CA_CERTS;
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (ca) env.NODE_EXTRA_CA_CERTS = ca;
    return new Promise((resolve, reject) => {
        const processChild = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        processChild.stdout.on('data', data => { stdout += data; });
        processChild.stderr.on('data', data => { stderr += data; });
        const watchdog = setTimeout(() => { processChild.kill(); reject(new Error('Fixture child exceeded deadline')); }, 6000);
        processChild.once('error', error => { clearTimeout(watchdog); reject(error); });
        processChild.once('close', code => {
            clearTimeout(watchdog);
            if (code !== 0) { reject(new Error(`Fixture child exited ${code}: ${stderr}`)); return; }
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid fixture result: ${stdout} ${stderr}`)); }
        });
    });
}

test('real CONNECT/TLS avoids destination DNS and bounds failures', async t => {
    const certs = await certificates(t);
    await t.test('verified TLS succeeds without destination DNS or plaintext API credentials', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair() });
        const result = await child({ proxyUrl: fixture.proxyUrl }, { ca: certs.ca });
        assert.deepEqual(result, { ok: true, status: 200, body: '{"ok":true}', dnsCalls: 0 });
        assert.equal(fixture.connects.length, 1);
        assert.equal(fixture.connects[0].target, 'api.openai.com:443');
        assert.equal(fixture.connects[0].headers.authorization, undefined);
        assert.equal(fixture.connects[0].headers['proxy-authorization'], undefined);
        assert.equal(fixture.connects[0].head, '');
        assert.equal(fixture.requests[0].headers.authorization, `Bearer ${testKey}`);
        assert.equal(fixture.requests[0].headers['proxy-authorization'], undefined);
        assert.equal(fixture.requests[0].headers.host, 'api.openai.com');
        assert.equal(fixture.requests[0].servername, 'api.openai.com');
        assert.equal(fixture.requests[0].body, '{"test":"private payload"}');
        assert.equal(Buffer.concat(fixture.plaintext).includes(Buffer.from(testKey)), false);
    });
    for (const [title, certificate, trust] of [['untrusted certificate', 'valid', false], ['trusted certificate for wrong hostname', 'wrong', true]]) {
        await t.test(`${title} fails before API credentials or body`, async t => {
            const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(certificate) });
            const result = await child({ proxyUrl: fixture.proxyUrl }, { ca: trust ? certs.ca : undefined });
            assert.deepEqual(result, { ok: false, code: 'PROXY_TLS_FAILED', dnsCalls: 0 });
            assert.equal(fixture.requests.length, 0);
            assert.equal(Buffer.concat(fixture.plaintext).includes(Buffer.from(testKey)), false);
        });
    }
    for (const status of [407, 302, 502]) {
        await t.test(`CONNECT ${status} rejects without direct fallback`, async t => {
            const fixture = await proxyFixture(t, { status });
            assert.deepEqual(await child({ proxyUrl: fixture.proxyUrl }), { ok: false, code: status === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_REJECTED', dnsCalls: 0 });
            assert.equal(fixture.connects.length, 1);
        });
    }
    await t.test('unexpected bytes after CONNECT headers are rejected', async t => {
        const fixture = await proxyFixture(t, { extraHead: 'HTTP/1.1 200 OK\r\n\r\n' });
        assert.deepEqual(await child({ proxyUrl: fixture.proxyUrl }), { ok: false, code: 'PROXY_CONNECT_REJECTED', dnsCalls: 0 });
    });
    await t.test('upstream redirect is rejected without another request', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (_req, res) => { res.writeHead(302, { location: 'https://api.openai.com/other' }); res.end(); } });
        assert.deepEqual(await child({ proxyUrl: fixture.proxyUrl }, { ca: certs.ca }), { ok: false, code: 'UPSTREAM_REDIRECT_FORBIDDEN', dnsCalls: 0 });
        assert.equal(fixture.requests.length, 1); assert.equal(fixture.connects.length, 1);
    });
    for (const [title, fixtureOptions] of [['CONNECT', { stall: true }], ['TLS', { stallTls: true }]]) {
        await t.test(`total deadline bounds stalled ${title}`, async t => {
            const fixture = await proxyFixture(t, fixtureOptions);
            assert.deepEqual(await child({ proxyUrl: fixture.proxyUrl, timeoutMs: 100 }), { ok: false, code: 'PROXY_TIMEOUT', dnsCalls: 0 });
        });
    }
    await t.test('total deadline also bounds a stalled response body', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (_req, res) => { res.writeHead(200); res.write('partial'); } });
        assert.deepEqual(await child({ proxyUrl: fixture.proxyUrl, timeoutMs: 250 }, { ca: certs.ca }), { ok: false, code: 'PROXY_TIMEOUT', dnsCalls: 0 });
    });
    await t.test('truncated response body rejects and closes the tunnel', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (_req, res) => {
            res.writeHead(200, { 'Content-Length': '200' });
            res.write('partial');
            setTimeout(() => res.destroy(), 20);
        } });
        const result = await child({ proxyUrl: fixture.proxyUrl }, { ca: certs.ca });
        assert.equal(result.ok, false);
        assert.ok(['ECONNRESET', 'UPSTREAM_CONNECTION_FAILED'].includes(result.code), JSON.stringify(result));
        assert.equal(result.dnsCalls, 0);
        assert.equal(fixture.connects.length, 1);
    });
    await t.test('unavailable proxy does not retry directly', async () => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = server.address().port;
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(await child({ proxyUrl: `http://127.0.0.1:${port}` }), { ok: false, code: 'PROXY_CONNECTION_FAILED', dnsCalls: 0 });
    });
    await t.test('abort cancels CONNECT; already aborted calls do not connect', async t => {
        const fixture = await proxyFixture(t, { stall: true });
        assert.deepEqual(await child({ proxyUrl: fixture.proxyUrl, abortAfter: 100 }), { ok: false, code: 'PROXY_ABORTED', dnsCalls: 0 });
        assert.equal(fixture.connects.length, 1);
        assert.deepEqual(await child({ proxyUrl: fixture.proxyUrl, abortBefore: true }), { ok: false, code: 'PROXY_ABORTED', dnsCalls: 0 });
        assert.equal(fixture.connects.length, 1);
    });
    await t.test('direct route still rejects Fake-IP instead of bypassing private-address protection', async () => {
        assert.deepEqual(await child({ fakeDns: true }), { ok: false, code: 'PRIVATE_ENDPOINT_FORBIDDEN', dnsCalls: 1 });
    });
    await t.test('Agent check and budgeted generation both use the selected proxy', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(req.method === 'GET' ? { id: 'test-model', object: 'model' } : {
                usage: { prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 10 },
                choices: [{ message: { content: '{"expectedVersion":1,"reason":"fixture","operations":[]}' } }],
            }));
        } });
        const directory = path.join(certs.directory, 'agent-state');
        await fs.mkdir(directory);
        const result = await child({ proxyUrl: fixture.proxyUrl }, { ca: certs.ca, mode: 'agent', directory });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.dnsCalls, 0);
        assert.equal(result.check.ok, true);
        assert.equal(result.check.budgetConsumed, false);
        assert.equal(result.beforeCalls, 0);
        assert.equal(result.status.ledger.calls, 1);
        assert.equal(result.result.record.purpose, 'agent');
        assert.deepEqual(fixture.requests.map(req => [req.method, req.url]), [['GET', '/v1/models/test-model'], ['POST', '/v1/chat/completions']]);
        assert.equal(fixture.requests[0].body, '');
        assert.equal(fixture.connects.length, 2);
        assert.doesNotMatch(JSON.stringify(fixture.connects), new RegExp(testKey));
        assert.doesNotMatch(JSON.stringify(result), new RegExp(testKey));
    });
});
