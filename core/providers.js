// Documentation snapshots are versioned data, never inferred from a model's name.
export const PROVIDER_RULES = Object.freeze({
  anthropic: {
    protocol: 'anthropic-messages', verified: true,
    source: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
    checkedAt: '2026-11-12', models: ['claude-opus-5-5'],
    minTokens: 512, maxBreakpoints: 4, lookbackBlocks: 20, ttls: ['5m', '1h'],
    note: 'Only the documented Claude Messages interface. Intermediaries must explicitly confirm compatibility; no automatic model-alias inference.'
  },
  openai: {
    source: 'https://developers.openai.com/api/docs/guides/prompt-caching', checkedAt: '2026-11-12',
    note: 'Usage reading only. New Responses models have explicit breakpoints and write TTLs; generic OpenAI-compatible services do not inherit these capabilities. This version does not inject OpenAI cache fields.'
  },
  deepseek: {
    source: 'https://api-docs.deepseek.com/guides/kv_cache/', checkedAt: '2026-11-12',
    note: 'Read hit/miss counters. Cache is provider managed; do not inject Anthropic cache_control.'
  }
});

export function hasUnsupportedContent(body) {
  if(!body || typeof body!=='object') return true;
  if(body.previous_response_id || body.conversation || body.context_management) return true;
  const content=value=>typeof value==='string'||(Array.isArray(value)&&value.every(b=>b&&['text','input_text','output_text'].includes(b.type)&&typeof b.text==='string'));
  if(body.system!==undefined&&!content(body.system))return true;
  if(body.messages!==undefined&&(!Array.isArray(body.messages)||body.messages.some(m=>!content(m.content))))return true;
  if(body.input!==undefined&&typeof body.input!=='string'&&(!Array.isArray(body.input)||body.input.some(m=>!content(m.content))))return true;
  if(body.tools?.some(t=>!(t.type==='function'||(typeof t.name==='string'&&t.input_schema))))return true;
  return false;
}
