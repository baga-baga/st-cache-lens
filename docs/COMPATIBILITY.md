# 兼容范围与源码核验

核验日期：2026-11-12。源码基线是 **SillyTavern 1.19.0**，官方 `release` 分支提交 `06bde939fb1e9c4c8d8641d810f0a916b5bce127`。本包要求 Node.js 20 或更新版本，无额外运行时 npm 依赖。后续版本不能仅凭版本号认定完全兼容。

完整开发测试使用锁文件中的 jsdom 26.1 开发依赖，先运行 `npm ci --ignore-scripts`。用户安装和正常运行不需要这些开发依赖。优化提交需要浏览器 Web Locks：同机使用 localhost，远程使用 HTTPS；缺少安全上下文或锁能力时降级只读观察。持久化按酒馆账号隔离，使用 localStorage、精确 CAS，并镜像到酒馆扩展设置。

## 已核验的扩展接口

| 层次 | 官方源码位置 | 核验结果与本插件边界 |
| --- | --- | --- |
| 扩展加载 | [UI Extensions 文档](https://docs.sillytavern.app/for-contributors/writing-extensions/) | 用户扩展目录为 `data/<user-handle>/extensions`，浏览器挂载到 `/scripts/extensions/third-party`。本包使用 `manifest.json` 与 ES 模块。 |
| 提示词组装 | [openai.js L1619](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L1619) | `CHAT_COMPLETION_PROMPT_READY` 参数是 `{chat,dryRun}`。这是前端组装结果，不是上游最终请求。 |
| 前端请求设置 | [openai.js L3146](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L3146) | `CHAT_COMPLETION_SETTINGS_READY` 位于 `generate_data` 构造后、`fetch('/api/backends/chat-completions/generate')` 前。其他扩展仍可能在其后改变数据。 |
| 世界书激活 | [world-info.js L902](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L902) | `WORLD_INFO_ACTIVATED` 提供实际激活条目数组；只在非 dry-run 且激活集合非空时发出，不能把缺少事件理解成明确的零激活。 |
| 世界书配置 | [world-info.js L65](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L65)、[位置枚举 L855](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L855) | 支持常驻、关键词、向量标记、递归、深度、概率、分组、预算与不同注入位置。诊断展示原值；没有猜测第三方插件字段含义。 |
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
| OpenAI 兼容接口 | 区分兼容协议与厂商语义；归一化已知 usage 字段；默认不注入 Anthropic 字段 | 中转非标准计费、字段别名、GPT 新旧缓存选项支持 |
| DeepSeek 摘要 | 独立用途/模型统计，支持官方缓存 hit/miss 字段 | 摘要插件实际走哪条调用路径；第三方独立请求需要适配器或请求导入 |
| 酒馆助手、类脑缓存插件、用户自动摘要插件 | 已公开来源快照/显式适配器；未确认实现时只读 | 准确仓库、版本、设置导出；没有宣称已支持它们的内部写入 |

本地 relay 观察的是“酒馆转换后送到已配置上游”的请求。上游若为中转站，中转站内部再次转换、号池路由与计费逻辑仍不可见。没有 relay 或导入的服务端证据时，界面应继续显示“仅观察到前端请求”。

## 安装脚本的保护范围

安装前停止酒馆。运行 `node scripts/install.mjs --st /你的/SillyTavern --frontend --server`，自定义用户可追加 `--user 实际用户目录名`。前端和服务端可分开安装。

脚本拒绝路径越界、符号链接、未知同名目录和低于 1.19.0 的版本；先暂存、比较目标哈希，再替换。旧安装备份到 `data/<user>/cache-lens-install-backups/…`，不放在扩展扫描目录里，避免同时加载旧版。它不会修改 `config.yaml`、角色卡、聊天、世界书或其他插件文件。

服务端插件需要在酒馆**根目录**的 `config.yaml` 中启用 `enableServerPlugins: true`。不要编辑 `default/config.yaml`。这是酒馆正式的服务器插件开关，并非本包自动修改。

手动恢复插件程序时，先停止酒馆，把当前 Cache Lens 目录移走，再将安装日志中的备份目录移回对应位置。程序安装备份与界面里的“优化方案回滚”是两种独立机制。
