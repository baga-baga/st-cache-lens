import { AgentService } from './agent.mjs';
import { ServiceError } from './network.mjs';
import { sanitizeNetworkDiagnostic } from '../core/network-diagnostics.js';

export const info = {
    id: 'cache-lens',
    name: 'Cache Lens Agent & Observer',
    description: 'Per-user bounded Agent requests and authenticated loopback relay observations. No core patches.',
};

const services = new Map();
export function serviceForRequest(request) {
    const root = request.user?.directories?.root;
    if (typeof root !== 'string' || !root) throw new ServiceError('AUTHENTICATED_USER_REQUIRED', 401);
    if (!services.has(root)) services.set(root, new AgentService(root));
    return services.get(root);
}

function route(action, maxBodyBytes = 65536) {
    return async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        try {
            const service = serviceForRequest(request);
            if (request.body && Buffer.byteLength(JSON.stringify(request.body)) > maxBodyBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 413);
            response.json(await action(service, request));
        } catch (error) {
            // Never reflect upstream errors, user text, endpoints, request headers or keys.
            const body = { error: error instanceof ServiceError ? error.code : 'CACHE_LENS_SERVER_ERROR' };
            const network = error instanceof ServiceError ? sanitizeNetworkDiagnostic(error.network) : null;
            if (network) body.network = network;
            response.status(error instanceof ServiceError ? error.status : 500).json(body);
        }
    };
}

/** ST supplies authenticated req.user and CSRF protection before plugin routes. */
export async function init(router) {
    router.get('/status', route(service => service.status()));
    router.post('/agent-config', route((service, request) => service.configure(request.body)));
    router.post('/agent-check', route((service, request) => service.checkAgent(request.body), 8192));
    router.post('/observer-config', route((service, request) => service.configureObserver(request.body)));
    router.post('/agent', route((service, request) => service.run(request.body)));
    router.get('/agent-records', route(async service => { await service.load(); return { records: structuredClone(service.state.records) }; }));
    router.post('/agent-reset-budget', route((service, request) => {
        if (request.body?.confirm !== 'RESET') throw new ServiceError('EXPLICIT_RESET_REQUIRED');
        return service.resetBudget();
    }));
    router.get('/relay-records', route(service => service.relayRecords()));
    router.get('/relay-policy', route((service, request) => service.relayRequest('policy', { observerId: request.query?.observerId ?? 'main' })));
    router.post('/relay-policy', route((service, request) => service.relayRequest('policy', { method: 'POST', body: request.body, observerId: request.query?.observerId ?? 'main' }), 4 * 1024 * 1024));
}

export async function exit() { services.clear(); }
