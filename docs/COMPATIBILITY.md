# 兼容范围与源码核验

基础核验日期：2026-11-12；批量读取接口于 2026-11-13 再核验。源码基线是 **SillyTavern 1.19.0**，官方 `release` 分支提交 `06bde939fb1e9c4c8d8641d810f0a916b5bce127`。本包要求 Node.js 20 或更新版本，无额外运行时 npm 依赖。后续版本不能仅凭版本号认定完全兼容。

完整开发测试使用锁文件中的 jsdom 26.1 开发依赖，先运行 `npm ci --ignore-scripts`。用户安装和正常运行不需要这些开发依赖。优化提交需要浏览器 Web Locks：同机使用 localhost，远程使用 HTTPS；缺少安全上下文或锁能力时降级只读观察。持久化按酒馆账号隔离，使用 localStorage、精确 CAS，并镜像到酒馆扩展设置。

## 已核验的扩展接口

| 层次 | 官方源码位置 | 核验结果与本插件边界 |
| --- | --- | --- |
| 扩展加载 | [UI Extensions 文档](https://docs.sillytavern.app/for-contributors/writing-extensions/) | 用户扩展目录为 `data/<user-handle>/extensions`，浏览器挂载到 `/scripts/extensions/third-party`。本包使用 `manifest.json` 与 ES 模块。 |
| 提示词组装 | [openai.js L1619](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L1619) | `CHAT_COMPLETION_PROMPT_READY` 参数是 `{chat,dryRun}`。这是前端组装结果，不是上游最终请求。 |
| 前端请求设置 | [openai.js L3146](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L3146) | `CHAT_COMPLETION_SETTINGS_READY` 位于 `generate_data` 构造后、`fetch('/api/backends/chat-completions/generate')` 前。其他扩展仍可能在其后改变数据。 |
| 世界书激活 | [world-info.js L902](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L902) | `WORLD_INFO_ACTIVATED` 提供实际激活条目数组；只在非 dry-run 且激活集合非空时发出，不能把缺少事件理解成明确的零激活。 |
| 世界书配置 | [world-info.js L65](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L65)、[位置枚举 L855](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L855) | 支持常驻、关键词、向量标记、递归、深度、概率、分组、预算与不同注入位置。诊断展示原值；没有猜测第三方插件字段含义。 |
| 当前绑定书读取 | [st-context.js L278](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/st-context.js#L278)、[world-info.js L4477](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L4477) | 使用 `loadWorldInfo`，结合全局选择、角色主/附加书、聊天及人格绑定收集当前范围。`getWorldInfoNames` 是全部可用书名，不能当作当前绑定集合。 |
| 当前预设顺序 | [openai.js L535](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L535)、[PromptManager.js L1207](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/PromptManager.js#L1207) | 读取当前 `chatCompletionSettings.prompts` 与公开模块导出的 `promptManager` 活跃角色顺序；不假定卡片 ID 就是全局预设顺序 ID。模块能力缺失时报告不完整，不猜排序。 |
| 原生世界书排序 | [world-info.js L5200](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L5200) | 常见 before/after 注入路径先降序遍历再 `unshift`，高 order 在最终文本更靠后；order 也影响预算竞争等行为，并非纯显示值。批量策略因此不改原书 order，仅检查已激活请求副本。其他位置及未知缓存插件不能套用同一规则。 |
| Claude 转换 | [chat-completions.js L230](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/backends/chat-completions.js#L230) | 服务端调用 `convertClaudeMessages`，组装 `system/messages/tools`。前端内容块、系统消息与最终请求可能不同。 |
| 酒馆原生缓存配置 | [chat-completions.js L106](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/backends/chat-completions.js#L106)、[prompt-converters.js L985](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/prompt-converters.js#L985) | `claude.enableSystemPromptCache`、`claude.cachingAtDepth`、`claude.extendedTTL` 是服务端启动时读取的设置。原生深度缓存可在两个消息位置写断点，不应未经核验叠加更多断点。 |
| 可选服务端插件 | [plugin-loader.js L101](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/plugin-loader.js#L101) | 支持 `package.json.main`、`info`、`init(router)`。端点挂载 `/api/plugins/cache-lens/…`，需设置 `enableServerPlugins: true` 后重启。 |

## 支持与未覆盖

| 环境/来源 | 此版本支持范围 | 仍需实测 |
| --- | --- | --- |
| Android / Termux | 标准 Node.js 文件与 HTTP API；无本地编译模块；同一手机上的浏览器、酒馆、回环 relay 可以协作 | 用户手机型号、Termux 的 Node 版本、后台休眠/进程回收 |
| Windows / macOS / Linux | Node 安装脚本使用跨平台路径；不依赖 Bash | 用户电脑、杀毒软件、实际目录权限 |
| SillyTavern 1.19.0 | 官方源码接口核验；本地适配与回放测试 | 用户安装及所有现有扩展组合 |
| Anthropic Messages | 观察最终 `system/messages`、合法 `cache_control` 结构及 usage | 用户中转是否保留字段、是否转路由、缓存隔离/TTL、实际账单 |
| OpenAI 官方 + Clash HTTP / Mixed | 0.1.8 服务端显式支持回环 HTTP CONNECT；目标仅限 `https://api.openai.com`，保留目标 TLS 验证；Fake-IP 与全局 DNS 无需修改 | 用户实际 Clash 端口、Android / Termux 联通性、真实 OpenAI 账号与付费生成 |
| OpenAI 兼容接口 | 区分兼容协议与厂商语义；归一化已知 usage 字段；默认不注入 Anthropic 字段 | 中转非标准计费、字段别名、GPT 新旧缓存选项支持 |
| DeepSeek 摘要 | 独立用途/模型统计，支持官方缓存 hit/miss 字段 | 摘要插件实际走哪条调用路径；第三方独立请求需要适配器或请求导入 |
| 酒馆助手、类脑缓存插件、用户自动摘要插件 | 已公开来源快照/显式适配器；未确认实现时只读 | 准确仓库、版本、设置导出；没有宣称已支持它们的内部写入 |

本地 relay 观察的是“酒馆转换后送到已配置上游”的请求。上游若为中转站，中转站内部再次转换、号池路由与计费逻辑仍不可见。没有 relay 或导入的服务端证据时，界面应继续显示“仅观察到前端请求”。

## 0.1.3 批量功能的实际边界

免费扫描优先用 `SillyTavern.getContext()` 的公开信息，并读取已核验的 `world-info.js` / `openai.js` 模块导出作为桥接；不访问未确认第三方插件的私有状态。报告读取当前实际预设，而非仅使用磁盘里同名预设。切卡、预设改变、世界书设置改变和角色编辑使旧报告失效，空闲后重新读取；不调用世界书 dry-run 触发器来模拟正常请求。

采集默认限制为 64 本绑定书、20000 条条目、24MiB 本机快照，超出或缺书会显示不完整并禁止据此授权。请求分析另有数量与来源覆盖边界，不把未采集部分当成稳定。它能分析当前绑定范围，不会一次打开所有未选角色卡，更不会将所有书注入模型或上传 Agent。

跨角色策略经用户一次启用后绑定正文接口与模型，运行时逐请求只处理已有 `WORLD_INFO_ACTIVATED` 来源、字节唯一匹配的相邻世界书片段。角色与卡片文本不会跨请求复用；预设及第三方记忆仍只读诊断。不同消息、角色、深度/注入范围、外层标签以及未知片段边界均不能跨越。它没有把 before-character 改为 after-character 等原生位置迁移能力。

这些批量功能在前端运行，不需要 Agent、relay 或服务端重装。已有 0.1.1 服务端仍可提供预算受控的报告复核；复核返回修改操作会拒绝。单个请求若未通过字节保护则保留原请求，并不代表实测 tokens 已超限。未在用户设备、第三方插件组合或真实 Claude/DeepSeek 付费请求上确认缓存与剧情效果。

## 安装脚本的保护范围

安装前停止酒馆。运行 `node scripts/install.mjs --st /你的/SillyTavern --frontend --server`，自定义用户可追加 `--user 实际用户目录名`。前端和服务端可分开安装。

脚本拒绝路径越界、符号链接、未知同名目录和低于 1.19.0 的版本；先暂存、比较目标哈希，再替换。旧安装备份到 `data/<user>/cache-lens-install-backups/…`，不放在扩展扫描目录里，避免同时加载旧版。它不会修改 `config.yaml`、角色卡、聊天、世界书或其他插件文件。

服务端插件需要在酒馆**根目录**的 `config.yaml` 中启用 `enableServerPlugins: true`。不要编辑 `default/config.yaml`。这是酒馆正式的服务器插件开关，并非本包自动修改。

手动恢复插件程序时，先停止酒馆，把当前 Cache Lens 目录移走，再将安装日志中的备份目录移回对应位置。程序安装备份与界面里的“优化方案回滚”是两种独立机制。

## 0.1.8 本机代理边界

服务端 `agentProxy: true` 表示支持新的显式 Agent 代理配置。只更新前端不能使旧服务端获得联网能力；要使用此功能，先更新扩展、停止酒馆，再在酒馆根目录运行 `node data/default-user/extensions/st-cache-lens/scripts/install.mjs --st . --server`，最后重启。已有 `enableServerPlugins: true` 无需重复修改。0.1.1 服务端可继续提供原有不使用此代理的功能。

代理入口仅允许带明确端口的 HTTP 回环地址 `127.0.0.1` 或 `::1`；`localhost` 固定转换为 `127.0.0.1`，不通过 DNS 发现代理。禁止认证信息、查询、片段或额外路径。代理目标固定在官方 OpenAI HTTPS origin，CONNECT 中传递目标主机名；密钥与请求正文只在随后通过严格证书和主机名校验的 TLS 连接中发送。代理失败不直接回退到公网请求，重定向也不跟随。

该路径只覆盖优化 Agent 的模型查询和预算受控生成。它不改变正文、摘要、relay 或其他扩展的网络路径，不读取/修改 Clash 配置，不宣称能控制 Clash 最终路由或防止设备上其他软件的网络泄露。原直接连接的 DNS 地址检查保留。HTTP 和 Mixed 端口说明依据 [Mihomo 官方文档](https://wiki.metacubex.one/config/inbound/port/)；不支持 SOCKS-only、控制器端口或需要代理认证的入口。

验证范围为本地模拟 HTTP CONNECT 与 TLS 服务，以及配置、预算、错误和前端流程测试；用户手机与真实 Clash/OpenAI 连接尚待接入验证。测试中没有真实付费调用，也不能据此判断 Claude 缓存或连续会话费用已改善。
