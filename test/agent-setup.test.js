import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCacheLens } from '../index.js';
import { OPENAI_STARTER, agentSetupError } from '../adapters/agent-setup.js';

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
  let checkNetworkFailure = null;
  const context = { extensionSettings: {}, saveSettingsDebounced() {}, getWorldInfoNames: () => [] };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (missing) return new Response('<html>not installed</html>', { status: 404 });
    if (url.endsWith('/status')) return Response.json({ configured: false, serverVersion: '0.1.1', capabilities: { agentCheck: true } });
    if (url.endsWith('/agent-check')) return checkNetworkFailure ? Response.json(checkNetworkFailure, { status: 502 }) : Response.json(checkFailure || { ok: true, authenticationVerified: true, modelVisible: true, model: OPENAI_STARTER.model, generationVerified: false });
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
    checkNetworkFailure = { error: 'UPSTREAM_CONNECTION_FAILED', network: { version: 1, reason: 'ECONNRESET', phase: 'tls', route: 'direct', requestMayHaveBeenSent: false, responseHeadersReceived: false, elapsedMs: 84, message: 'synthetic-private-message', address: '192.0.2.1' } };
    await click('check-agent');
    assert.match(field('agentConnection').textContent, /ECONNRESET/);
    assert.match(field('agentConnection').textContent, /建立加密连接/);
    assert.doesNotMatch(field('agentConnection').textContent, /synthetic-private-message|192\.0\.2\.1/);
    checkNetworkFailure = null;
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


