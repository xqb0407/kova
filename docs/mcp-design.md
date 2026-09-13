# MCP 客户端接入设计

> 目标:让 agent 能使用 Model Context Protocol(MCP)服务器的工具,同时不破坏本项目的
> 两条既有铁律——**工具表字节级稳定**(提示词前缀缓存命中)与**审批回路复用**(`tool_confirm`)。
> 默认以一个常驻网关工具(代理模式)暴露全部 MCP 工具,配置/设置 UI 照搬 subagents 体系模式。

## 1. 背景

MCP 生态有大量现成能力(GitHub、数据库、浏览器、各类 SaaS API)。接入方式有两种业界参照:

- **全量注册**(PI-Desktop 路线):把每个 MCP 工具作为独立工具注册进模型工具表。
  模型调用体验最好,但一个服务器就能带来 10k+ token 的 schema,且服务器增删会改写工具表。
- **代理模式**(pi-mcp-adapter 路线):只注册一个 ~200 token 的网关工具,模型先
  `search` 发现、再 `call` 调用,用元数据缓存保证断连状态下也能搜索。

本项目 sidecar(`sidecar/pi-agent`)基于 `@earendil-works/pi-agent-core` 0.85.1,
该库**不含任何 MCP 支持**(已核实 `dist/` 无 mcp 模块),需要自建客户端。
`pi-mcp-adapter` 是为 `pi-coding-agent` 完整应用的扩展宿主(pi.extensions / pi TUI)编写的,
无法直接装入本项目,但其模块级实现是重要的抄作业来源。

## 2. 关键约束

1. **工具表稳定是缓存前提**。`tools.ts` 中 `SYSTEM_PROMPT_CORE` 与全部工具 schema
   会话间字节级不变,OpenAI 前缀增量与 Anthropic tools 块才能命中缓存(memory 工具的
   "常驻注册(工具表稳定缓存友好)"注释即此意)。MCP 服务器是用户运行时配置,
   动态注册会打爆缓存 → 默认只能走代理模式。
2. **审批回路已存在**。`protocol.ts:1425` `tool_confirm` + `data-toolApproval` chunk
   (approvalId/toolCallId/toolName/input)承载逐工具审批;MCP 调用必须复用该回路,
   不新造机制。
3. **执行分层的现状**:工具 schema 留 sidecar、重执行下沉 Rust 宿主
   (`tool_exec.rs`,bash 杀进程树 / http 出口统一)。但 MCP 连接是长活有状态物
   (stdio 子进程、SSE 流、会话 id),协议层状态留在 TS 侧最自然;Rust 宿主不参与 MCP 协议。
4. **运行时是 Bun 编译单文件**(`bun build --compile`)。依赖选择必须过 Bun 兼容性
   这一关(`@modelcontextprotocol/sdk` 的 fetch/child_process 路径需 P0 冒烟验证)。
5. **配置体系已有双层惯例**:系统层 `~/.xulux/*`(subagents),工作区层 `<cwd>/.xulux/*`
   (subagents / plans / 随仓库共享);启停状态落 SQLite kv(`set_subagent_enabled` 模式)。
6. **Windows 孤儿进程教训**:bash 因此下沉 Rust。MCP stdio 子进程若 sidecar 异常退出
   会残留,必须有进程树清理手段(见 §8.4)。

## 3. 方案选型

