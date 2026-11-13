import { hasBalancedTags, profileFingerprint } from '../core/optimizer.js';
import { hasUnsupportedContent } from '../core/providers.js';

const copy = v => JSON.parse(JSON.stringify(v));

// String leaves only. No role promotion, message movement, new injection, or stale snapshot injection.
export function textSlots(body) {
  const slots = [];
  const add = (parent, key, scope, role) => {
    if (typeof parent[key] === 'string') slots.push({ parent, key, scope, role, text: parent[key] });
  };
  if (typeof body.system === 'string') add(body, 'system', 'system', 'system');
  if (Array.isArray(body.system)) body.system.forEach((b, i) => add(b, 'text', `system.${i}.text`, 'system'));
  for (const [i, m] of (body.messages || []).entries()) {
    if (typeof m.content === 'string') add(m, 'content', `messages.${i}.content`, m.role);
    else if (Array.isArray(m.content)) m.content.forEach((b, j) => add(b, 'text', `messages.${i}.content.${j}.text`, m.role));
  }
  return slots;
}

export function eligibleSources(body, sources) {
  const slots = textSlots(body);
  return sources.flatMap((s, i) => {
    const text = s.text ?? s.content;
    const kind = s.kind ?? s.type;
    if (typeof text !== 'string' || text.length < 8 || !['worldbook', 'world_info', 'world-info', 'preset'].includes(kind) || !hasBalancedTags(text)) return [];
    const hits = slots.filter(slot => slot.text.includes(text));
    if (hits.length !== 1 || hits[0].text.indexOf(text) !== hits[0].text.lastIndexOf(text)) return [];
    const slot = hits[0];
    return [{ id: String(s.id ?? `fragment-${i}`), content: text, role: slot.role, scope: slot.scope, approvedIndependent: false, stable: false, cacheable: true, source: { kind: kind.startsWith('world') ? 'worldbook' : kind, name: s.name ?? s.label ?? s.id }, offset: slot.text.indexOf(text) }];
  }).sort((a, b) => a.scope.localeCompare(b.scope) || a.offset - b.offset);
}

export function transformWithProfile(body, profile, { record, binding } = {}) {
  if (!profile || profile.mode === 'diagnose' || !profile.blocks?.length) return body;
  const skip = reason => { if (record) record.structureTransformation = { applied: false, reason }; return body; };
  if (profile.binding && ['chatId', 'model', 'provider', 'purpose'].some(key => profile.binding[key] !== binding?.[key])) return skip('Request does not match the approved chat/model/provider/purpose scope');
  if (profile.binding && ['characterId','groupId'].some(key => profile.binding[key]!==undefined&&(profile.binding[key]===null?binding?.[key]!==null:String(profile.binding[key])!==String(binding?.[key])))) return skip('Request does not match the approved character/group scope');
  const limits = profile.limits || {};
  if (!Number.isSafeInteger(limits.maxInputTokens) || limits.maxInputTokens <= 0 || !Number.isSafeInteger(limits.contextTokens) || limits.contextTokens <= 0) return skip('Explicit input and context limits are required');
  const reserve = limits.outputReserveTokens ?? 0;
  if (!Number.isSafeInteger(reserve) || reserve < 0) return skip('Invalid output reserve');
  if (hasUnsupportedContent(body)) return skip('Unsupported non-text content prevents a conservative input bound');
  // Re-check every live request; a preview count cannot authorize larger later requests.
  // UTF-8 JSON bytes + framing reserve is an intentionally loose bound, never an exact tokenizer count.
  const inputBound = new TextEncoder().encode(JSON.stringify(body)).length + 4096;
  if (inputBound > Math.min(limits.maxInputTokens, limits.contextTokens - reserve)) return skip('Full live-input byte bound exceeds input/context limit');
  const out = copy(body);
  let appliedGroups = 0;
  for (const slot of textSlots(out)) {
    const desired = profile.blocks.filter(b => b.scope === slot.scope && b.role === slot.role);
    if (desired.length < 2) continue;
    if (desired.some(b => b.approvedIndependent !== true || !hasBalancedTags(b.content) || !['worldbook', 'preset'].includes(b.source?.kind))) continue;
    const ranges = desired.map(b => ({ b, start: slot.text.indexOf(b.content), end: slot.text.indexOf(b.content) + b.content.length }));
    // Any changed, removed, or ambiguous fragment invalidates the entire group. Never freeze dynamic data.
    if (ranges.some(r => r.start < 0 || slot.text.lastIndexOf(r.b.content) !== r.start)) continue;
    ranges.sort((a, b) => a.start - b.start);
    const separators = [];
    let safe = true;
    for (let i = 1; i < ranges.length; i++) {
      const gap = slot.text.slice(ranges[i - 1].end, ranges[i].start);
      if (ranges[i].start < ranges[i - 1].end || !/^\s*$/.test(gap)) { safe = false; break; }
      separators.push(gap);
    }
    if (!safe) continue;
    // Whitespace separators are preserved byte-for-byte at their original boundaries.
    const middle = desired.map((b, i) => b.content + (separators[i] ?? '')).join('');
    slot.parent[slot.key] = slot.text.slice(0, ranges[0].start) + middle + slot.text.slice(ranges.at(-1).end);
    if (slot.parent[slot.key] !== slot.text) appliedGroups++;
  }
  if (record) record.structureTransformation = { applied: appliedGroups > 0, appliedGroups, inputBound, countMethod: 'conservative-utf8-byte-bound' };
  return out;
}

export function localCandidate(profile) {
  const groups = new Map();
  for (const block of profile.blocks) {
    const key = block.role + '\0' + block.scope;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(block);
  }
  const operations = [];
  for (const group of groups.values()) {
    if (group.length < 2 || group.some(b => !b.approvedIndependent)) continue;
    const ordered = [...group].sort((a, b) => Number(b.stable) - Number(a.stable));
    if (ordered.some((b, i) => b.id !== group[i].id)) operations.push({ type: 'reorder_blocks', role: group[0].role, scope: group[0].scope, ids: ordered.map(b => b.id) });
  }
  return { schemaVersion: 1, expectedVersion: profile.version, reason: '把已授权的独立同级稳定资料排在动态召回资料之前；内容与触发规则不变。', sources: [...new Set(profile.blocks.map(b => b.source?.name).filter(Boolean))], operations };
}

export function profileContext(profile) {
  return {
    schemaVersion: 1, expectedVersion: profile.version, fingerprint: profileFingerprint(profile), limits: profile.limits,
    blocks: profile.blocks.map(({ content, ...b }) => ({ ...b, chars: content.length })),
    allowedOperations: ['reorder_blocks'],
    example: { schemaVersion: 1, expectedVersion: profile.version, reason: 'reason', operations: [{ type: 'reorder_blocks', scope: 'exact scope from blocks', role: 'system', ids: ['complete permutation of sibling IDs'] }] }
  };
}