async function proxyPanel(run, { configured = false, config = null, proxySupported = true } = {}) {
  const dom = new JSDOM('<div id="extensions_settings2"></div>', { url: 'http://localhost:8000' });
  const old = {};
  for (const [key, value] of Object.entries({ document: dom.window.document, window: dom.window, localStorage: dom.window.localStorage, navigator: { locks: { request: async (name, options, fn) => (fn || options)() } } })) {
    old[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const fetchBefore = globalThis.fetch;
  const calls = [];
  const state = { configured, config, serverVersion: proxySupported ? '0.1.8' : '0.1.1', capabilities: { agentCheck: true, ...(proxySupported ? { agentProxy: true } : {}) } };
  const context = { extensionSettings: {}, saveSettingsDebounced() {}, getWorldInfoNames: () => [] };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith('/status')) return Response.json(state);
    if (url.endsWith('/agent-check')) return Response.json({ ok: true, authenticationVerified: true, modelVisible: true, model: OPENAI_STARTER.model });
    if (url.endsWith('/agent-config')) {
      const { apiKey, ...safe } = body;
      state.configured = true; state.config = { ...safe, hasKey: Boolean(apiKey) };
      return Response.json(state);
    }
    throw new Error('Unexpected API call ' + url);
  };
  const panel = mountCacheLens({ context, storageNamespace: 'agent-proxy', adapterFactory: () => ({ dispose() {}, getSnapshot: () => ({}) }) });
  try {
    await panel.ready;
    const root = document.getElementById('cache-lens-panel');
    const field = id => root.querySelector(`[data-id="${id}"]`);
    const click = async name => {
      const button = root.querySelector(`[data-action="${name}"]`);
      button.click();
      for (let i = 0; i < 100 && button.disabled; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(button.disabled, false, name + ' should finish');
    };
    const edit = (id, value) => {
      const input = field(id);
      if (input.type === 'checkbox') input.checked = value; else input.value = value;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    await run({ field, click, edit, calls, context, state });
  } finally {
    panel.dispose(); dom.window.close(); globalThis.fetch = fetchBefore;
    for (const [key, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

test('Clash proxy check and save retain official API, send explicit route, and clear route when unchecked', async () => {
  await proxyPanel(async ({ field, click, edit, calls, context }) => {
    assert.equal(field('agentProxyEnabled').checked, false);
    assert.equal(field('agentProxyURL').value, '');
    await click('preset-openai');
    edit('agentKey', 'synthetic-proxy-openai-key');
    edit('agentProxyEnabled', true); edit('agentProxyURL', ' http://127.0.0.1:17990 ');
    await click('check-agent');
    assert.equal(calls.at(-1).body.proxyUrl, 'http://127.0.0.1:17990');
    assert.equal(calls.at(-1).body.endpoint, OPENAI_STARTER.endpoint);
    assert.equal(calls.at(-1).body.allowLocal, false, 'Proxy permission is separate from local API permission');
    assert.match(field('agentConnection').textContent, /连接检查通过/);
    edit('agentCalls', '3'); edit('agentCost', '0.2');
    await click('save-agent');
    const saved = calls.find(c => c.url.endsWith('/agent-config')).body;
    assert.equal(saved.proxyUrl, 'http://127.0.0.1:17990');
    assert.equal(saved.apiKey, 'synthetic-proxy-openai-key');
    assert.equal(JSON.stringify(context.extensionSettings).includes('synthetic-proxy-openai-key'), false);
    assert.equal(field('agentKey').value, '');
    edit('agentProxyEnabled', false);
    await click('check-agent');
    assert.equal(calls.at(-1).body.proxyUrl, '', 'Explicit empty route clears saved proxy for check');
    await click('save-agent');
    assert.equal(calls.at(-1).body.proxyUrl, '', 'Explicit empty route clears persisted proxy');
    assert.equal(calls.some(c => c.url.endsWith('/agent')), false, 'Onboarding never generates');
  });
});

test('Clash proxy blocks older service before check/save, while proxy off preserves old five-field contract', async () => {
  await proxyPanel(async ({ field, click, edit, calls }) => {
    await click('preset-openai');
    edit('agentKey', 'synthetic-proxy-openai-key');
    edit('agentProxyEnabled', true); edit('agentProxyURL', 'http://127.0.0.1:17990');
    const before = calls.length;
    await click('save-agent');
    assert.equal(calls.length, before, 'Zero budget save remains local, including with proxy selected');
    await click('check-agent');
    assert.match(field('agentConnection').textContent, /当前服务端尚不支持 Clash 代理/);
    assert.match(field('agentConnection').textContent, /重启酒馆/);
    assert.equal(calls.some(c => c.url.endsWith('/agent-check')), false);
    edit('agentCalls', '2'); edit('agentCost', '0.1');
    await click('save-agent');
    assert.match(field('agentStatus').textContent, /当前服务端尚不支持 Clash 代理/);
    assert.equal(calls.some(c => c.url.endsWith('/agent-config')), false);
    edit('agentProxyEnabled', false);
    await click('check-agent');
    assert.deepEqual(Object.keys(calls.at(-1).body).sort(), ['allowLocal', 'apiKey', 'endpoint', 'interfaceType', 'model']);
    await click('save-agent');
    assert.equal(Object.hasOwn(calls.at(-1).body, 'proxyUrl'), false);
  }, { proxySupported: false });
});

test('Clash proxy hydration restores saved route but preserves an edited proxy draft', async () => {
  const config = { ...OPENAI_STARTER, interfaceType: 'openai', model: OPENAI_STARTER.model, hasKey: true, proxyUrl: 'http://127.0.0.1:17990', allowLocal: false, prices: { input: 1, output: 5, currency: 'USD' } };
  await proxyPanel(async ({ field, click }) => {
    await click('check-server');
    assert.equal(field('agentEndpoint').value, OPENAI_STARTER.endpoint);
    assert.equal(field('agentProxyURL').value, config.proxyUrl);
    assert.equal(field('agentProxyEnabled').checked, true);
    assert.equal(field('agentProxyDetails').open, true, 'Saved manual proxy remains visible');
    assert.match(field('agentStatus').textContent, /已保存连接方式：手动本机代理/);
    assert.equal(field('agentKey').value, '');
  }, { configured: true, config });
  await proxyPanel(async ({ field, click, edit, calls }) => {
    edit('agentProxyEnabled', false); edit('agentProxyURL', 'http://127.0.0.1:18080');
    await click('check-server');
    assert.equal(field('agentProxyURL').value, 'http://127.0.0.1:18080');
    assert.equal(field('agentProxyEnabled').checked, false);
    await click('check-agent');
    assert.equal(calls.at(-1).body.proxyUrl, '');
    assert.match(field('agentConnection').textContent, /连接方式：沿用设备网络/);
  }, { configured: true, config });
});

test('Enabled Clash proxy requires a port without silently choosing one', async () => {
  await proxyPanel(async ({ field, click, edit, calls }) => {
    await click('preset-openai'); edit('agentKey', 'synthetic-proxy-openai-key'); edit('agentProxyEnabled', true);
    await click('check-agent');
    assert.match(field('agentConnection').textContent, /实际端口/);
    assert.equal(calls.some(c => c.url.endsWith('/agent-check')), false);
    assert.equal(field('agentProxyURL').value, '');
  });
});

test('OpenAI quick preset before server check retains saved proxy without inheriting a different endpoint route', async () => {
  const config = { ...OPENAI_STARTER, hasKey: true, proxyUrl: 'http://127.0.0.1:17990', prices: { input: 1, output: 5, currency: 'USD' } };
  await proxyPanel(async ({ field, click, edit, calls }) => {
    await click('preset-openai');
    assert.equal(field('agentProxyEnabled').checked, false, 'Preset alone has not fetched saved configuration');
    await click('check-agent');
    assert.equal(field('agentProxyEnabled').checked, true);
    assert.equal(calls.at(-1).body.proxyUrl, config.proxyUrl, 'Checking restores the saved route even after preset fills endpoint');
    edit('agentCalls', '2'); edit('agentCost', '0.1');
    await click('save-agent');
    assert.equal(calls.at(-1).body.proxyUrl, config.proxyUrl, 'Saving must not silently erase the restored route');
  }, { configured: true, config });
  await proxyPanel(async ({ field, click, edit, calls }) => {
    edit('agentEndpoint', 'https://other-provider.invalid/v1/chat/completions');
    edit('agentModel', 'other-model');
    await click('check-agent');
    assert.equal(field('agentProxyEnabled').checked, false);
    assert.equal(field('agentProxyURL').value, '');
    assert.equal(calls.at(-1).body.proxyUrl, '', 'A different endpoint does not inherit the OpenAI proxy');
  }, { configured: true, config });
});

test('Clash errors explain DNS guard, local proxy, and TLS without suggesting Fake-IP shutdown', () => {
  assert.match(agentSetupError('PRIVATE_ENDPOINT_FORBIDDEN'), /不是你的公网出口 IP/);
  assert.match(agentSetupError('PRIVATE_ENDPOINT_FORBIDDEN'), /不能仅凭此错误确定原因/);
  assert.match(agentSetupError('PRIVATE_ENDPOINT_FORBIDDEN'), /无需关闭 Fake-IP/);
  for (const code of ['PROXY_URL_INVALID', 'PROXY_LOOPBACK_REQUIRED', 'PROXY_OPENAI_ONLY', 'PROXY_CONNECTION_FAILED', 'PROXY_AUTH_REQUIRED', 'PROXY_CONNECT_REJECTED', 'PROXY_TLS_FAILED', 'PROXY_TIMEOUT', 'PROXY_ABORTED']) {
    const message = agentSetupError(code);
    assert.equal(message.includes('操作未完成（'), false, code + ' must have an actionable message');
    assert.equal(message.includes('关闭 Fake-IP'), false);
  }
  assert.match(agentSetupError('PROXY_TLS_FAILED'), /不会跳过证书验证/);
  assert.match(agentSetupError('PROXY_TIMEOUT'), /不会自动改走直连/);
});
