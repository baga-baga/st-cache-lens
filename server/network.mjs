import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

export class ServiceError extends Error {
    constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function isLoopback(host) {
    const value = host.replace(/^\[|\]$/g, '').toLowerCase();
    return value === 'localhost' || value === '::1' || /^127\./.test(value);
}

export function isPublicAddress(address) {
    const value = address.toLowerCase();
    if (net.isIP(value) === 4) {
        const [a, b] = value.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
            || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
    }
    if (net.isIP(value) === 6) {
        // Permit globally routable unicast only. Reject mapped IPv4 and local ranges.
        return /^[23][0-9a-f]{0,3}:/.test(value) && !value.startsWith('2001:db8:');
    }
    return false;
}

export function validateEndpoint(value, { allowLocal = false } = {}) {
    let url;
    try { url = new URL(value); } catch { throw new ServiceError('INVALID_ENDPOINT'); }
    if (url.username || url.password || url.hash || url.search) throw new ServiceError('ENDPOINT_CREDENTIALS_OR_QUERY_FORBIDDEN');
    const loopback = isLoopback(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && allowLocal && loopback))) throw new ServiceError('HTTPS_REQUIRED');
    if (loopback && !allowLocal) throw new ServiceError('LOCAL_ENDPOINT_NOT_ENABLED');
    const bare = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) && !isPublicAddress(bare) && !(allowLocal && loopback)) throw new ServiceError('PRIVATE_ENDPOINT_FORBIDDEN');
    return url;
}

/** Explicit local HTTP/Mixed proxy, restricted to the official OpenAI origin. */
export function validateProxyUrl(value, { endpoint } = {}) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw new ServiceError('PROXY_URL_INVALID');
    const input = value.trim();
    if (!input) return '';
    let target, proxy;
    try { target = new URL(endpoint); } catch { throw new ServiceError('PROXY_OPENAI_ONLY'); }
    if (target.origin !== 'https://api.openai.com' || target.username || target.password) {
        throw new ServiceError('PROXY_OPENAI_ONLY');
    }
    try { proxy = new URL(input); } catch { throw new ServiceError('PROXY_URL_INVALID'); }
    if (proxy.protocol !== 'http:' || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') {
        throw new ServiceError('PROXY_URL_INVALID');
    }
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(proxy.hostname.toLowerCase())) {
        throw new ServiceError('PROXY_LOOPBACK_REQUIRED');
    }
    // Match the original spelling: URL parsing otherwise accepts abbreviated/octal IPs
    // and hides an explicit default port. No hostname resolution is used for the proxy.
    const match = input.match(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/i);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new ServiceError('PROXY_URL_INVALID');
    const host = match[1].toLowerCase() === 'localhost' ? '127.0.0.1' : match[1];
    return `http://${host}:${Number(match[2])}/`;
}

/** CONNECT delegates destination DNS to the explicitly selected local proxy.
 * API credentials are sent only after TLS authenticates api.openai.com. */