| 方案 | 说明 | 结论 |
|---|---|---|
| A. sidecar 自建客户端 + 官方 SDK + 代理网关工具 | `@modelcontextprotocol/sdk` 管连接,`mcp` 单工具代理全部服务器 | **采用**(Bun 冒烟失败则退 B) |
| B. sidecar 自建客户端 + 手写最小协议 | 只实现 initialize/tools/list/tools/call,NDJSON + Streamable HTTP(约 600 行,PI-Desktop 同款) | 备选(A 的 Bun 兼容性兜底) |
| C. MCP 工具全量注册 | 每服务器每工具一个 AgentTool | 否决:违反约束 1;仅作为 P1 的**按服务器显式选项**(`directTools`)保留 |
| D. 复用 pi-mcp-adapter 包 | 直接 import 其 config/cache/oauth 导出 | 否决:peerDeps 拖入 pi-coding-agent/pi-tui 全家;其模式按模块照抄(§10) |
| E. 连接管理下沉 Rust 宿主(rmcp) | Rust 管 MCP 会话,sidecar 走 RPC | 否决:工具 schema 最终要在 TS 侧喂 LLM,状态跨进程复制两份;P0 无收益 |

**连接层归属**:sidecar 进程内全局单例(跨会话共享连接池,同 PI-Desktop 的
UserMcpRuntime),懒连接 + 空闲断开兜底资源占用;不按会话隔离(MCP 服务器无会话语义)。

## 4. 配置设计

### 4.1 文件与分层(低 → 高)

| 层 | 路径 | 形态 | 语义 |
|---|---|---|---|
| 系统层 | `~/.xulux/mcp.json` | 完整 schema | 机器级,含 adapter 专属字段 |
| 工作区标准层 | `<cwd>/.mcp.json` | **生态标准格式**(mcpServers map) | 随仓库共享,其他工具(Claude Code 等)可直接复用;只认 `command`/`args`/`env`/`url`/`headers`/`type` |
| 工作区覆盖层 | `<cwd>/.xulux/mcp.json` | 完整 schema | xulux 专属字段(disabled/approveTools/lifecycle…),与 `.xulux/subagents` 同族 |

按服务器 id 合并,高层整条覆盖低层同名 id;同 id 不同 transport 视为不同定义。
**URL 变更即丢认证字段**(headers/env 中疑似凭证项),照抄 pi-mcp-adapter 的
`URL_BOUND_AUTH_FIELDS` 防护——防止共享配置把服务器指向偷换后旧凭证跟着走。

启停状态**不入文件**:落 SQLite kv(键 `mcp.disabled.<层>.<id>`,经 hostdb),
本地机器私有——工作区共享文件里不应写个人开关,语义同 subagents 的 `set_subagent_enabled`。

### 4.2 schema

```jsonc
{
  "mcpServers": {
    "github": {
      // 二选一:stdio
      "command": "npx",                    // 禁相对路径含 ".."
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      // 或 http:
      // "url": "http://192.168.1.20:8080/mcp",   // 非 loopback 明文 HTTP 允许但 UI 警告
      // "headers": { "Authorization": "Bearer ..." },
      "type": "stdio",                     // 可省略;command→stdio,url→http;兼容 "http"/"sse"

      // ---- 以下为 xulux 层专属(标准 .mcp.json 中出现则忽略) ----
      "disabled": false,                   // 仅作手工编辑入口,UI 开关走 kv
      "lifecycle": "lazy",                 // lazy(默认) | eager | keep-alive
      "idleTimeout": 600000,               // ms,默认 10 分钟
      "approveTools": ["get_*", "list_*"], // 工具名 glob,命中免审批
      "description": "GitHub API"
    }
  },
  "settings": {                            // 全局(可选)
    "approveTools": true,                  // 全局强制审批
    "outputGuard": true
  }
}
```

### 4.3 校验规则(照抄 PI-Desktop `mcp_servers.rs`,TRL 收敛)

- id:`[a-zA-Z0-9_-]{1,64}`(MCP 生态允许数字开头,故比 PI-Desktop 松一档);
- stdio:http 字段互斥;`command` 不含 `..`;args ≤ 64、env ≤ 64 条、单值 ≤ 4KB;
- http:stdio 字段互斥;url 必须绝对且 scheme ∈ {http, https};headers ≤ 32 条;
- 上限:系统+工作区合并 ≤ 32 个服务器,每服务器 ≤ 64 工具,活跃连接 ≤ 16。

