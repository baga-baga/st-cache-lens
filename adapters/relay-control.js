import { stableStringify } from '../core/optimizer.js';

const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => stableStringify(a) === stableStringify(b);
const validVersion = v => (typeof v === 'string' && v.length > 0 && v.length < 256) || (Number.isSafeInteger(v) && v >= 0);
let serial = 0;
function validateState(state) {
    if (!state || typeof state.policy !== 'object' || !state.policy || Array.isArray(state.policy) || !validVersion(state.version)) throw new Error('Invalid relay policy state');
    if (state.inFlight !== undefined && (!Number.isSafeInteger(state.inFlight) || state.inFlight < 0)) throw new Error('Invalid relay request counter');
    return state;
}
function idle(state) { if (state.inFlight > 0) throw new Error('Relay request in progress; policy is locked'); }
function validateIntent(intent) {
    if (!intent || intent.schemaVersion !== 1 || !['prepared', 'applied', 'committed', 'compensated'].includes(intent.phase)
        || typeof intent.id !== 'string' || !intent.id || typeof intent.observerId !== 'string' || !intent.observerId
        || !intent.before || !intent.after || !validVersion(intent.expectedVersion)) throw new Error('Invalid durable policy intent');
    if (intent.appliedVersion !== undefined && !validVersion(intent.appliedVersion)) throw new Error('Invalid applied policy version');
}
export class PolicyTransactionError extends Error {
    constructor(code, message, recovery = null) { super(message); this.name = 'PolicyTransactionError'; this.code = code; this.recovery = recovery; }
}

/**
 * Recover a durable intent without overwriting concurrent configuration.
 * A prepared intent with an uncertain remote write is NOT sufficient ownership evidence.
 * onCompensated({state,intent}) may atomically rebase earlier active history to the new
 * remote version before the recovery journal is cleared.
 */
export async function recoverPolicyIntent({ intent, api, clearIntent, onCompensated = async () => {} } = {}) {
    validateIntent(intent);
    if (intent.phase === 'committed') {
        try { await clearIntent(intent.id); return { status: 'committed-cleanup', changed: false, intentPending: false }; }
        catch { return { status: 'committed-cleanup-pending', changed: false, intentPending: true }; }
    }
    let current;
    try { current = validateState(await api('get')); }
    catch { return { status: 'remote-unavailable', changed: false, intentPending: true }; }
    if (same(current.policy, intent.before)) {
        try {
            await onCompensated({ state: clone(current), intent: clone(intent) });
            await clearIntent(intent.id);
            return { status: 'already-restored', state: clone(current), changed: false, intentPending: false };
        } catch { return { status: 'already-restored-local-pending', state: clone(current), changed: false, intentPending: true }; }
    }
    if (intent.phase === 'compensated') return { status: 'concurrent-change', state: clone(current), changed: false, intentPending: true };
    if (!same(current.policy, intent.after)) return { status: 'concurrent-change', state: clone(current), changed: false, intentPending: true };
    if (intent.appliedVersion === undefined) return { status: 'uncertain-remote-ownership', state: clone(current), changed: false, intentPending: true };
    if (current.version !== intent.appliedVersion) return { status: 'concurrent-change', state: clone(current), changed: false, intentPending: true };
    if (current.inFlight > 0) return { status: 'request-in-progress', state: clone(current), changed: false, intentPending: true };
    try {
        const restored = validateState(await api('set', { policy: clone(intent.before), expectedVersion: current.version }));
        if (!same(restored.policy, intent.before)) return { status: 'unexpected-restore-response', changed: false, intentPending: true };
        try {
            await onCompensated({ state: clone(restored), intent: { ...clone(intent), phase: 'compensated', restoredVersion: restored.version } });
            await clearIntent(intent.id);
            return { status: 'restored', state: clone(restored), changed: true, intentPending: false };
        } catch { return { status: 'restored-local-pending', state: clone(restored), changed: true, intentPending: true }; }
    } catch { return { status: 'restore-failed-or-conflicted', changed: false, intentPending: true }; }
}

/**
 * The frontend and relay do not share a database transaction. This is a journaled
 * compare-and-swap with compensating restoration, and it deliberately reports partial
 * recovery instead of claiming distributed atomicity.
 *
 * api('get') -> {policy,version,inFlight}; api('set',{policy,expectedVersion}) -> same.
 * saveIntent(intent) must persist durably BEFORE resolving.
 * commitHistory(entry, committedIntent) MUST persist the history change AND committed
 * intent together in one local CAS. clearIntent removes only the matching intent ID.
 * A failed commitHistory must not leave an unreported partial local commit.
 */
