# 接口规则与费用口径

核验日期：2026-11-12。规则应随提供商文档更新；**中转协议相似不等于缓存语义相同**。应同时确认接口类型、上游能力及返回的真实 usage。模型显示名不能单独证明功能支持。

## 当前官方依据

| 接口 | 官方来源 | 本包处理原则 |
| --- | --- | --- |
| Anthropic Messages | [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | 缓存作用于累计前缀，顺序为 tools → system → messages；显式字段必须在允许的内容块上。官方当前说明 4 个显式断点、20 个位置回看，TTL 为 5 分钟或 1 小时。Opus 5.5 当前官方最低可缓存长度为 512 tokens；其他型号/平台阈值不同。规则是注明日期的配置，不从提示词正文识别“已启用缓存”。 |
| OpenAI | [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) | 新旧模型与 Responses / Chat Completions 的能力有差别。兼容端点不得直接套用 Anthropic `cache_control`。较新 Responses usage 可以分开返回缓存写入与读取；未支持的选项保持只读。 |
| DeepSeek | [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)、[API usage](https://api-docs.deepseek.com/api/create-completion/) | 官方缓存自动管理。`prompt_cache_hit_tokens` 和 `prompt_tokens_details.cached_tokens` 是同一份命中数，不能相加；`prompt_tokens` 包含命中和未命中部分。摘要请求单独计入摘要用途。 |
| SillyTavern 服务端 | [Configuration File](https://docs.sillytavern.app/administration/config-yaml/)、[已核验源码](./COMPATIBILITY.md) | 客户端参数经过服务端转换。必须确认最终请求结构；仅检查前端事件不构成最终断点证据。 |

缓存读取的必要条件还涉及已有可复用缓存、TTL、实际路由/租户隔离及特定请求设置。稳定前缀和结构合法的断点是本地可验证事实；它们不能证明服务商本轮已经命中。

## usage 归一化

| usage 类型 | 普通输入 | 总输入 | 注意 |
| --- | --- | --- | --- |
| Anthropic | `input_tokens` | 普通输入 + `cache_creation_input_tokens` + `cache_read_input_tokens` | 缓存写入细分 5m/1h 时，细分之和不能再次叠加到总创建量。 |
| 传统 OpenAI Chat/Responses | 总输入 − `cached_tokens` | `prompt_tokens` 或 `input_tokens` | 缓存读取已包含在总输入中。 |
| 返回独立写入量的 OpenAI Responses | 总输入 − 读取 − 写入 | `input_tokens` | `cache_write_tokens_details` 可含 30m/12h；细分与汇总不可重复计费。 |
| DeepSeek | `prompt_cache_miss_tokens`，或总输入 − 命中 | `prompt_tokens` | 缓存未命中不是 Anthropic 的溢价缓存创建。 |

统一展示的**缓存读取比例 = 缓存读取 tokens ÷ 总输入 tokens**。零输入、不完整或互相矛盾的 usage 不能产生可信比例。缺失字段显示未知，不把未知当零。

费用按各互斥 token 桶乘对应“每百万 tokens”价格后相加。价格必须包含币种、来源和更新时间。正文、摘要、优化 Agent 分组后再合计；不同币种不可直接加总。usage 计算出来的是按所填价格估算的费用，平台账单另列，不能冒充扣款凭证。长上下文阶梯、促销、渠道加价、税费若没有完整规则，应以平台账单核对。

## 150 万 tokens 的解释

整书全部内容量、配置的预算上限、本轮激活条目量、最终发送输入量是四个不同数值。150 万这个孤立数字不能确定实际请求超限，也不能证明实际发送了整本书。诊断页面保留这些数值的来源与计数方法；没有观测的项显示未知。估算不能标为 tokenizer 精确值。

未经用户设置预算，不发起额外的付费优化请求或缓存预热。离线回放不联网；被动观察只跟随用户正常请求。单纯为了让曲线变好而扩充常驻资料或重复调用，不属于本包的优化目标。