function openViaProxy(url, { proxyUrl, method, headers, body, timeoutMs, signal }) {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
        let connectRequest, tunnelSocket, secureSocket, apiRequest, response, agent;
        let stopped = false;
        let tunnelEstablished = false;
        const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000;
        const timer = setTimeout(() => fail(new ServiceError('PROXY_TIMEOUT', 504)), deadline);
        const abort = () => fail(new ServiceError('PROXY_ABORTED', 499));
        function clearControls() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
        function destroyTransport() {
            apiRequest?.destroy();
            secureSocket?.destroy();
            tunnelSocket?.destroy();
            connectRequest?.destroy();
            agent?.destroy();
        }
        function fail(error) {
            if (stopped) return;
            stopped = true;
            clearControls();
            // Once headers are returned, propagate the error to the body reader too.
            response?.destroy(error);
            destroyTransport();
            reject(error);
        }
        function finish() {
            if (stopped) return;
            stopped = true;
            clearControls();
            destroyTransport();
        }
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try {
            connectRequest = http.request({
                hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
                port: Number(proxy.port || 80), method: 'CONNECT', path: 'api.openai.com:443',
                headers: { Host: 'api.openai.com:443' }, agent: false, maxHeaderSize: 16384,
            });
            connectRequest.once('error', () => fail(new ServiceError('PROXY_CONNECTION_FAILED', 502)));
            connectRequest.once('response', incoming => {
                incoming.resume();
                fail(new ServiceError(incoming.statusCode === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_REJECTED', 502));
            });
            connectRequest.once('connect', (incoming, socket, head) => {
                tunnelSocket = socket;
                if (stopped) { socket.destroy(); return; }
                if (incoming.statusCode !== 200) {
                    fail(new ServiceError(incoming.statusCode === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_REJECTED', 502));
                    return;
                }
                // TLS cannot have server data before this client sends ClientHello.
                if (head.length) { fail(new ServiceError('PROXY_CONNECT_REJECTED', 502)); return; }
                try {
                    secureSocket = tls.connect({
                        socket, servername: 'api.openai.com', rejectUnauthorized: true,
                        ALPNProtocols: ['http/1.1'],
                    });
                    secureSocket.once('error', () => fail(new ServiceError(tunnelEstablished ? 'UPSTREAM_CONNECTION_FAILED' : 'PROXY_TLS_FAILED', 502)));
                    secureSocket.once('secureConnect', () => {
                        if (stopped) return;
                        if (!secureSocket.authorized || tls.checkServerIdentity('api.openai.com', secureSocket.getPeerCertificate())) {
                            fail(new ServiceError('PROXY_TLS_FAILED', 502)); return;
                        }
                        tunnelEstablished = true;
                        try {
                            // The one-shot agent can only return this verified socket; it
                            // cannot open another socket, resolve the target or fall back.
                            agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
                            let supplied = false;
                            agent.createConnection = (_options, callback) => {
                                if (supplied || stopped) { callback(new ServiceError('PROXY_CONNECTION_FAILED', 502)); return; }
                                supplied = true;
                                return secureSocket;
                            };
                            const apiHeaders = { ...headers };
                            for (const key of Object.keys(apiHeaders)) {
                                if (['host', 'proxy-authorization', 'proxy-connection'].includes(key.toLowerCase())) delete apiHeaders[key];
                            }
                            apiHeaders.Host = 'api.openai.com';
                            apiRequest = https.request(url, { method, headers: apiHeaders, agent }, incomingResponse => {
                                if (stopped) { incomingResponse.destroy(); return; }
                                if (incomingResponse.statusCode >= 300 && incomingResponse.statusCode < 400) {
                                    incomingResponse.destroy();
                                    fail(new ServiceError('UPSTREAM_REDIRECT_FORBIDDEN', 502)); return;
                                }
                                response = incomingResponse;
                                response.once('end', finish);
                                response.once('close', finish);
                                resolve(response);
                            });
                            apiRequest.once('error', () => fail(new ServiceError('UPSTREAM_CONNECTION_FAILED', 502)));
                            apiRequest.end(body);
                        } catch { fail(new ServiceError('UPSTREAM_CONNECTION_FAILED', 502)); }
                    });
                } catch { fail(new ServiceError('PROXY_TLS_FAILED', 502)); }
            });
            connectRequest.end();
        } catch { fail(new ServiceError('PROXY_CONNECTION_FAILED', 502)); }
    });
}

/** One fixed destination, validated and DNS-pinned. Never follows redirects. */
export async function openUpstream(value, { method = 'POST', headers = {}, body, allowLocal = false, timeoutMs = 120000, signal, proxyUrl = '' } = {}) {
    const url = validateEndpoint(String(value), { allowLocal });
    const validatedProxy = validateProxyUrl(proxyUrl, { endpoint: url });
    if (validatedProxy) return openViaProxy(url, { proxyUrl: validatedProxy, method, headers, body, timeoutMs, signal });
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try { addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true }); }
    catch { throw new ServiceError('UPSTREAM_DNS_FAILED', 502); }
    if (!addresses.length || addresses.some(({address}) => !isPublicAddress(address) && !(allowLocal && isLoopback(hostname) && isLoopback(address)))) {
        throw new ServiceError('PRIVATE_ENDPOINT_FORBIDDEN');
    }
    const selected = addresses[0];
    return await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, {
            method, headers, signal, agent: false,
            lookup: (_name, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
        }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400) {
                response.resume(); reject(new ServiceError('UPSTREAM_REDIRECT_FORBIDDEN', 502));
            } else resolve(response);
        });
        request.setTimeout(timeoutMs, () => request.destroy(new ServiceError('UPSTREAM_TIMEOUT', 504)));
        request.on('error', error => reject(error instanceof ServiceError ? error : new ServiceError('UPSTREAM_CONNECTION_FAILED', 502)));
        request.end(body);
    });
}

export async function readLimited(stream, maxBytes = 1024 * 1024) {
    const chunks = []; let bytes = 0;
    for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > maxBytes) { stream.destroy(); throw new ServiceError('RESPONSE_TOO_LARGE', 502); }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}
