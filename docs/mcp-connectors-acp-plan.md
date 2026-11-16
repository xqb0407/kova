# MCP / Connector / ACP 路线图（M1–M3 与后续）

状态：计划已确认，未开工。  
日期：2026-11-16。  
范围：M1–M3 为近期执行范围；后续里程碑只锁阶段、依赖和验收，开工时再补详细设计。

## 1. 背景

Kova 的执行层已经比较完整：会话/工具运行时、goal、子代理、检查点、记忆、知识库、插件市场、IM、远程、ACP server、PTC 都已具备。下一阶段的主要缺口不在“再加一个工具”，而在**开放性和编排层**：

- MCP 只实现了 tools，生态里的 resources / prompts / elicitation / Tasks 都接不进来；
- MCP 市场只是官方 Registry 的原始远程服务器列表，没有产品化的 Connector；
- ACP 只能被编辑器拉起，不能反过来驱动 Claude Code / Gemini CLI / Codex；
- 自动化只能定时触发，窗口关闭后的常驻能力也不完整；
- 检查点能回滚，但不能从某一轮隔离分叉；
- 记忆是 Markdown + 关键词检索，缺少巩固/审阅；
- Workflow / Bot Team 只有设计稿；
- 浏览器和截图已有，桌面控制没有。

目标：先把“能连什么”做厚，再把“能调度谁”做深。

## 2. 当前代码事实

| 能力 | 现状 | 关键文件 |
|---|---|---|
| MCP tools | 只有 `listTools` / `callTool` | `apps/sidecar/pi-agent/src/mcp/mcp-manager.ts` |
| MCP SDK | 实际安装 `1.32.1`，`package.json` 仍写 `^1.30.0` | `apps/sidecar/pi-agent/package.json` |
| MCP 市场 | 官方 Registry 远程服务器，一键保存为 HTTP MCP | `apps/desktop/lib/mcp/mcp-market.ts`、`apps/desktop/components/marketplace/mcp-market.tsx` |
| MCP 安全 | OAuth 2.1、stdio secret env、审计、子代理 `mcpServers` 白名单 | `mcp-oauth.ts`、`mcp-secrets.ts`、`mcp-audit.ts`、`subagent/capabilities.ts` |
| ACP | 只有 server（stdio JSON-RPC） | `apps/sidecar/pi-agent/src/acp/` |
| 子代理 | Task / TaskWait / SendMessage / resume / activity / 审批链 | `apps/sidecar/pi-agent/src/subagent/` |
| 自动化 | cron / interval / once、补跑、并发队列、独立调度进程 | `apps/sidecar/pi-agent/src/automation/`、`packages/automation-core/` |
| 常驻 | macOS 关闭窗口不退出；Windows 托盘；Linux 退出 | `apps/electron/main/index.ts`、`window.ts`、`tray.ts` |
| 会话分叉 | `fork_session` 复制转录 | `apps/sidecar/pi-agent/src/protocol/handlers/sessions.ts` |
| 检查点 | 影子 git 整轮快照 + 逐文件所有权 | `apps/electron/main/git.ts`、`checkpoint/store.ts` |
| Memory | Markdown + 关键词检索，默认关闭 | `apps/sidecar/pi-agent/src/agent/memory.ts` |
| Workflow | 只有差距分析 | `docs/workflow-engine-gap.md` |
| Bot Team | 只有设计稿 | `docs/agents/bot-team.md` |
| Computer use | 浏览器工具 + 屏幕截图；无桌面控制 | `tools/browser-tools.ts`、`tools/screenshot-tool.ts` |

## 3. 总体原则

