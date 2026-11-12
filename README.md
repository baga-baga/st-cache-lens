# Cache Lens 0.1.0

可安装的 SillyTavern 缓存诊断与受约束优化扩展。支持前端请求观察、来源追踪、差异回放、费用分账、优化副本、回滚和可配置 AI Agent；可选本地 relay 用于观察酒馆转换后的真实上游请求并添加经过校验的 Anthropic 缓存断点。

**核验基线：SillyTavern 1.19.0，Node.js 20+。运行时无额外 npm 依赖。** 安装包包含完整源码和测试，正常安装不需要构建或 npm 安装；开发者运行全套测试需安装包内锁定的开发依赖。

## 使用酒馆自带“安装扩展”

打开酒馆的“扩展 → 安装扩展”，粘贴下面的仓库地址：

```text
https://github.com/baga-baga/st-cache-lens.git
```

安装完成后刷新页面，在扩展设置中打开 **Cache Lens**。仓库根目录包含 `manifest.json` 和入口文件，不需要解压、运行安装脚本或执行 npm 安装。更新可使用酒馆扩展管理器的更新按钮。首次使用保持“只诊断”，先配置正文与摘要的用途映射和实际价格，再正常游玩两轮。

仓库只发布插件代码、文档与明确标注的合成测试素材；不要提交真实 API 密钥、聊天、世界书、请求导出或本机 relay 配置。

酒馆的“安装扩展”安装的是前端部分。可直接使用被动观察、本地诊断、回放与受约束请求副本优化；优化 Agent 的服务端密钥托管和完整出站请求观察，需要另外启用可选服务端组件。仓库链接本身不会自动获得服务端安装权限。

### 已通过扩展按钮安装，继续启用 Agent

无需再下载 ZIP。先停止酒馆，在酒馆根目录执行（默认用户、个人扩展安装）：

```bash
node data/default-user/extensions/st-cache-lens/scripts/install.mjs --st . --server
```

该命令在 Termux、Windows PowerShell、macOS 和 Linux 中相同。非默认用户将 `default-user` 替换为你的用户目录名，并追加 `--user 用户目录名`；若安装时选了“所有用户”，脚本路径改为 `public/scripts/extensions/third-party/st-cache-lens/scripts/install.mjs`。

然后在酒馆根目录 `config.yaml` 中将 `enableServerPlugins` 设为 `true`，重启酒馆。只加 `--server` 会保留前端 Git 仓库及扩展管理器更新能力。前端更新后，如需同步服务端代码，再停止酒馆并执行上述命令。完整出站请求观察还需按 [使用说明](docs/USAGE.md) 配置本地 relay。

## ZIP 安装方式

1. 解压安装包，停止酒馆。
2. 用下面的安装命令安装前端；需要 Agent 或 relay 观察界面时同时安装服务端组件。
3. 重启酒馆，在“扩展设置”打开 **Cache Lens**，保持“只诊断”。
4. 明确设置 Claude 正文、DeepSeek 摘要的用途映射，填写你的实际价格；正常游玩两轮。
5. 查看“最早差异、稳定前缀与来源”。随后按 [使用说明](docs/USAGE.md) 建立优化副本并预览；需要完整 API 证据时再接入 relay。

没有设置额外次数和费用预算时，不会调用付费 Agent。本版本不自动发起正文付费测试，也不通过无意义请求预热缓存。

## Android / Termux 安装

酒馆通常已有 Node.js。先检查 `node --version`，要求 20 或更新版本。首次访问手机下载目录可运行 `termux-setup-storage`；如果缺少 unzip，可用 `pkg install unzip`。在 Termux 中运行，路径按你的实际位置替换：

```bash
cd "$HOME"
unzip "$HOME/storage/downloads/st-cache-lens-0.1.0.zip"
cd st-cache-lens
node scripts/install.mjs --st "$HOME/SillyTavern" --frontend --server
```

若只想被动诊断、回放和本地优化，去掉 `--server`。不是默认用户时追加 `--user 你的酒馆用户目录名`。本包不会写入其他用户的扩展目录。

安装服务端组件后，在 **SillyTavern 根目录**的 `config.yaml` 中设置：

```yaml
enableServerPlugins: true
```

不要编辑 `default/config.yaml`。随后用原来的启动方式重启酒馆，刷新浏览器页面。服务端组件允许保存 Agent 密钥和访问本机 relay；前端诊断本身不要求打开这个开关。

