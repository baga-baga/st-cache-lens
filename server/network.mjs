import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

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

/** One fixed destination, validated and DNS-pinned. Never follows redirects. */
export async function openUpstream(value, { method = 'POST', headers = {}, body, allowLocal = false, timeoutMs = 120000, signal } = {}) {
    const url = validateEndpoint(String(value), { allowLocal });
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
