import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCacheLens } from '../index.js';
import { OPENAI_STARTER } from '../adapters/agent-setup.js';

test('Agent onboarding: preset, zero-budget model check, explicit saving, and helpful missing-server errors', async () => {
  const dom = new JSDOM('<div id="extensions_settings2"></div>', { url: 'http://localhost:8000' });
  const old = {};
  for (const [key, value] of Object.entries({ document: dom.window.document, window: dom.window, localStorage: dom.window.localStorage, navigator: { locks: { request: async (name, options, fn) => (fn || options)() } } })) {
    old[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const fetchBefore = globalThis.fetch;
  const calls = [];
  let missing = false;
  let checkFailure = null;
  const context = { extensionSettings: {}, saveSettingsDebounced() {}, getWorldInfoNames: () => [] };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (missing) return new Response('<html>not installed</html>', { status: 404 });
    if (url.endsWith('/status')) return Response.json({ configured: false, serverVersion: '0.1.1', capabilities: { agentCheck: true } });
    if (url.endsWith('/agent-check')) return Response.json(checkFailure || { ok: true, authenticationVerified: true, modelVisible: true, model: OPENAI_STARTER.model, generationVerified: false });
    if (url.endsWith('/agent-config')) return Response.json({ configured: true, config: { model: OPENAI_STARTER.model, hasKey: true } });
    throw new Error('Unexpected API call ' + url);
  };
  const panel = mountCacheLens({ context, storageNamespace: 'agent-onboarding', adapterFactory: () => ({ dispose() {}, getSnapshot: () => ({}) }) });
  try {
    await panel.ready;
    const root = document.getElementById('cache-lens-panel');
    const field = id => root.querySelector(`[data-id="${id}"]`);
    const click = async name => { root.querySelector(`[data-action="${name}"]`).click(); await new Promise(resolve => setTimeout(resolve, 30)); };
    field('agentEndpoint').value = 'https://another-provider.invalid/v1/chat/completions';
    field('agentKey').value = 'synthetic-other-provider-key';
    await click('preset-openai');
    assert.equal(field('agentEndpoint').value, OPENAI_STARTER.endpoint);
    assert.equal(field('agentModel').value, OPENAI_STARTER.model);
    assert.equal(field('agentKey').value, '', 'Changing provider must not keep its key in the UI');
    assert.equal(field('agentCalls').value, '0');
    assert.equal(field('agentCost').value, '0');
    assert.equal(calls.length, 0, 'Preset never sends a request or authorizes spending');
    field('agentKey').value = 'synthetic-openai-only-key';
    await click('check-agent');
    assert.equal(calls.filter(c => c.url.endsWith('/agent-check')).length, 1);
    assert.deepEqual(Object.keys(calls.at(-1).body).sort(), ['allowLocal', 'apiKey', 'endpoint', 'interfaceType', 'model']);
    assert.match(field('agentConnection').textContent, /连接检查通过/);
    assert.match(field('agentConnection').textContent, /尚未进行生成或余额验证/);
    assert.equal(context.extensionSettings.cache_lens.maxCost, 0);
    assert.equal(JSON.stringify(context.extensionSettings).includes('synthetic-openai-only-key'), false);
    for (const [code, httpStatus, message] of [['AUTHENTICATION_REJECTED', 401, /密钥验证失败/], ['MODEL_QUERY_PERMISSION_DENIED', 403, /读取该模型的权限/], ['MODEL_QUERY_INCONCLUSIVE', 404, /中转也可能不提供/]]) {
      checkFailure = { ok: false, code, httpStatus, modelVisible: null };
      await click('check-agent');
      assert.match(field('agentConnection').textContent, message);
      assert.equal(field('agentConnection').textContent.includes('连接检查通过'), false);
    }
    checkFailure = null;
    await click('save-agent');
    assert.equal(calls.filter(c => c.url.endsWith('/agent-config')).length, 0);
    assert.match(field('agentStatus').textContent, /正数/);
    field('agentCalls').value = '2'; field('agentCost').value = '0.10';
    await click('save-agent');
    assert.equal(calls.filter(c => c.url.endsWith('/agent-config')).length, 1);
    assert.equal(field('agentKey').value, '');
    assert.equal(context.extensionSettings.cache_lens.maxCost, 0.1);
    assert.equal(context.extensionSettings.cache_lens.maxTests, 2);
    assert.equal(field('maxTests').value, '2');
    assert.equal(field('maxCost').value, '0.1');
    assert.equal(JSON.stringify(context.extensionSettings).includes('synthetic-openai-only-key'), false);
    assert.equal(calls.some(c => c.url.endsWith('/agent')), false, 'Setup never performs generation');
    missing = true;
    await click('check-server');
    assert.match(field('agentConnection').textContent, /安装或更新/);
    assert.match(field('agentConnection').textContent, /重启酒馆/);
    assert.equal(field('agentConnection').textContent.includes('<html>'), false);
  } finally {
    panel.dispose(); dom.window.close(); globalThis.fetch = fetchBefore;
    for (const [key, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
