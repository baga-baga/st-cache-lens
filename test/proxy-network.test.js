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
import { isPublicAddress, validateProxyUrl } from '../server/network.mjs';

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

test('transport diagnostics distinguish failed phases and pinned TCP fallback never repeats HTTP', async t => {
    const certs = await certificates(t);
    const assertSafe = diagnostic => {
        assert.equal(diagnostic.version, 1);
        assert.ok(Number.isSafeInteger(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0);
        assert.deepEqual(Object.keys(diagnostic).sort(), ['elapsedMs', 'phase', 'reason', 'requestMayHaveBeenSent', 'responseHeadersReceived', 'route', 'version'].sort());
        assert.doesNotMatch(JSON.stringify(diagnostic), /api\.openai|127\.0|198\.18|Bearer|private payload|credential|certificate|sk-fixture/i);
    };
    for (const [name, dnsAnswers, routeCandidates] of [
        ['IPv6 then IPv4', [{ address: '2001:4860:4860::8888', family: 6 }, { address: '8.8.8.8', family: 4 }], [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]],
        ['two IPv4 addresses', [{ address: '198.18.0.2', family: 4 }, { address: '8.8.8.8', family: 4 }], [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }]],
    ]) await t.test(`${name}: unreachable first TCP address falls through to second with one authenticated POST`, async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair() });
        const result = await child({ dnsAnswers, routePort: fixture.targetPort, routeCandidates, includeNetwork: true }, { ca: certs.ca });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.dnsCalls, 1);
        assert.deepEqual(result.routed, [{ host: 'api.openai.com', port: 443, addresses: dnsAnswers }]);
        assert.equal(fixture.requests.length, 1);
        assert.equal(fixture.requests[0].method, 'POST');
        assert.equal(fixture.requests[0].servername, 'api.openai.com');
        assert.equal(fixture.requests[0].headers.authorization, `Bearer ${testKey}`);
    });
    for (const proxy of [false, true]) await t.test(`${proxy ? 'CONNECT' : 'normal route'} GET succeeds but generation POST disconnects without automatic retry`, async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (req, res) => {
            if (req.method === 'GET') res.end('{"id":"test-model"}');
            else req.socket.destroy();
        } });
        const options = proxy ? { proxyUrl: fixture.proxyUrl } : { fakeDns: true, routePort: fixture.targetPort };
        const check = await child({ ...options, method: 'GET' }, { ca: certs.ca });
        assert.equal(check.ok, true);
        const failed = await child({ ...options, includeNetwork: true }, { ca: certs.ca });
        assert.equal(failed.code, 'UPSTREAM_CONNECTION_FAILED');
        assertSafe(failed.network);
        assert.equal(failed.network.reason, 'ECONNRESET');
        assert.ok(['send', 'wait-headers'].includes(failed.network.phase), JSON.stringify(failed));
        assert.equal(failed.network.route, proxy ? 'local-proxy' : 'direct');
        assert.equal(failed.network.requestMayHaveBeenSent, true);
        assert.equal(failed.network.responseHeadersReceived, false);
        assert.deepEqual(fixture.requests.map(req => req.method), ['GET', 'POST']);
    });
    for (const proxy of [false, true]) await t.test(`${proxy ? 'CONNECT' : 'normal route'} incomplete body retains a safe transport failure`, async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (_req, res) => {
            res.writeHead(200, { 'content-length': '500' }); res.write('{"partial":');
            setTimeout(() => res.destroy(), 20);
        } });
        const options = proxy ? { proxyUrl: fixture.proxyUrl } : { fakeDns: true, routePort: fixture.targetPort };
        const failed = await child({ ...options, includeNetwork: true }, { ca: certs.ca });
        assert.equal(failed.code, 'UPSTREAM_CONNECTION_FAILED');
        assertSafe(failed.network);
        assert.ok(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(failed.network.reason));
        assert.equal(failed.network.phase, 'body');
        assert.equal(failed.network.responseHeadersReceived, true);
        assert.equal(fixture.requests.length, 1);
    });
    for (const proxy of [false, true]) await t.test(`${proxy ? 'CONNECT' : 'normal route'} absolute deadline covers a stalled response body`, async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (_req, res) => {
            res.writeHead(200, { 'content-length': '500' }); res.write('{"partial":');
        } });
        const options = proxy ? { proxyUrl: fixture.proxyUrl } : { fakeDns: true, routePort: fixture.targetPort };
        const failed = await child({ ...options, timeoutMs: 180, includeNetwork: true }, { ca: certs.ca });
        assert.equal(failed.code, proxy ? 'PROXY_TIMEOUT' : 'UPSTREAM_TIMEOUT');
        assertSafe(failed.network);
        assert.equal(failed.network.reason, 'TIMEOUT');
        assert.equal(failed.network.phase, 'body');
        assert.equal(failed.network.responseHeadersReceived, true);
        assert.equal(fixture.requests.length, 1);
    });
    await t.test('DNS timeout cannot connect after a late resolver result', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair() });
        const failed = await child({ fakeDns: true, dnsDelay: 160, routePort: fixture.targetPort, timeoutMs: 30, waitAfter: 250, includeNetwork: true }, { ca: certs.ca });
        assert.equal(failed.code, 'UPSTREAM_TIMEOUT');
        assertSafe(failed.network);
        assert.equal(failed.network.phase, 'dns');
        assert.equal(failed.network.requestMayHaveBeenSent, false);
        assert.deepEqual(failed.routed, []);
        assert.equal(fixture.requests.length, 0);
    });
    await t.test('aborting DNS prevents a late resolver result from opening a socket', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair() });
        const failed = await child({ fakeDns: true, dnsDelay: 160, routePort: fixture.targetPort, abortAfter: 25, waitAfter: 250, includeNetwork: true }, { ca: certs.ca });
        assert.equal(failed.code, 'UPSTREAM_ABORTED');
        assertSafe(failed.network);
        assert.equal(failed.network.reason, 'ABORTED');
        assert.equal(failed.network.phase, 'dns');
        assert.equal(failed.network.requestMayHaveBeenSent, false);
        assert.deepEqual(failed.routed, []);
        assert.equal(fixture.requests.length, 0);
    });
    await t.test('DNS failures preserve only allowlisted codes', async () => {
        for (const reason of ['ENOTFOUND', 'EAI_AGAIN', 'arbitrary-private-error-message']) {
            const failed = await child({ dnsFailure: reason, includeNetwork: true });
            assert.equal(failed.code, 'UPSTREAM_DNS_FAILED');
            assertSafe(failed.network);
            assert.equal(failed.network.reason, reason.startsWith('E') ? reason : 'UNKNOWN');
            assert.equal(failed.network.phase, 'dns');
            assert.equal(failed.network.requestMayHaveBeenSent, false);
        }
    });
    await t.test('TLS hostname validation is reported without sending authorization or suppressing verification', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair('wrong') });
        const failed = await child({ fakeDns: true, routePort: fixture.targetPort, insecureEnvironment: true, includeNetwork: true }, { ca: certs.ca });
        assert.equal(failed.code, 'UPSTREAM_CONNECTION_FAILED');
        assertSafe(failed.network);
        assert.equal(failed.network.reason, 'ERR_TLS_CERT_ALTNAME_INVALID');
        assert.equal(failed.network.phase, 'tls');
        assert.equal(failed.network.requestMayHaveBeenSent, false);
        assert.equal(fixture.requests.length, 0);
    });
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
    return { proxyUrl: `http://127.0.0.1:${port}`, targetPort, requests, connects, plaintext };
}