1. **不新增数据库**：继续用 JSONL / JSON / SQLite kv，沿用 Inbox 的 journal + 原子状态思路。
2. **能力显式声明**：不支持的能力不向服务器 advertise；旧 tools-only 服务器行为不变。
3. **外部内容默认不可信**：MCP 输出、外部 agent 报告、Connector 返回都走脱敏、截断、来源标注。
4. **管理面默认桌面专属**：新增 MCP / Connector / ACP 命令同步加入 `remote.ts` 的 `REMOTE_DENIED_TYPES`。
5. **工具 schema 稳定**：MCP 继续用单一 `mcp` 网关，新增 action 而不是新增十几个顶层工具，保护前缀缓存。
6. **信任边界在系统层**：工作区文件可以引用能力，但不能凭仓库内容获得命令执行或免审批授权。
7. **每个里程碑独立可发布**：不做大爆炸式重构；迁移必须向前兼容。

## 4. 里程碑总览

| 里程碑 | 内容 | 依赖 | 退出标准 |
|---|---|---|---|
| M1 | Connector v1 + MCP Resources/Prompts/Elicitation | 无 | 一个 Connector 端到端可用；资源/Prompt 可浏览；Elicitation 可回答且无人值守不挂起 |
| M2 | MCP Tasks + Connector 治理 | M1 | 长任务有进度/取消/Inbox；token 不落明文；工具白名单生效 |
| M3 | ACP client v1 | M2 | 一个外部 ACP agent 可作为子代理被 Task 调用 |
| L1 | 事件触发 + Headless | M2 | webhook / 文件 / git / IM 可触发；关窗后仍运行 |
| L2 | Checkpoint fork / branch / replay | L1 | 从检查点分叉到独立目录；可重放 |
| L3 | Memory dreaming | L2 | 生成可审阅记忆提案；接受/拒绝/回滚 |
| L4 | Workflow Engine | L1、L3 | 线性流程可恢复、可审阅、可复用 |
| L5 | Bot Team | L1、M3 | 两 Bot 往返；群聊收敛；之后才做 A2A |
| L6 | Computer use | L1、M2 | 浏览器/桌面操作可授权、可审计、可停止 |

---

## 5. M1：Connector v1 + MCP Resources / Prompts / Elicitation

### 5.1 MCP 能力层

修改：

- `apps/sidecar/pi-agent/src/mcp/mcp-manager.ts`
- `apps/sidecar/pi-agent/src/mcp/mcp-cache.ts`
- `apps/sidecar/pi-agent/src/mcp/mcp-output-guard.ts`
- 新增 `packages/pi-protocol/src/mcp.ts` 共享类型；旧 MCP 类型暂留 `apps/desktop/lib/pi/pi-bridge.ts`

工作项：

1. 把 `@modelcontextprotocol/sdk` 依赖从 `^1.30.0` 收到 `^1.32.1`，先跑现有 MCP 测试确认无回归。
2. `Entry` / `McpServerStatus` 增加：
   - `capabilities: { resources, prompts, tasks }`
   - `resourceCount`、`promptCount`
3. 握手时记录 `client.getServerCapabilities()`；`tools/list` 之后按 capability 拉取：
   - `resources/list` + `resources/templates/list`
   - `prompts/list`
   - 上限：每服务器 200 resources / 100 prompts / 8 页。
4. 新增 manager 方法：
   - `listResources(def)`、`readResource(def, uri)`
   - `listPrompts(def)`、`getPrompt(def, name, args)`
5. 缓存升级为 v2：保留 tools，新增 resources/prompts 元数据；v1 缓存可迁移，不丢工具面。
6. 资源读取经过 `mcp-output-guard`：
   - 文本 8KB / 1000 行截断 + 溢写文件；
   - 图片走 `image-parts` 2MiB 闸门；
   - resource link 只保留 URI/名称/描述，不自动抓取。
7. 监听 `notifications/resources/list_changed` / `prompts/list_changed`，失效缓存；M1 不做推送，下一次 `list_mcp_servers` 刷新。

### 5.2 MCP 网关与协议

修改：