## 5. 核心机制

### 5.1 模块划分(sidecar 新增,全部配 `*.test.ts`)

| 文件 | 职责 |
|---|---|
| `mcp-config.ts` | 加载/合并/校验双层配置;标准 `.mcp.json` 适配(字段推断 transport) |
| `mcp-manager.ts` | 连接池单例:懒连接、生命周期、退避、超时、工具发现、call 转发 |
| `mcp-cache.ts` | 元数据缓存:`~/.xulux/mcp-cache.json`,配置 SHA256 + TTL,断连可 search/describe |
| `mcp-output-guard.ts` | 结果截断/溢写/摘要(照抄 pi-mcp-adapter `mcp-output-guard.ts`) |
| `mcp-tools.ts` | 网关工具 `mcp` 的 schema 与 execute,挂入 `buildTools()` |

### 5.2 连接管理(`mcp-manager.ts`)

- **懒连接**:首次 `call` 才握手;`search`/`describe` 走缓存不连接(代理模式体验关键)。
- **超时**:连接 10s、调用 120s(与 bash 默认 timeout 对齐);握手失败 60s 退避期,
  期间 search/call 立即返回该服务器不可用,不重复付超时代价(pi-mcp-adapter `failure-backoff`)。
- **生命周期**:`lazy`(调用完可被空闲回收)/ `eager`(会话启动即连)/ `keep-alive`
  (保持 + 30s 健康检查)。空闲默认 10 分钟断开,下次调用重连。
- **重连**:stdio 进程退出 / HTTP 会话失效(404 + Mcp-Session-Id)→ 下次调用自动重连;
  单次 call 内不自动重试(避免重复副作用),错误原样上报。
- **call 语义**:对未在服务器广播列表中的工具名拒绝转发(防幻觉工具名直达服务器);
  服务器被禁用/删除后,缓存里残留的工具名同样拒绝。
- **AbortSignal 透传**:`AgentTool.execute` 的 signal 直接映射为对 MCP 服务器的
  request 取消,与现有 bash 中断(host_cancel)行为一致。

### 5.3 网关工具(常驻注册,一个)

```ts
// tools.ts buildTools() 追加,mcp-tools.ts 提供
{
  name: "mcp",
  label: "MCP",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("search"), Type.Literal("describe"),
      Type.Literal("call"),   Type.Literal("status"),
    ]),
    query: Type.Optional(Type.String()),   // search
    tool:  Type.Optional(Type.String()),   // describe/call:"<server>__<tool>"
    args:  Type.Optional(Type.String()),   // call:JSON 字符串(args 用字符串避免 union schema 膨胀)
    server:Type.Optional(Type.String()),   // search 可选过滤
  }),
  execute: ...
}
```

- 内部工具名 `mcp__<server>__<tool>`;search 结果即返回全名,describe/call 接受全名。
- `status` 返回各服务器 {state: idle/connecting/ready/failed/backoff, toolCount}。
- `textResult` 的 details 携带 `{ server, tool, durationMs, truncated }` 供前端渲染。
- 系统提示词在 Subagents 段后追加 "MCP:" 一段(字节级稳定,入 `SYSTEM_PROMPT_CORE`):
  用法、先 search 后 call、全名约定、工具属第三方内容需谨慎对待的提醒。

### 5.4 元数据缓存(`mcp-cache.ts`)

- 条目:`{ configHash, tools[], prompts?, cachedAt }`;configHash 覆盖 command/args/env/url/headers。
- 读取:search/describe 命中缓存直接返回,同时可异步刷新(过期后台刷新、前台先用旧值)。
- 写入:每次成功握手后全量更新;TTL 7 天,服务器声明 ttlMs 则优先。
- 缓存文件进程启动时加载,写节流(变化后 1s 合并落盘)。

### 5.5 输出防护(`mcp-output-guard.ts`,抄 pi-mcp-adapter)