async function child(options, { ca, mode = 'network', directory } = {}) {
    const script = `
        import dns from 'node:dns';
        import dnsPromises from 'node:dns/promises';
        import net from 'node:net';
        import { openUpstream, readLimited } from ${JSON.stringify(networkModule)};
        import { AgentService } from ${JSON.stringify(agentModule)};
        const config = ${JSON.stringify(options)};
        let dnsCalls = 0;
        dns.lookup = () => { dnsCalls++; throw new Error('TARGET_DNS_MUST_NOT_RUN'); };
        dnsPromises.lookup = async () => { dnsCalls++; if(config.dnsDelay) await new Promise(resolve=>setTimeout(resolve,config.dnsDelay)); if(config.dnsFailure) throw Object.assign(new Error('private address / credential must not escape'),{code:config.dnsFailure}); if(config.dnsAnswers) return config.dnsAnswers; if(config.fakeDns) return [{address:'198.18.0.2',family:4}]; throw new Error('TARGET_DNS_MUST_NOT_RUN'); };
        const routed = [];
        if(config.routePort) {
            // Test-only stand-in for OS/TUN routing. Consume the production pinned
            // lookup, then redirect just the TCP socket to the local TLS fixture.
            // The real HTTPS/TLS code still authenticates the original hostname.
            const connect = net.Socket.prototype.connect;
            net.Socket.prototype.connect = function(...args) {
                const options = args[0];
                if(options && typeof options === 'object' && typeof options.lookup === 'function') {
                    const route = {host:options.host,port:Number(options.port)};
                    options.lookup(options.host,{all:true},(error,addresses)=>{route.addresses=addresses;route.error=error?.code;});
                    routed.push(route);
                    args[0] = config.routeCandidates ? {...options,port:config.routePort,lookup:(_host,lookupOptions,callback)=>callback(null,config.routeCandidates)} : {...options,host:'127.0.0.1',port:config.routePort,lookup:undefined};
                }
                return connect.apply(this,args);
            };
        }
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
                    const response = await openUpstream(config.endpoint || ${JSON.stringify(endpoint)}, {method:config.method || 'POST',headers:{Authorization:${JSON.stringify(`Bearer ${testKey}`)},'Content-Type':'application/json',Host:config.hostHeader || 'wrong.test','Proxy-Authorization':'do-not-forward'},body:config.method==='GET'?undefined:'{"test":"private payload"}',timeoutMs:config.timeoutMs || 1500,signal:controller.signal,proxyUrl:config.proxyUrl});
                    output={ok:true,status:response.statusCode,body:await readLimited(response)};
                } finally { clearTimeout(abortTimer); }
            }
        } catch(error) { output={ok:false,code:error.code || error.message,...(config.includeNetwork?{network:error.network}: {})}; }
        if(config.waitAfter) await new Promise(resolve=>setTimeout(resolve,config.waitAfter));
        console.log(JSON.stringify({...output,dnsCalls,...(config.routePort ? {routed} : {})}));
    `;
    const env = { ...process.env };
    delete env.NODE_EXTRA_CA_CERTS;
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (options.insecureEnvironment) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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
    await t.test('other origins still reject Fake-IP instead of bypassing private-address protection', async () => {
        assert.deepEqual(await child({ fakeDns: true, endpoint: 'https://other.example/v1/chat/completions' }), { ok: false, code: 'PRIVATE_ENDPOINT_FORBIDDEN', dnsCalls: 1 });
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

test('official OpenAI direct route supports only the common DNS Fake-IP pool with verified TLS', async t => {
    const certs = await certificates(t);
    for (const address of ['198.18.0.0', '198.18.0.2', '198.19.255.255']) assert.equal(isPublicAddress(address), false);
    for (const address of ['198.18.0.2', '198.19.255.254', '8.8.8.8']) {
        await t.test(`DNS answer ${address} stays pinned while using normal HTTPS identity`, async t => {
            const fixture = await proxyFixture(t, { tlsOptions: await certs.pair() });
            const dnsAnswers = [{ address, family: 4 }, { address: '8.8.4.4', family: 4 }];
            const result = await child({ dnsAnswers, routePort: fixture.targetPort }, { ca: certs.ca });
            assert.deepEqual(result, {
                ok: true, status: 200, body: '{"ok":true}', dnsCalls: 1,
                routed: [{ host: 'api.openai.com', port: 443, addresses: dnsAnswers }],
            });
            assert.equal(fixture.requests.length, 1);
            assert.equal(fixture.requests[0].headers.host, 'api.openai.com');
            assert.equal(fixture.requests[0].servername, 'api.openai.com');
            assert.equal(fixture.requests[0].headers.authorization, `Bearer ${testKey}`);
            assert.equal(fixture.requests[0].body, '{"test":"private payload"}');
            assert.equal(fixture.connects.length, 0);
        });
    }
    for (const [title, certificate, trust] of [['untrusted certificate', 'valid', false], ['trusted wrong-host certificate', 'wrong', true]]) {
        await t.test(`${title} blocks API data even with NODE_TLS_REJECT_UNAUTHORIZED=0`, async t => {
            const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(certificate) });
            const result = await child({ fakeDns: true, routePort: fixture.targetPort, insecureEnvironment: true, hostHeader: 'wrong.example.test' }, { ca: trust ? certs.ca : undefined });
            assert.equal(result.ok, false);
            assert.equal(result.code, 'UPSTREAM_CONNECTION_FAILED');
            assert.equal(result.dnsCalls, 1);
            assert.deepEqual(result.routed, [{ host: 'api.openai.com', port: 443, addresses: [{ address: '198.18.0.2', family: 4 }] }]);
            assert.equal(fixture.requests.length, 0);
            assert.equal(fixture.connects.length, 0);
        });
    }
    await t.test('private DNS answers and mixed allowed/private lists are rejected before connection', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair() });
        for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', '::ffff:198.18.0.1']) {
            const family = net.isIP(address);
            for (const dnsAnswers of [[{ address, family }], [{ address: '198.18.0.2', family: 4 }, { address, family }]]) {
                const result = await child({ dnsAnswers, routePort: fixture.targetPort });
                assert.deepEqual(result, { ok: false, code: 'PRIVATE_ENDPOINT_FORBIDDEN', dnsCalls: 1, routed: [] });
            }
        }
        assert.equal(fixture.requests.length, 0);
    });
    await t.test('Fake-IP exception does not include other domains, ports, HTTP or numeric URLs', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair() });
        for (const [target, code, dnsCalls] of [
            ['https://other.example/v1', 'PRIVATE_ENDPOINT_FORBIDDEN', 1],
            ['https://api.openai.com.evil.test/v1', 'PRIVATE_ENDPOINT_FORBIDDEN', 1],
            ['https://api.openai.com.:443/v1', 'PRIVATE_ENDPOINT_FORBIDDEN', 1],
            ['https://api.openai.com:444/v1', 'PRIVATE_ENDPOINT_FORBIDDEN', 1],
            ['http://api.openai.com/v1', 'HTTPS_REQUIRED', 0],
            ['https://198.18.0.2/v1', 'PRIVATE_ENDPOINT_FORBIDDEN', 0],
            ['https://198.19.255.254/v1', 'PRIVATE_ENDPOINT_FORBIDDEN', 0],
            ['https://localhost/v1', 'LOCAL_ENDPOINT_NOT_ENABLED', 0],
        ]) {
            assert.deepEqual(await child({ endpoint: target, fakeDns: true, routePort: fixture.targetPort }), { ok: false, code, dnsCalls, routed: [] });
        }
        assert.equal(fixture.requests.length, 0);
    });
    await t.test('direct Fake-IP response redirect is refused without another DNS query or socket', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (_req, res) => { res.writeHead(302, { location: 'https://api.openai.com/other' }); res.end(); } });
        const result = await child({ fakeDns: true, routePort: fixture.targetPort }, { ca: certs.ca });
        assert.equal(result.code, 'UPSTREAM_REDIRECT_FORBIDDEN');
        assert.equal(result.dnsCalls, 1);
        assert.equal(result.routed.length, 1);
        assert.equal(fixture.requests.length, 1);
        assert.equal(fixture.connects.length, 0);
    });
    await t.test('Agent check and budgeted generation use normal Fake-IP routing without a proxy setting', async t => {
        const fixture = await proxyFixture(t, { tlsOptions: await certs.pair(), responder: (req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(req.method === 'GET' ? { id: 'test-model', object: 'model' } : {
                usage: { prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 10 },
                choices: [{ message: { content: '{"expectedVersion":1,"reason":"fixture","operations":[]}' } }],
            }));
        } });
        const directory = path.join(certs.directory, 'direct-agent-state');
        await fs.mkdir(directory);
        const result = await child({ fakeDns: true, routePort: fixture.targetPort }, { ca: certs.ca, mode: 'agent', directory });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.dnsCalls, 2);
        assert.equal(result.routed.length, 2);
        for (const route of result.routed) assert.deepEqual(route, { host: 'api.openai.com', port: 443, addresses: [{ address: '198.18.0.2', family: 4 }] });
        assert.equal(result.check.ok, true);
        assert.equal(result.check.budgetConsumed, false);
        assert.equal(result.beforeCalls, 0);
        assert.equal(result.status.ledger.calls, 1);
        assert.equal(result.result.record.purpose, 'agent');
        assert.deepEqual(fixture.requests.map(req => [req.method, req.url]), [['GET', '/v1/models/test-model'], ['POST', '/v1/chat/completions']]);
        assert.equal(fixture.requests[0].body, '');
        for (const req of fixture.requests) {
            assert.equal(req.headers.host, 'api.openai.com');
            assert.equal(req.servername, 'api.openai.com');
        }
        assert.equal(fixture.connects.length, 0);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(testKey));
    });
});