安装脚本先暂存、检查并发修改，再替换 Cache Lens 自身目录。已有安装会备份到 `data/<user>/cache-lens-install-backups/…`，不会覆盖角色卡、聊天、原世界书、原预设或其他插件。

## Windows / macOS / Linux 安装

解压后停止酒馆，在包目录打开终端。Windows PowerShell 示例：

```powershell
node .\scripts\install.mjs --st "D:\SillyTavern" --frontend --server
```

macOS / Linux 示例：

```bash
node scripts/install.mjs --st "$HOME/SillyTavern" --frontend --server
```

同样在酒馆根配置中启用 `enableServerPlugins: true` 并重启。Node 版本要求与手机一致；安装脚本支持空格路径。

## 本版本实际能做什么

| 功能 | 实现范围 |
| --- | --- |
| 请求观察 | 酒馆前端事件与最终前端 fetch；本地 relay 另外观察服务端转换后的出站请求及 usage。两层不会混为一份。 |
| 来源与差异 | 保留空白及不可见字符，比较角色、块顺序、最早差异和稳定前缀；来源精确匹配与启发式判断有区别。 |
| 世界书 | 分开显示整书、预算、激活和发送量；读取整书只是本机诊断，不等于把整书注入模型。 |
| 结构优化 | 只重排明确授权、同一消息/角色/作用域内、相邻且独立的完整片段。下次请求字节不再匹配就跳过，不注入旧状态。 |
| Agent | OpenAI Chat Completions 兼容或 Anthropic Messages 端点；服务端保管密钥；仅接收结构化方案，必须通过本地校验和预算检查。 |
| 缓存断点 | 在经过确认的 Anthropic Messages 接口，为两次实际请求中相同的 system 块前缀添加真实 API 断点；保留现有断点和原文本。 |
| 摘要适配 | 检测摘要重写/时间措辞变化/位置移动；提供追加式记忆台账与只读适配接口。未知第三方摘要插件不自动改写。 |
| 费用与回滚 | 正文、摘要、Agent 分账；单价、币种、来源和日期可配置；方案版本、并发检测、试算、历史及回滚。 |

这个版本没有接管未知“类脑缓存命中管理”插件的内部状态，也没有实现对任意第三方摘要的自动语义压缩。它不自动修改原世界书触发策略、消息角色或秘密揭露条件。可安全执行的范围不足时，诊断会保留证据，优化会跳过。

## 安装后怎样验证

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run demo
```

测试依赖包含 jsdom 26.1；仅用于开发验证，不是手机运行插件所必需。测试包含离线请求回放、usage/费用计算、越权拒绝、并发与回滚，以及真实本机 HTTP mock 上游。`npm run demo` 使用明确标注为 synthetic 的离线样例，不连接付费模型。最终测试数量与检查结果见交付测试报告。

已在开发环境启动官方酒馆 1.19.0，加载服务端插件并完成前端打包。官方酒馆 HTTP 集成验证覆盖前端模块访问、身份验证/CSRF、官方请求转换、relay 与 mock 上游的 JSON/SSE 请求，以及原生非流式响应缺少 usage 时由 relay 恢复观察。界面控件另作 DOM 级验证；开发环境的浏览器沙箱限制阻止了实际手机视口的视觉验收，不把控件测试表述为手机视觉测试。

**尚未在你的 Termux 设备、真实 Claude/DeepSeek 账户或中转站付费请求上验证。** 离线测试通过不代表 Claude 缓存读取已经提高，更不能保证总费用一定降低。总费用必须在正常连续游玩中实测，同时评估剧情质量。

详细资料：

- [操作说明、Agent 与 relay 配置](docs/USAGE.md)
- [版本与官方源码核验](docs/COMPATIBILITY.md)
- [缓存规则、计数与费用口径](docs/PROVIDER_RULES.md)
- [验收项目与最少接入材料](docs/ACCEPTANCE.md)

日志会包含剧情文本：前端观察默认仅保存在有界内存中（最多 30 条、约 24MB），每个 relay 默认为最多 20 条、32MB。优化副本、回滚记录和记忆台账按当前酒馆账号保存在浏览器 localStorage，并镜像到酒馆扩展设置；跨标签提交使用 Web Locks 与精确版本比较。浏览器必须使用 localhost 或 HTTPS 安全上下文；缺少锁能力时保持只读观察。默认“导出脱敏诊断”不包含提示词正文；记忆导出与你主动获取的完整请求仍可能包含秘密剧情，不应直接公开。密钥不应放进角色卡、世界书、截图或聊天。

许可：MIT，见 [LICENSE](LICENSE)。