- 文本:8KB / 1000 行截断;超限溢写 `%TEMP%/xulux-mcp-output-*/output.txt`,
  截断通知附完整文件路径(用户/模型可 read 分页取回)。
- 结构化:超过 16KB 出摘要(内容块计数 + 前 20 块类型/字节预览 + 保留 ≤4KB 小字段)。
- 与 read/grep 的 64KB/200 条截断同哲学:模型拿到的是"有界 + 可续取"的结果。

### 5.6 审批集成

- v1 默认:**MCP call 一律走现有 `tool_confirm` 回路**(与 approvalLevel 解耦,最保守)。
- 免审批条件(满足其一):服务器 `approveTools` glob 命中工具名;`settings.approveTools === false` 显式放行(默认不设)。
- `search`/`describe`/`status` 不触发审批(只读本地缓存与状态)。
- 审批被拒 → 模型收到 blocked 工具结果(现回路语义,`protocol.ts:1426`)。

### 5.7 协议消息(`protocol.ts` 新增,对齐 subagents 消息组风格)

```
{ "type": "list_mcp_servers", "id", "cwd"? }            → { id, "mcp_servers", servers, cacheMeta, workspaceCwd, diagnostics }
{ "type": "save_mcp_server", "id", "layer", "cwd"?, "definition" } → 校验+写文件+热重载 → 同款 mcp_servers 应答
{ "type": "delete_mcp_server", "id", "layer", "name", "cwd"? }     → 删文件+断连+热重载 → 同款
{ "type": "set_mcp_server_enabled", "id", "layer", "name", "cwd"?, "enabled" } → 落 kv+热重载 → 同款
{ "type": "test_mcp_server", "id", "name", "cwd"? }     → { id, "mcp_server_test", status } // 强制重新握手
```

- `status`: `{ name, layer, transport, state, toolCount, toolNames?, message? }`(state 同 §5.2 四态)。
- 热重载 = manager 按新配置 diff 连接池:配置变更/禁用 → 断连;删除 → 释放;
  系统提示词与工具表**不变**(代理模式无需重注入)。
- settings 变更通过现有 `get/set` 系列消息之外单独走以上消息,不塞进 personalization。

## 6. 前端配合

- **设置页**:`components/settings/mcp-settings.tsx`,克隆 `subagents-settings.tsx` 的骨架:
  双层分组(系统/工作区)+ 每行(transport 图标、名称、启停开关、状态徽章:ready·N 工具 /
  connecting / failed + message)+ 行菜单(测试连接、删除,armed 二次确认)+
  编辑 Sheet(transport 切换、env/headers 键值编辑、非 loopback HTTP 红色警告条、保存/测试)。
  路由挂入 settings-page.tsx,搜索索引进 `lib/settings-search.ts`。
- **对话内渲染**:`lib/tool-panel.ts` 为 `mcp` 工具加条目——action 徽章
  (search/describe/call/status)、call 显示 `server__tool` 与耗时、truncated 提示;
  结果正文走现有 markdown 渲染,无新组件。
- **i18n**:新增键集中在 `settings.mcp*` / `extensions.mcp*` 命名空间下,中英同步。

## 7. 安全设计(两参照项目各取所需)

| 项 | 决策 | 来源 |
|---|---|---|
| 子进程环境 | PATH/temp/locale + 显式 env,**不继承 sidecar 全量环境**;P1 支持 `{ "setting": "credentials.<key>" }` 引用宿主凭证表 | PI-Desktop D018 |
| 命令策略 | 用户自配 = trusted(可任意机器内二进制),仅禁 `..` 相对路径;无插件场景故不需要 confined 沙箱 | pi-mcp-adapter 两级策略的收敛 |
| 明文 HTTP | 允许非 loopback(局域网自建服务器是真实需求),编辑器强制警告"凭证与调用可被截获",保存即同意 | ADR 0142 |
| 重定向 | 手动跟随(≤5 跳,仅 http/https);带凭证请求 `redirect: "error"` | 两家取严 |
| 工具风险 | 不采信服务器自报风险;审批默认全开(§5.6) | PI-ADR 0038 |
| 第三方内容 | 系统提示词注明 MCP 结果是不可信外部内容,防注入指令的提示照 webfetch 现有口径 | 本项目惯例 |

