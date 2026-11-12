import { PROVIDER_RULES } from '../core/providers.js';
import { getInputSafetyBound } from './input-guard.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
export function validateCachePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Invalid cache policy');
  if (policy.enabled === false) return true;
  const keys = ['enabled', 'interfaceType', 'model', 'endpointVerified', 'stableSystemTexts', 'ttl', 'maximumInputTokens', 'rules'];
  if (Object.keys(policy).some(k => !keys.includes(k))) throw new Error('Unknown cache policy field');
  if (policy.enabled !== true || policy.interfaceType !== 'anthropic' || policy.endpointVerified !== true) throw new Error('Explicitly verified Anthropic Messages endpoint required');
  const rules = policy.rules;
  if (!rules || rules.protocol !== 'anthropic-messages' || rules.verified !== true || !rules.source?.startsWith('https://') || !/^\d{4}-\d{2}-\d{2}$/.test(rules.checkedAt ?? '')) throw new Error('Dated provider documentation required');
  if (!rules.models?.includes(policy.model) || !rules.ttls?.includes(policy.ttl) || !Number.isInteger(rules.minTokens) || rules.minTokens < 1 || !Number.isInteger(rules.maxBreakpoints) || rules.maxBreakpoints < 1 || rules.maxBreakpoints > 100) throw new Error('Unverified model, TTL, or limits');
  if (!Array.isArray(policy.stableSystemTexts) || !policy.stableSystemTexts.length || policy.stableSystemTexts.some(t => typeof t !== 'string' || !t.length) || policy.stableSystemTexts.join('').length > 2_000_000) throw new Error('Exact nonempty stable system blocks required');
  if (!Number.isSafeInteger(policy.maximumInputTokens) || policy.maximumInputTokens < 1) throw new Error('Input ceiling required');
  return true;
}

/** Adds one actual API block marker; never rewrites text or removes existing markers. */
export function transformRequest(body, { config, record = {} } = {}) {
  const policy = config?.cachePolicy;
  if (!policy?.enabled) return body;
  validateCachePolicy(policy);
  const skip = reason => { record.transformation = { applied: false, reason }; return body; };
  const refuse = (reason, statusCode = 413) => {
    record.transformation = { applied: false, requestBlocked: true, reason };
    throw Object.assign(new Error(reason), { statusCode, code: statusCode === 413 ? 'INPUT_LIMIT' : 'INPUT_BOUND_UNKNOWN' });
  };
  if (body.model !== policy.model || (config.interfaceType && config.interfaceType !== 'anthropic')) return skip('Model/protocol does not match policy');
  const bound = getInputSafetyBound(body, { interfaceType: 'anthropic' });
  if (!bound.supported) return refuse(bound.reason, 422);
  // Conservative safety bound, NOT an exact token count. Check even when the stable prefix has drifted.
  const upperBound = bound.upperBoundTokens;
  if (upperBound > policy.maximumInputTokens) return refuse('Conservative full-input bound exceeds ceiling');
  if (!Array.isArray(body.system) || body.system.length < policy.stableSystemTexts.length) return skip('System block boundaries differ');
  if (body.cache_control) return skip('Top-level automatic caching already present; do not silently combine');
  if (Array.isArray(body.tools) && body.tools.length) return skip('Tools precede system in the cache prefix; no stable tools snapshot is configured');
  for (const [i, text] of policy.stableSystemTexts.entries()) {
    if (body.system[i].type !== 'text' || body.system[i].text !== text) return skip('Stable prefix changed; no frozen content injected');
  }
  let count = 0;
  const countMarkers = value => {
    if (!value || typeof value !== 'object') return;
    if (value.cache_control) count++;
    Object.entries(value).forEach(([k, v]) => { if (k !== 'cache_control') Array.isArray(v) ? v.forEach(countMarkers) : countMarkers(v); });
  };
  countMarkers(body);
  const target = body.system[policy.stableSystemTexts.length - 1];
  if (target.cache_control) return skip('Target already has cache_control; preserved');
  if (count >= policy.rules.maxBreakpoints) return skip('No available breakpoint slots');
  // A new longer TTL after an existing shorter one would be invalid. Refuse mixed TTL insertion.
  const ttls = [];
  const scan = v => { if (!v || typeof v !== 'object') return; if (v.cache_control) ttls.push(v.cache_control.ttl ?? '5m'); Object.entries(v).filter(([k]) => k !== 'cache_control').forEach(([, x]) => Array.isArray(x) ? x.forEach(scan) : scan(x)); };
  scan(body);
  if (ttls.some(t => t !== policy.ttl)) return skip('Mixed existing TTLs require a dedicated verified policy');
  const out = clone(body);
  out.system[policy.stableSystemTexts.length - 1].cache_control = { type: 'ephemeral', ttl: policy.ttl };
  record.transformation = { applied: true, path: `system[${policy.stableSystemTexts.length - 1}].cache_control`, ttl: policy.ttl, inputBound: upperBound, minimumTokens: policy.rules.minTokens, minimumVerified: false, note: 'Valid marker placement is not cache-hit evidence. Minimum token threshold must be confirmed by provider usage.' };
  return out;
}

export const defaultAnthropicRules = PROVIDER_RULES.anthropic;
