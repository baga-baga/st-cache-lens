// Official standard-tier price snapshot, deliberately separate from paid-call authorization.
export const OPENAI_STARTER = Object.freeze({
  interfaceType: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-6.1-terra', maxOutputTokens: 4096, currency: 'USD',
  input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25, cacheWrite30m: 1.25, cacheWrite12h: 2.5,
  source: 'https://developers.openai.com/api/docs/models/gpt-6.1-terra',
  updatedAt: '2026-11-12', tokenParameter: 'auto', reasoningEffort: 'low',
});

export function agentSetupError(code, status) {
  const messages = {
    OPENAI_CHAT_ENDPOINT_REQUIRED: '地址需要填完整，例如 https://api.openai.com/v1/chat/completions。可点“一键填写 OpenAI”。',
    MODEL_REQUIRED: '请填写模型名称，或点“一键填写 OpenAI”。',
    KEY_REQUIRED_FOR_ENDPOINT: '请在密钥框填写这个接口的 API Key。更换接口后不能复用旧接口密钥。',
    PRICED_BUDGET_REQUIRED: '请填写正数的 Agent 次数、费用上限，以及输入价、输出价、价格来源和日期。连接检查不需要预算。',
    AGENT_BUDGET_EXHAUSTED: 'Agent 的次数或费用预算已用尽；未继续调用模型。',
    AGENT_NOT_ENABLED: '请先保存 Agent 配置与预算。',
    AGENT_CHECK_UNSUPPORTED_INTERFACE: '此连接检查目前支持 OpenAI 兼容接口。Anthropic 请使用其对应配置。',
    AGENT_CHECK_OPENAI_ONLY: '此连接检查目前支持 OpenAI 兼容接口。Anthropic 可保存配置并在预算内调用。',
    INVALID_CHECK_MODEL: '请填写有效的完整模型 ID，例如 gpt-6.1-terra。',
    AUTHENTICATION_REJECTED: '密钥验证失败（401）。请检查 API Key 是否正确，以及是否属于当前接口。',
    MODEL_QUERY_PERMISSION_DENIED: '没有读取该模型的权限（403）。请检查 API Key 的模型读取权限；这不能证明生成接口是否可用。',
    MODEL_QUERY_INCONCLUSIVE: '未能确认模型可见性。请核对模型 ID；中转也可能不提供模型查询接口。未进行生成测试。',
    UPSTREAM_RATE_LIMIT: '服务商暂时限流，请稍后再检查。',
    AGENT_CHECK_RATE_LIMIT: '连接检查过于频繁，请一分钟后再试。',
    AGENT_CHECK_TIMEOUT: '连接检查超时，请检查酒馆服务器能否访问接口地址。',
    INVALID_ENDPOINT: '接口地址格式无效，请填写包含 https:// 的完整地址。',
  };
  if (messages[code]) return messages[code];
  if (/401/.test(code)) return '接口拒绝了密钥，请检查密钥是否正确，以及是否属于当前服务商。';
  if (/403/.test(code)) return '接口拒绝访问，请核对 API Key 的模型读取权限和账号权限；这不等于已验证生成不可用。';
  if (/404/.test(code)) return '服务商未返回该模型：核对模型 ID；部分兼容接口不提供模型查询，此检查无法证明生成是否可用。';
  if (/429/.test(code)) return '服务商暂时限流，请稍后再检查。';
  if (status === 404) return '未找到服务端功能。请安装或更新 Cache Lens 服务端组件、开启 enableServerPlugins，然后重启酒馆。';
  return `操作未完成（${code || 'HTTP ' + status}）。请检查地址、服务端安装状态与网络。`;
}
