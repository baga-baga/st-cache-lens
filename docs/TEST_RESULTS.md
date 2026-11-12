# Cache Lens 0.1.1 验收记录

验收日期：2026-11-12。执行环境：Linux、Node.js 24.22.1。官方宿主：SillyTavern 1.19.0，release 提交 `06bde939fb1e9c4c8d8641d810f0a916b5bce127`。

## 执行结果

| 检查 | 结果 | 能证明什么 |
| --- | --- | --- |
| `npm test` | 171 通过，0 失败，0 跳过 | 核心逻辑、模拟接口、安装器、DOM 交互和事务恢复符合测试断言。 |
| `npm run check` | 42 个 JS/MJS 文件语法检查通过；JSON 可解析 | 安装包源码语法有效。 |
| 官方酒馆实例启动 | 成功 | 官方源码安装依赖后正常启动，加载 Cache Lens 服务端插件并完成宿主前端打包。 |
| 实际酒馆 HTTP 链路 | 10 项通过 | 扩展模块可访问；服务端认证/CSRF 路由；官方 Claude 转换→relay→本地模拟上游；JSON 和 SSE 转发；usage 保留；观察记录无测试密钥；未保存的 Agent 连接检查只 GET 查询模型，不生成、不改变零预算。 |
| 模拟上游付费调用 | 0 | 所有测试上游都是本地 HTTP 服务，无真实模型消耗。 |
| 手机视口视觉检查 | 未完成 | Chromium 套接字被执行环境禁止，独立云浏览器不能访问隔离本地服务。DOM 测试不能代替视觉验收。 |

原始机器测试输出保存在 `docs/test-output.txt`；宿主链路记录在 `docs/st-http-test.json`。

## 0.1.1 新增覆盖

- OpenAI 一键配置不会授权预算，不调用任何接口；切换上游时清空待填旧密钥。
- 连接检查零预算可用，只有同源服务端调用 GET 模型查询；不上传诊断、不会降级为生成请求。
- 401、403、模型查询不支持、超时、响应大小和检查频率均有明确处理；公开兼容模型查询不冒充已校验密钥。
- 保存配置与预算不生成内容；密钥不进入前端持久化设置，保存成功后清空输入框。
- Terra 请求构造使用 `max_completion_tokens`、显式 low 推理、官方标准档位、不带工具。第三方兼容端点保留其参数选择。
- 安装按钮与更新按钮的原生 Git 链路已在 0.1.0 发布时实测；0.1.1 对应发布提交另做相同链路复验。

尚未使用真实 OpenAI Key 调用 Terra：这些测试验证请求构造和模拟链路，不证明用户账号可用性、模型效果或真实计费。

## 需求对应测试

| 场景 | 覆盖文件与范围 |
| --- | --- |
| 前部世界书插入、角色/块顺序变化、末尾追加 | `test/diagnostics.test.js`，明确最早差异与来源，不把后部变化当整段缓存必然失效。 |
| 摘要重写、相对日期变化、固定深度移动 | `test/diagnostics.test.js`，文本变化与语义判断分开。 |
| 已有稳定断点，后部内容变化 | `test/diagnostics.test.js`、`test/cache-transform.test.js`，区分本地边界和服务商缓存结果。 |
| 150 万量级保护与四类数量 | `test/diagnostics.test.js`、`test/pipeline.test.js`、`test/server-relay.test.js`，整书不等于发送；已启用上限时在上游调用前拒绝。 |
| 重复注入 | `test/diagnostics.test.js`，只识别精确重复，不依据内容相关性删减。 |
| 方案越权、事实/角色/标签/宏破坏 | `test/optimizer.test.js`、`test/adapter.test.js`，拒绝非白名单和不守恒修改。 |
| 应用失败、并发修改、逐轮和完整回滚 | `test/optimizer.test.js`、`test/state-store.test.js`、`test/relay-control.test.js`、`test/install.test.js`。 |
| 追加记忆、日期与独立语义操作 | `test/memory.test.js`，旧事件不变，原相对措辞保留，压缩单独授权且可恢复。 |
| Anthropic / OpenAI / DeepSeek 计费 | `test/usage.test.js`、`test/ui-billing.test.js`，不重复计数，缺字段不按零处理。 |
| Agent 预算、密钥与接口 | `test/server-agent.test.js`，零预算拒绝、预留成本、异常和未知费用保守记账、密钥不返回。 |
| 多观察器与流式请求 | `test/server-agent.test.js`、`test/server-relay.test.js`，正文/摘要独立上游、单观察器失败隔离。 |
| 用户可操作闭环 | `test/dom.test.js`，实际面板控件提取→预览→应用→活跃请求副本→回滚→记忆追加；零预算拒绝；两观察器完整恢复；超过30条提示词保留限额后用量仍累计。 |
| 总费用与质量停止条件 | `test/evaluation.test.js`，把摘要和 Agent 费用纳入比较，不把高命中率当低费用。 |

## 实测的边界

真实运行的是酒馆宿主、HTTP 请求转发和本地插件逻辑。上游回复及 usage 是测试构造。没有测得你的 Claude 缓存读取、费用降低或剧情质量改善；不能将本报告当作这些结果的证明。

未实测：Android/Termux 实机、Windows/macOS 实机、你的正文和摘要模型账户、中转内部转换、尚未确认仓库/版本的酒馆助手/自动摘要/类脑缓存管理插件。Node 20 是实现兼容下限；本次执行版本为 Node 24。

## 在隔离副本复验

正常安装插件不需要这些开发依赖。开发复验：

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run demo
```

完整宿主链路仅在新克隆的测试酒馆副本运行：

```bash
node scripts/verify-st.mjs --st /path/to/disposable/SillyTavern --isolated-test-copy
```

该命令会安装测试扩展并配置模拟观察器，不能指向正在游玩的正式酒馆目录。

## 最少接入材料

1. 你的 SillyTavern 版本号或提交；Android Node 版本。
2. 酒馆助手、摘要/记忆、缓存管理插件的仓库链接及版本，或脱敏设置导出。
3. 同一正文会话相邻两次脱敏最终请求与原始 usage；最好附接口类型、时间间隔和实际价格/平台账单字段。

不需要整本世界书，不需要明文 API 密钥。原文替换需两份一致，并保留空白、消息角色、块顺序、缓存字段及 token 计数。
