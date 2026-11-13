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
| 返回独立写入量的 OpenAI Chat/Responses | 总输入 − 读取 − 写入 | `prompt_tokens` 或 `input_tokens` | `cache_write_tokens_details` 可含 30m/12h；细分与汇总不可重复计费。 |
| DeepSeek | `prompt_cache_miss_tokens`，或总输入 − 命中 | `prompt_tokens` | 缓存未命中不是 Anthropic 的溢价缓存创建。 |

统一展示的**缓存读取比例 = 缓存读取 tokens ÷ 总输入 tokens**。零输入、不完整或互相矛盾的 usage 不能产生可信比例。缺失字段显示未知，不把未知当零。

费用按各互斥 token 桶乘对应“每百万 tokens”价格后相加。价格必须包含币种、来源和更新时间。正文、摘要、优化 Agent 分组后再合计；不同币种不可直接加总。usage 计算出来的是按所填价格估算的费用，平台账单另列，不能冒充扣款凭证。长上下文阶梯、促销、渠道加价、税费若没有完整规则，应以平台账单核对。

## 150 万 tokens 的解释

整书全部内容量、配置的预算上限、本轮激活条目量、最终发送输入量是四个不同数值。150 万这个孤立数字不能确定实际请求超限，也不能证明实际发送了整本书。诊断页面保留这些数值的来源与计数方法；没有观测的项显示未知。估算不能标为 tokenizer 精确值。

批量扫描中的整书总量使用 UTF-8 字节估算，包含停用条目；这不是整书将被发送的计划。配置预算按世界书占比、正数 token cap 与配置上下文推导，激活事件只说明事件中有哪些条目；provider usage 的总输入还包含预设和历史等其他内容。因此缺少精确归因时，“世界书单独最终发送 tokens”仍未知。

跨角色排序的输入保护另外使用**完整请求序列化字节数加开销**作为保守上界，不使用“字节除以某个系数”的整书估算来放行。酒馆本地 tokenizer 计数也不能自动标作最终供应商的精确输入。长中文请求常出现“保守上界超过限制、真实 tokens 可能未超过”的情况；策略会跳过，不能把此结果写成供应商已经报告超限，更不能提高实际模型上下文限制绕过保护。

未经用户设置预算，不发起额外的付费优化请求或缓存预热。离线回放不联网；被动观察只跟随用户正常请求。单纯为了让曲线变好而扩充常驻资料或重复调用，不属于本包的优化目标。

## OpenAI Agent 接入快照（0.1.1）

一键配置选 `gpt-6.1-terra`，标准短上下文价格每百万输入 $1、读取 $0.05、输出 $5，缓存创建30分钟 $1.25 /12小时 $2.50；核对日期2026-11-12。Agent诊断体限制24KiB，不上传整本世界书。

官方依据：[Terra模型](https://developers.openai.com/api/docs/models/gpt-6.1-terra)、[Chat Completions参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[模型查询](https://developers.openai.com/api/reference/resources/models/methods/retrieve)。官方请求使用 `service_tier: default`、`max_completion_tokens`；一键配置推理low、上限4096（包含推理token）。这只是起步设置，实际效果和费用需正常观察，不能凭型号宣布最优。

连接检查只 GET 查询模型，不发生成请求。官方精确端点依据已核验的鉴权接口返回认证状态；自定义兼容接口可能公开模型信息，因此不会把模型可见等同密钥已校验。