## 8. 测试要点(sidecar bun test)

1. **配置**:双层合并优先级、标准 `.mcp.json` 字段推断、URL 变更丢凭证、校验错误文案。
2. **连接**:fake stdio MCP server(`test/fake-mcp-server.mjs`,NDJSON 应答
   initialize/tools/list/tools/call)驱动:懒连接、握手失败退避、空闲断开、
   会话失效重连、工具名白名单拒绝、abort 取消。
3. **缓存**:configHash 命中/失效、TTL、断连 search。
4. **输出防护**:8KB/1000 行截断 + 溢写文件存在性、大 JSON 摘要形态。
5. **协议**:五消息往返(仿 `subagent-mgmt.test.ts`);审批拒绝路径;
   热重载 diff(改 env 断连、改 label 不断连)。
6. **工具**:`mcp` execute 四 action 分派、args JSON 解析错误、全名解析。
7. **Bun 冒烟(P0 第一步)**:`@modelcontextprotocol/sdk` 在 `bun run src/index.ts`
   下完成一次 stdio 握手 + 一次 call;失败即切方案 B(§3)。

## 9. 分阶段交付

- **P0(一个 PR 量级)**:stdio + Streamable HTTP;双层配置;`mcp` 网关工具四 action;
  懒连接/退避/缓存;输出防护;逐次审批;设置页 + 测试连接;协议五消息;§8 全部测试。
- **P1**:每服务器 `directTools: true | string[]`(显式配置才动态注册;保存即热重载,
  缓存代价由低频显式变更兜住);凭证引用接宿主 credentials 表;MCP prompts 映射斜杠命令;
  resources 只读暴露(search 内一类)。
- **P2(按需再启动)**:OAuth 2.1(RFC 9728 发现 / PKCE / 动态客户端注册 / OS keyring,
  照抄 pi-mcp-adapter `mcp-auth.ts` 体系,约 180KB 等价物);sampling / elicitation;
  非 loopback HTTP 之外的传输扩展。**v1 明确不做 OAuth**——bearer/headers 覆盖绝大多数场景。

## 10. 从参照项目抄什么(索引)

| 借鉴点 | 来源 | 落点 |
|---|---|---|
| 校验规则、配置不含激活态、项目遮蔽全局 | PI-Desktop `mcp_servers.rs` | §4 |
| 逐跳重定向校验、凭证 `redirect: error` | PI-Desktop `plugin-mcp.ts` | §7 |
| 代理网关 + search/describe/call 动作、失败退避、元数据缓存 | pi-mcp-adapter `proxy-modes/lifecycle/metadata-cache` | §5.2–5.4 |
| 输出防护(截断+溢写+摘要) | pi-mcp-adapter `mcp-output-guard.ts` | §5.5 |
| URL 绑定认证字段防护 | pi-mcp-adapter `config.ts` | §4.1 |
| 非 loopback HTTP 警告交互 | PI-Desktop ADR 0142 | §7 |

## 11. 已知取舍与开放问题

- **stdio 孤儿进程(Windows)**:sidecar 直接 spawn,正常路径 `session_shutdown`/abort
  时 kill;异常退出可能残留 → 收尾用 `taskkill /T /F` 按根 pid 清进程树
  (pi-mcp-adapter `request-headers-command` 同款手法)。若仍不够,再加 Rust
  `mcp_spawn/mcp_kill` 宿主方法(§3-E 的轻量变体,只管进程不管协议)。
