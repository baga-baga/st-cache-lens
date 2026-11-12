# 适配与证据契约

本包是 ESM，浏览器入口 `index.js`、核心模块 `core/`、酒馆适配 `adapters/`、可选服务端 `server/`。运行时没有外部 npm 依赖。所有宏、角色卡、世界书、摘要和变量都是数据，Agent 返回不能注册函数或执行文件。

## 第三方扩展

`adapters/registry.js` 导出 `adapterRegistry`。先确认插件仓库、版本及公开接口，再从受信任扩展代码注册只读 `readSources(context)` 和 `classifyRequest(body, context)`。具体参数以模块导出和测试为准；不允许 Agent 提供回调或通过字符串 eval。未知插件默认仅有扩展提示词键来源，不等同于支持写入。

`window.CacheLens` 提供 `ready`、`getMemory()`、`getDiagnostics()`、`getRecords()` 和 `adapter`。记录含本地剧情原文，第三方扩展必须自行得到用户授权后才能向外发送。`adapter.annotateNextRequest('summary')` 只适合能够保证下一请求归属的明确协作接口；并发请求优先使用注册的逐请求分类器。

## 记录分层

- `frontend`：实际前端 fetch JSON；`frontendStages` 是更早的组装事件，不冒充最终服务端转换结果。
- `server-relay`：本地 relay 看见的服务端转换后请求；`transmission` 区分拦截、尝试发送、上游已响应。中转站内部转换无法观察。
- `agent-server`：单独的优化 Agent 调用及其当时价格、预算预留和原始 usage。
- `imported`：用户导入证据，来源未独立验证；导入时删掉传输凭据，疑似内容内凭据脱敏会标记。

同一次付费请求可能有前端和 relay 两份观察。界面按观察层选取账本，不使用时间接近就强行拼接。正文/摘要/Agent 的用途必须由显式映射或可验证适配器确定。模型名本身不是用途或协议证据。

## 输入与变更

`core/optimizer.js` 仅接受结构化白名单操作，内容、角色和作用域必须守恒。`adapters/pipeline.js` 每次发送前重新确认聊天/模型/用途绑定、精确片段匹配、标签、相邻边界和完整输入上界。任何来源漂移都跳过，决不注入旧状态。

`reorder_export` 仅操作显式导入的原生配置副本，需要完整作用域和激活选择不受影响的证据标志。这是开发接口，不在界面伪造一个“一键改所有世界书”的按钮。新的复杂适配器应先回放实际激活集合并补充测试。

## 记忆

`core/memory.js` 的 `appendMemory` 接收 `id, occurredAt, text, originalTimeText, protectedFacts`。日期是准确的剧情 ISO 日期，不把相对时间自动猜成现实日期。旧事件不可改写；修正需要追加新事件。

`compactMemory` 是独立语义操作，需 `semanticOptIn: true` 与 `reviewedSummary: true`，保留受保护事实和准确日期，并保留归档及恢复函数。此版本不让优化 Agent自动执行语义压缩，不自动替换第三方摘要。结构优化与语义压缩的测试及权限相互独立。

## Agent 最小上传

服务端固定系统规则，用户消息为受限诊断 JSON。默认上传片段 ID、长度、角色、作用域、稳定性、输入限额和差异类型，不上传整书、历史消息或完整摘要。提案只支持本地明确列出的操作；服务端不接受工具调用、不开放文件系统命令。