export async function applyPolicyTransaction({ observerId, policy, expectedVersion, expectedPolicy,
    api, saveIntent, commitHistory, clearIntent, onCompensated = async () => {}, kind = 'apply', rollbackOf = null } = {}) {
    if (typeof observerId !== 'string' || !observerId || observerId.length > 128 || !validVersion(expectedVersion)) throw new Error('Observer and expected policy version required');
    if (!['apply', 'rollback'].includes(kind) || typeof policy !== 'object' || !policy || Array.isArray(policy)) throw new Error('Invalid policy transaction');
    for (const fn of [api, saveIntent, commitHistory, clearIntent, onCompensated]) if (typeof fn !== 'function') throw new Error('Transaction callbacks must be trusted functions');
    const before = validateState(await api('get'));
    idle(before);
    if (before.version !== expectedVersion || (expectedPolicy !== undefined && !same(before.policy, expectedPolicy))) throw new PolicyTransactionError('VERSION_CONFLICT', 'Relay policy changed; reload and review before applying.');
    if (same(before.policy, policy)) return { changed: false, state: clone(before), entry: null, intentPending: false };
    let intent = {
        schemaVersion: 1, id: 'relay-tx-' + Date.now() + '-' + (++serial), kind, observerId,
        before: clone(before.policy), after: clone(policy), expectedVersion: before.version,
        phase: 'prepared', createdAt: new Date().toISOString(), rollbackOf,
    };
    await saveIntent(clone(intent)); // no remote write is allowed before durable intent exists
    let stage = 'remote';
    try {
        const applied = validateState(await api('set', { policy: clone(policy), expectedVersion: before.version }));
        if (!same(applied.policy, policy) || applied.version === before.version) throw new Error('Unexpected relay policy response');
        intent = { ...intent, phase: 'applied', appliedVersion: applied.version };
        stage = 'local';
        await saveIntent(clone(intent));
        const entry = { id: intent.id, observerId, before: clone(before.policy), after: clone(policy), version: applied.version,
            previousVersion: before.version, at: intent.createdAt, kind, rollbackOf };
        const committedIntent = { ...clone(intent), phase: 'committed' };
        await commitHistory(clone(entry), committedIntent);
        // History and committed marker are now durable. Cleanup failure never undoes a committed change.
        let intentPending = false;
        try { await clearIntent(intent.id); } catch { intentPending = true; }
        return { changed: true, state: clone(applied), entry, intentPending };
    } catch {
        const recovery = await recoverPolicyIntent({ intent, api, clearIntent, onCompensated });
        const restored = ['restored', 'restored-local-pending', 'already-restored', 'already-restored-local-pending'].includes(recovery.status);
        throw new PolicyTransactionError(stage === 'remote' ? 'REMOTE_APPLY_FAILED' : 'LOCAL_COMMIT_FAILED',
            restored ? 'Policy transaction failed; the previous remote policy is restored. Check retained recovery status.' : 'Policy transaction is incomplete; recovery intent is retained and concurrent state was not overwritten.', recovery);
    }
}

export async function rollbackPolicyTransaction({ entry, ...options } = {}) {
    if (!entry || !entry.before || !entry.after || !validVersion(entry.version)) throw new Error('A versioned policy history entry is required');
    return applyPolicyTransaction({ ...options, observerId: entry.observerId, policy: entry.before, expectedVersion: entry.version,
        expectedPolicy: entry.after, kind: 'rollback', rollbackOf: entry.id });
}

/** Advance the remaining observer stack after a successful rollback changes its remote version. */
export function advanceHistoryAfterRollback(history, revertedEntry, restoredState) {
    validateState(restoredState);
    const result = clone(history);
    const indices = result.flatMap((entry, i) => entry.observerId === revertedEntry.observerId ? [i] : []);
    const index = indices.at(-1);
    if (index === undefined || result[index].id !== revertedEntry.id || !same(restoredState.policy, revertedEntry.before)) throw new Error('Policy rollback does not match the active observer history');
    result.splice(index, 1);
    const previous = [...result].reverse().find(entry => entry.observerId === revertedEntry.observerId);
    if (previous) {
        if (!same(previous.after, restoredState.policy)) throw new Error('Earlier observer policy history does not match restored policy');
        previous.version = restoredState.version;
    }
    return result;
}

/** A failed apply/compensated recovery still changes remote version; rebase the unchanged top policy. */
export function rebasePolicyHistory(history, observerId, remoteState) {
    validateState(remoteState);
    const result = clone(history), previous = [...result].reverse().find(entry => entry.observerId === observerId);
    if (previous) {
        if (!same(previous.after, remoteState.policy)) throw new Error('Cannot rebase history across a different remote policy');
        previous.version = remoteState.version;
    }
    return result;
}