- `apps/sidecar/pi-agent/src/mcp/mcp-tools.ts`
- `apps/sidecar/pi-agent/src/protocol/handlers/mcp.ts`
- `apps/sidecar/pi-agent/src/protocol/protocol.ts`
- `apps/desktop/lib/pi/pi-bridge.ts`
- `apps/desktop/lib/mcp/mcp.ts`

`mcp` 网关新增 action，保持单一工具：

- `resources`：列出某服务器/全部服务器的资源，支持 query；
- `resource_read`：读取一个 URI；
- `prompts`：列出服务器 prompt；
- `prompt_get`：按名字和参数取 prompt。

新增协议命令：

- `list_mcp_resources` → `{ name, resources, templates }`
- `read_mcp_resource` → `{ name, uri, content, truncated? }`
- `list_mcp_prompts` → `{ name, prompts }`
- `get_mcp_prompt` → `{ name, prompt, messages }`

桌面 UI：

- `mcp-settings.tsx` 服务器详情增加 Resources / Prompts 懒加载分区。
- 资源只读预览、复制 URI；模型通过 `mcp` 网关读取。
- Composer `/` 菜单新增“MCP Prompts”分组：
  - 选 prompt → 参数表单；
  - 取回后插入输入框，由用户确认发送，不自动发；
  - prompt 内容标注来源服务器，按用户内容处理，不作为 system prompt。
- 新命令加入 `remote.ts` 远程拒绝清单。

### 5.3 Elicitation

新增 `apps/sidecar/pi-agent/src/mcp/elicitation.ts`。

- 创建 `Client` 时 advertise `elicitation: { form: {} }`。
- 用 `AsyncLocalStorage` 把当前 `threadId/sessionId` 绑定到 MCP 调用；服务器发 `elicitation/create` 时据此找会话。
- M1 只支持 form 模式；URL 模式返回 decline。
- schema 扁平字段映射到现有 `QuestionDef`：
  - string enum → 单选；
  - array enum → 多选；
  - boolean → 是/否；
  - string/number/integer → 自由输入。
- 复用 `data-question` + `QuestionCard` + Inbox question 流；不新造 UI。
- `QuestionCard` 增加可选来源标签（服务器名）。
- 答案结算时 sidecar 校验类型和必填项，再返回标准 `ElicitResult`。
- 无人值守自动化直接 decline；超时/Stop/新 prompt 按 cancel 结算。
- `permissions/interactions.ts` 的 `applyQuestionAnswer` 先尝试 MCP elicitation，再走普通 Question。

### 5.4 Connector v1

保留现有 `mcp-market.tsx` 作为原始 Registry；新增 curated Connectors。

新增：

- `apps/desktop/lib/connectors/catalog.ts`
- `apps/desktop/components/marketplace/connectors-market.tsx`
- `apps/desktop/components/marketplace/connector-detail.tsx`

Manifest 字段：

```ts
id, title, description, category, icon, docsUrl,
transport: "http",
url,
auth: "oauth" | "header" | "none",
headerSchema?: { name; description; secret }[],
toolsPreview?: string[],
verified: boolean,
```

接入：

- `McpServerDef` / `McpDraft` / `PiMcpServerEntry` 增加可选 `connectorId`。
- 只在系统层/工作区覆盖层持久化；标准 `.mcp.json` 忽略。
- 安装复用 `saveMcpServer`；OAuth 复用 `authorizeMcpServer`；header 型复用 headers 表单。
- 卡片显示已连接、工具/资源/Prompt 数、授权状态、撤销授权、文档。
- 首批只上 3 个有稳定远程端点的；不为每个 provider 写 native API adapter。
- `marketplace-view.tsx` 新增 `connectors` section，与 plugins / skills / mcp 并列。

首批候选：GitHub、Notion、Linear 或 Atlassian Jira。最终名单以“有稳定远程 MCP + 可用 OAuth/Token 流程”为准；没有稳定远程端点的 provider 延后。

### 5.5 M1 验收