- **args 走 JSON 字符串**:部分模型对嵌套 union schema 不稳,字符串形态更鲁棒;
  若实测主流模型对象形态无碍,可放宽为 `Type.Union([Type.Object, Type.String])`。
- **缓存与多工作区**:缓存按 configHash 键控,天然跨工作区安全;不按 cwd 分目录。
- **eager 服务器的启动时机**:P0 挂在 sidecar 进程启动后(首个会话创建前)后台连,
  失败静默转 backoff;是否需要"每会话重连"由 P1 观察。
- **`.mcp.json` 中 `type: "sse"`**:标准层识别并兼容,但 xulux 层校验仍只接受
  stdio/http 两态(与 §4.3 一致);SSE 作为 http 的回退逻辑在 manager 内部处理。

## 12. 实现记录(2026-09-13,P0 交付)

方案 A(官方 SDK)落地,与上文的偏差与落地细节:

1. **SDK 冒烟结论**:`@modelcontextprotocol/sdk@1.30` 在 Bun 下可用,但必须显式
   `bun add zod`(SDK 的 zod v3/v4 兼容层 `zod/v3` 子路径需要顶层解析);stdio 与
   Streamable HTTP 握手均过,`bun build --compile` 打包 1765 模块成功。
2. **提示词段改走动态块**:未按 §5.3 修改 `SYSTEM_PROMPT_CORE`,而是新增
   `mcpPromptBlock(cwd)`(mcp-tools.ts)挂入 `composeModeSystemPrompt`(记忆段之后),
   无启用服务器时为空串——默认提示词字节级不变,完全复用 memoryPromptBlock 的
   缓存纪律。块内列出已启用服务器名与描述,模型无需 search 即知可用集成。
3. **审批 chunk 复用 `data-toolApproval`**:`approvalId = "<toolCallId>:mcp"`,
   挂起表在 mcp-tools.ts 模块级(同 question-tools 形态);protocol 的 `tool_confirm`
   先查 run 内审批、回退 MCP 挂起表;Stop/新 prompt 经 `cancelPendingMcpApprovals`
   兜底结算。前端审批卡零改动即兼容,仅 `summarizeInput` 加了 mcp 分支。
4. **stdio 子进程环境**:直接依赖 SDK `StdioClientTransport` 内建的
   `getDefaultEnvironment()` 白名单合并(HOME/PATH/SHELL/TERM/USER + Windows 变量,
   并剔除函数型变量),与 §7 的白名单语义等价,无需自建。
5. **eager 生命周期 P0 收敛为 keep-alive 语义**(不参与空闲回收;不做启动预连),
   独立语义留 P1。
6. **search 未做 regex/分页**:字段加权(名 12 / 服务器 8 / 描述 5;完整 10× > 前缀
   6× > 包含 3×)+ 全名命中 +4,limit 默认 12 上限 40;regex 与分页留 P1。
7. **`lib/tool-panel.ts` 无需特判**:mcp 结果是纯文本,走通用工具行;工具面板
   定向打开不适用。
8. **设置页形态**:克隆 subagents-settings 双层骨架,新增非 loopback HTTP 警告条、
   连接状态点(idle/connecting/ready/backoff)、每行"测试"按钮(强制重新握手)。
9. **测试**:fake stdio server(test/fake-mcp-server.mjs,含分页/isError/环境检查/
   自杀路径)+ 本地 HTTP 端点;54 个新用例(配置 16 / 缓存 7 / 防护 10 / 管理器 10 /
   网关 11 / 协议 7...含修订),sidecar 全量 418 用例通过;前后端 tsc 干净,
   `next build` 与 sidecar 编译产物均通过。
10. **遗留(同 §11)**:Windows 孤儿进程仍靠 SDK close(SIGTERM)收尾,进程树
    taskkill 方案待真实使用验证后决定;OAuth / sampling / elicitation / resources
    按 §9 P2 节奏启动。