- 旧 tools-only 服务器行为完全不变。
- 声明 resources/prompts 的测试服务器能在网关和设置页看到并读取。
- Elicitation 能完成一次表单问答；自动化中不会挂起。
- 一个 Connector 可一键安装、授权、搜索到工具、撤销授权。
- `mcp-cache` v1 → v2 迁移测试通过。
- 远程端不能调用新增管理命令。

---

## 6. M2：MCP Tasks + Connector 治理

### 6.1 MCP Tasks

新增：

- `apps/sidecar/pi-agent/src/mcp/mcp-tasks.ts`
- `apps/sidecar/pi-agent/src/mcp/mcp-task-store.ts`

使用 SDK `client.experimental.tasks`，但包一层自己的 adapter，避免 experimental API 直接散落。

策略：

- `tool.execution.taskSupport === "required"`：必须走 task。
- `"optional"`：当 `callTimeout` 超阈值或工具被标记为长任务时走 task。
- `"forbidden"`：普通 call。
- `callToolStream` 消费 `taskCreated` / `taskStatus` / `result` / `error`。
- 进度通过 `data-mcpTask` chunk 推到当前 thread；UI 在工具行显示进度和状态。
- 取消：
  - 用户 Stop / AbortSignal → `cancelTask`；
  - Inbox / 任务面板 → `mcp_task_cancel`。
- 超出当前 turn 的任务：
  - 返回 taskId 给模型，模型可用 `mcp` 的 `task_status` / `task_result` 查询；
  - 同时写入 Inbox，新增 `mcp_task` kind。
- 任务元数据持久化 `<sessionsDir>/mcp-tasks.json`；服务端 task 按 TTL 过期，过期后 Inbox 标 stale。
- 新增协议：`mcp_task_status`、`mcp_task_result`、`mcp_task_cancel`。
- UI：工具行进度、后台任务面板、Inbox 条目、取消按钮。

验收：

- required task 能显示进度并取消。
- 取消后 Inbox 结算为 cancelled。
- turn 结束后任务仍在跑时 Inbox 可见；结果可在下一轮读取。

### 6.2 Connector 治理

- HTTP MCP 增加 `secretHeaders` 绑定：
  - 复用 `mcp-secrets.ts` 的密钥库；
  - headers 值不写进 `mcp.json`，连接时解析并注入；
  - 输出脱敏。
- 增加 `enabledTools` glob 白名单：
  - 配置在 kova 层，工作区层不产生授权效力；
  - `buildToolIndex` 过滤，`callTool` 再闸一次。
- Connector 状态存 kv `pi.connectors`：
  - `connectorId → { serverName, installedAt, lastUsedAt, lastError, enabledTools }`
- 审计扩展：
  - `McpAuditEvent` 增加 `connectorId`；
  - 新增 `task_start` / `task_cancel` / `elicit` 事件。
- UI：
  - Connector 详情显示账号/OAuth 状态、最近使用、工具白名单、撤销授权；
  - 显示“哪些子代理可用”只读信息，实际授权仍由子代理 YAML 的 `mcpServers` 决定。
- 暂不做跨 connector 统一配额、spend cap；放到后续安全中心。

验收：

- header token 不出现在 `mcp.json`、日志、工具结果。
- 禁用某工具后 search / describe / call 都不可见。
- 审计能定位 connector 和 task。

---

## 7. M3：ACP client v1

### 7.1 信任模型

新增系统级外部 agent 注册表：

- `~/.kova/acp-agents.json`
- 字段：`id`, `name`, `command`, `args`, `env`, `enabled`, `preset`, `cwdMode`。
- **只有系统层能定义 command**；工作区 YAML 只能引用已存在的 agent id，不能携带可执行命令。

子代理定义增加：

```yaml
backend: acp
acpAgent: claude-code
```

不把 `command` 放进工作区 YAML，避免 clone 仓库后自动拉起任意进程。

### 7.2 客户端运行时

新增：

- `apps/sidecar/pi-agent/src/acp/client/connection.ts`
- `apps/sidecar/pi-agent/src/acp/client/manager.ts`
- `apps/sidecar/pi-agent/src/acp/client/translate.ts`
- `apps/sidecar/pi-agent/src/acp/client/presets.ts`
- `apps/sidecar/pi-agent/src/subagent/external-run.ts`

实现：

- 用 `@agentclientprotocol/sdk` 的 `client({ name }).connectWith(stream, ctx => ...)`。
- `child_process.spawn` + stdio pipes + `acp.ndJsonStream`；环境变量白名单，不继承 Kova 密钥。
- `initialize` → `session/new`（工作区 cwd）→ `session/prompt`；`session/cancel` 对应 AbortSignal。
- ACP 事件映射：
  - `agent_message_chunk` / `agent_thought_chunk` → 子代理 activity；
  - `tool_call` / `tool_call_update` → activity 工具行；
  - `plan` → todo/activity；
  - `usage_update` → token 统计（有则记，无则 null）。
- 最终 assistant 文本作为 `SubagentRunResult.report`。
- `request_permission` → 复用 `data-toolApproval` + `beginInteraction`；审批策略沿用当前档位；自动化无 full 权限则拒绝。
- 外部进程无法被 Kova 的文件沙箱完全约束，因此：
  - 只允许系统级配置；
  - 固定 cwd 在工作区内；
  - 不注入 Kova secrets；
  - 审计每次启动、工具权限、取消；
  - UI 明确提示“此外部 agent 使用它自己的工具权限”。

### 7.3 集成与 UI

- `subagent/tools.ts` 的 `Task` / `TaskWait` / `TaskList` / `TaskStop` 支持 `backend: acp`。
- `DelegationRecord` 增加 `backend`、`externalAgentId`、`externalSessionId`。
- M3 v1 支持启动、活动流、权限、取消、报告；`SendMessage` resume 先返回“不支持 resume”，M3.1 再补 `session/load`。
- 设置 → 子智能体新增“外部 Agents”：
  - 列表、启用、命令、测试连接、删除；
  - 首个 preset 自动检测本机可用命令。
- fake ACP agent 覆盖：启动、流式文本、权限允许/拒绝、取消、进程崩溃。

### M3 验收

- 配置外部 ACP agent 后，主代理通过 `Task` 调用并拿到报告。
- 权限卡能允许/拒绝一次外部工具调用。
- Stop 能取消外部 turn 并杀掉子进程。
- 外部 agent 启动不继承 Kova API key。
- A2A 不在 M3：等 Bot Team 有团队对象和 endpoint 后再做。

---

## 8. 后续里程碑

### 8.1 事件触发 + Headless

阶段：

1. Trigger 抽象与存储：`~/.kova/triggers.json`，trigger → automation taskId；不把新字段硬塞进 vendored `ScheduledTask`。
2. Webhook：Electron main 内 loopback HTTP endpoint；每 trigger 独立 secret、HMAC、时间窗、幂等键、body 上限、限流。
3. 文件 watch：工作区内 glob，防抖，忽略 `.git/node_modules` 和 agent 自身产物。
4. Git：监听 HEAD/refs，支持 commit 触发；push 交给 CI webhook。
5. IM：复用 `apps/electron/main/im/router.ts`，支持私聊命令和群聊 @mention（按平台能力）。
6. 运行上下文：`ScheduledTaskRunContext` 增加可选 `trigger` 元数据；prompt 支持 `{{trigger}}` 模板。
7. Headless v1：macOS/Windows 托盘常驻、登录启动、窗口关闭不退出、通知 + Inbox；Linux 先文档化“不支持无窗口”。
8. Headless v2（后续）：独立 `kova-daemon`，不依赖 Electron。

验收：curl webhook、touch 文件、git commit 都能触发一次 run，Inbox 显示来源；窗口关闭后仍能触发。

### 8.2 Checkpoint fork / branch / replay

现状：`fork_session` 已能复制对话；影子 git 能整轮快照；缺少工作区隔离分叉。

阶段：

1. `fork_session` 增加可选 `cwd` / `parentSession`；UI 在消息和检查点卡增加“从此分叉”。
2. Electron `git_checkpoint_export`：把影子 commit 物化到新目录或新 worktree；路径限定在工作区/受管目录内，拒绝符号链接。
3. “带工作区分叉”：新会话 cwd 指向新目录，原工作区不动。
4. “重放”：从锚点 fork + 重发原 user prompt，可换模型；记录 `replayOf`。
5. “比较”：同一 checkpoint 的两个分支并行展示 diff / 结果；暂不做自动 merge。
6. 清理：fork 目录保留期、磁盘配额、失败回滚。

验收：从某轮检查点分叉后，新会话在独立目录运行，原会话文件不受影响；重放不重复计费已完成步骤。

### 8.3 Memory dreaming

阶段：

1. 候选捕获：只从明确信号（用户纠正、决策、lesson、重复偏好）生成候选，不做全量日志。
2. Proposal store：`~/.kova/memory/.proposals/`，每条带来源 session、置信度、目标文件、diff。
3. 巩固任务：手动“Dream now” + 空闲/每日触发；读取最近会话和现有记忆，生成 proposal，不直接改写。
4. 审阅 UI：Memory 设置页显示待审 diff，接受/拒绝/编辑；复用现有版本历史做回滚。
5. 索引：小型 `INDEX.md` 或内存索引，继续关键词检索；不先上向量库。
6. 预算与安全：token 上限、脱敏、去重、冲突检测；默认关闭。

验收：一次 dream 能产出可审阅 diff；接受后记忆文件更新且可回滚；拒绝不产生副作用。

### 8.4 Workflow Engine

按 `docs/workflow-engine-gap.md` 的方案 A：

1. `WorkflowDefinition` / `WorkflowRun` / `WorkflowStepRun` 类型；YAML/JSON 定义；JSON Schema 输出。
2. 线性 `dependsOn` + `when` + `retry` + `timeout` + `onError`。
3. `agent` 步骤复用 `SubagentRun`；`run` 步骤复用沙箱/审批；`approval` 步骤复用审批卡/Inbox。
4. `<sessionsDir>/workflow-runs/<runId>.jsonl` journal；从最后完成步骤恢复，已完成步骤缓存。
5. 工作流级并发/token 预算；取消/暂停。
6. UI：run 列表、步骤树、状态、耗时、token、产物、审批；automation 可选择 workflow + inputs。
7. 暂不做可视化节点编辑器、任意嵌套、脚本逃生口。

验收：同一 workflow 重复运行步骤顺序一致；中断后从失败步骤恢复；每步输出通过 schema 校验。

### 8.5 Bot Team

按 `docs/agents/bot-team.md`：

- T0：`bots/` 调度器 + rooms 资产 + 私聊互发 + 投递状态机 + hop/预算护栏。
- T1：群聊接力、@点名、PASS、免费交接、无进展暂停、群纪要。
- T2：后台助手槽位 + usage 流水。
- T3：桌面房间视图、手机只读、IM 出口。
- A2A 只在 T1 完成后做：Agent Card、任务 endpoint、鉴权、push notification；没有团队对象之前不做协议演示。

验收：两个 Bot 完成一次往返；kill sidecar 后 `uncertain` 不重放、`held` 可恢复；群聊 maxHops 收敛。

### 8.6 Computer use

阶段：

1. 浏览器能力硬化：独立 profile、下载隔离、egress 白名单、权限提示、录制/回放。
2. macOS 桌面控制：Accessibility API 枚举窗口/控件、点击/输入/按键、截图；按应用授权。
3. Windows UIA 后续；Linux 暂不支持。
4. 安全：无人值守默认禁用；敏感应用黑名单；每次会话显式授权；全局 kill switch；审计。
5. 复用 `browser-tools.ts` / `screenshot-tool.ts` / `see_image`，不重造视觉链路。

验收：能在独立 profile 完成一次登录态网页操作；桌面控制必须用户显式授权；所有动作可审计、可停止。

---

## 9. 横切工作

- 协议：新增命令同步 `protocol.ts`、`pi-bridge.ts`、`remote.ts` 拒绝清单、移动端类型（至少不崩）。
- 迁移：MCP cache v1→v2；Connector `connectorId` 对旧配置可选；ACP 旧子代理默认 `backend: kova`。
- 观测：MCP 审计增加 connector/task/elicit；ACP 记录外部进程生命周期；trigger 记录来源和幂等键。
- 安全：外部内容脱敏、输出截断、命令系统层白名单、工作区配置不产生执行授权。
- 文档：`docs/mcp-2026.md`、`docs/connectors.md`、`docs/acp-client.md`、`docs/event-triggers.md`、`docs/checkpoint-fork.md`、`docs/memory-dreaming.md`、`docs/workflow-engine.md`、`docs/bot-team.md`、`docs/computer-use.md`。
- 测试：fake MCP server 扩展 resources/prompts/elicitation/tasks；fake ACP agent；webhook/file/git fixture。

## 10. 验证

每个里程碑至少跑：

```bash
bun run --filter pi-agent-sidecar test:isolated
bun run test:protocol
bun run test:desktop
bun run test:runtime
bun run --filter kova-electron-main test
bun run typecheck
bun run build
```

手工 E2E：

- M1：安装 Connector → OAuth → tools/resources/prompts → elicitation → revoke。
- M2：长任务进度 → 取消 → Inbox 结算；header token 不出现在日志。
- M3：配置外部 ACP agent → Task 调用 → 权限允许/拒绝 → Stop。
- 事件触发：webhook / 文件 / git / IM 各触发一次；关窗后仍运行。
- Checkpoint：从检查点分叉到独立目录；重放。
- Memory：Dream now → 审阅 diff → 接受/拒绝 → 回滚。
- Workflow：示例流程 → 人工闸门 → kill 后恢复。
- Bot Team：两 Bot 往返；群聊收敛。
- Computer use：独立 profile 网页操作；桌面控制需显式授权。

## 11. 明确不做

- M1–M3 不做 MCP Apps；等 sandboxed UI 运行时和生态稳定后再立项。
- 不做 A2A，直到 Bot Team T1 有可暴露的团队对象。
- 不做 20 个 Connector；先 3 个真闭环。
- 不做通用 BPMN / 可视化工作流画布。
- 不做向量数据库优先；文件 + 关键词检索仍是主存储。
- 不做无限制桌面控制；Computer use 永远保留显式授权和 kill switch。

## 12. 风险与待确认

| 风险 | 影响 | 处理 |
|---|---|---|
| MCP SDK experimental Tasks 变更 | M2 返工 | 只通过 `mcp-tasks.ts` adapter 使用；锁版本 |
| 首批 Connector 的远程 MCP/OAuth 不稳定 | M1 范围缩水 | 只上有稳定端点的；没有的延后，不写 native API |
| ACP adapter 命令/协议差异 | M3 接入失败 | 首个 preset 先检测本机；保留自定义命令；fake agent 测试 |
| 外部 agent 绕过 Kova 沙箱 | 安全边界 | 系统层配置、cwd 限制、无 secrets、审批、审计、UI 警示 |
| Headless v1 仍依赖 Electron | 服务器场景不可用 | 明确“后台常驻”而非 daemon；v2 再拆 |
| MCP Prompts 注入 | 提示词污染 | 按用户内容处理、来源标注、不自动发送 |
| 工作区配置提权 | 仓库带来执行 | 标准层忽略 kova 字段；工作区命令默认关闭 |

## 13. 变更记录

- 2026-11-16：初版计划，确定 M1–M3 与后续顺序。
