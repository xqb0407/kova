# MCP 网关与技能加载优化

> **实施状态（2026-11-19）**：P1–P5 已落地。验证：sidecar 194 个测试文件全绿、
> desktop 1480 用例全绿、双 typecheck 干净。

状态：已实现。
日期：2026-11-19。
范围：P1–P5；不含版本号变更。
原则：参考成熟实现的模式，不照搬实现与文案；所有结论以本仓库代码事实为准。

## 1. 背景

对照同类成熟实现后，Kova sidecar（`apps/sidecar/pi-agent`）在 MCP 调用与技能加载上有三处结构性损耗，另有一处审批粒度缺口：

1. **MCP 调用固定三跳**。`mcp({action:"search"})` 只返回工具名与描述，参数 schema 需要单独 `action:"describe"`，再 `action:"call"`。每个 MCP 调用多出两轮整段上下文重发（`src/mcp/mcp-tools.ts:434`、`:481`、`:1021`）。
2. **单网关收口后没有快路径**。成熟实现普遍同时提供“每个工具一等公民”和按需搜索；sidecar 所有调用都必须经过网关，高频工具也不例外。
3. **技能目录无预算、正文无上限**。目录段只有每层 64 条的数量上限（`src/skills/discovery.ts:97`），接 `.claude/skills` 后提示词可膨胀；`use_skill` 读正文没有字节闸门（`src/skills/skill-use-tool.ts:100-123`）。
4. **审批只有“本项目记住”一档**。用户级与本地级免审批名单的读取端已存在（`src/permissions/write-roots.ts:777` 合并 user+local 的 `allowMcpTools`），但用户级没有写入端，会话级缺失，审批卡只有一颗“允许并记住”按钮。

## 2. 现状事实

| 能力 | 现状 | 关键文件 |
|---|---|---|
| MCP 工具索引 | 连接中取实时清单，断连取元数据缓存；`McpToolMeta` 已含 `inputSchema` | `src/mcp/mcp-tools.ts:178`、`src/mcp/mcp-cache.ts:30` |
| MCP 搜索输出 | 纯文本 name + description，带 score；不含参数 | `src/mcp/mcp-tools.ts:434-480` |
| MCP describe | 返回完整 JSON Schema | `src/mcp/mcp-tools.ts:481-505` |
| MCP 调用管线 | 懒连接 → 白名单 → 审批/审查 → task 分流 → 输出防护 → 审计 | `src/mcp/mcp-tools.ts:1021-1239` |
| 工具注入 | `hasEnabledMcp` 时注入单个 `mcp` 网关 | `src/tools/tools.ts:896-902` |
| 工具表重建 | 仅按“网关是否存在”判断 | `src/sessions/resolve.ts:563-585` |
| 技能目录注入 | 库格式化器直出，无预算 | `src/skills/discovery.ts:385-394` |
| 技能正文加载 | 读盘后原样返回 | `src/skills/skill-use-tool.ts:100-123` |
| 审批落盘 | 项目本地 `.kova/permissions.local.json` | `src/permissions/write-roots.ts:214-227` |
| 审批卡 | 单按钮“允许并记住”，payload 只有 `canRemember` | `src/mcp/mcp-tools.ts:1379-1442`、`apps/desktop/components/agent-thread/tool-approval-card.tsx:392-417` |
| 系统提示词 MCP 段 | 已有服务器清单（上限 20，含 description），无工具数 | `src/mcp/mcp-tools.ts:1494-1510` |

## 3. 目标与非目标

**目标**

- MCP 常见调用从 3 跳降到 2 跳；配置为直接暴露的高频工具降到 1 跳。
- 技能目录注入有明确字节预算，正文加载有字节闸门。
- MCP 审批支持“本会话 / 本项目 / 所有项目”三档记住。

**非目标**

- 不改版本号。
- 子代理不获得直接暴露工具（仍用网关 + 作用域白名单）。
- 不引入完整的四档曝光模型；只做 `gateway | direct` 两档。
- 不放宽现有纪律：工具表字节稳定、工作区层不能给自己授权、审批先于执行。

## 4. 方案

### P1 · search 内联参数表（三跳 → 两跳）

新增 `src/mcp/mcp-schema-summary.ts`：

- `summarizeInputSchema(schema, opts)`：JSON Schema → 单行参数摘要，支持 `properties/required/enum/items/嵌套对象（深度 2）`；缺失或非法 schema 回退 `(no parameters)` 或类型名。
- `needsRawSchema(summary)`：摘要含嵌套省略标记或超 200 字符时为 true。
- `truncateUtf8(text, maxBytes)`：UTF-8 安全截断，P3 复用。

改 `src/mcp/mcp-tools.ts`：

- 抽出纯函数 `formatSearchResults(scored, opts)`，每条命中输出 `server__tool — description` 加 `  params: ...` 行；仅 top-3 且 `needsRawSchema` 时追加原始 schema（单条 ≤1200B）；总文本预算 8KB。
- 文本去掉 `(score N)`，移入 `details.scores`；`details` 增加 `schemasIncluded`，保留 `names`。
- 更新工具描述：search 已含参数，参数清楚直接 call；describe 只用于复杂 schema 或未命中工具。

兼容性：模型可见文本变化，协议无变化；不改变搜索排名与缓存。

### P2 · 直接暴露白名单（混合模式）

- 配置：`McpServerDef` 增加 `expose?: "gateway" | "direct"`（默认 gateway）；加入 `KOVA_ONLY_FIELDS` 与 `applyKovaFields`；标准层 `.mcp.json` 忽略并记诊断；`computeConfigHash` 不含该字段。
- 写路径回环（**必须同批完成，否则设置页编辑一次就丢配置**）：`McpDraft`（`src/mcp/mcp-config.ts:927`）、`emitEntry`（`:971`）、`mcpServersPayload` 条目（`src/protocol/payloads.ts:120-145`）、`mcpDraftFromMessage`（`:385-426`）、桌面 `McpServerDraft`（`apps/desktop/lib/mcp/mcp.ts:47`）、设置页 `FormDraft`/`formToDraft` 与编辑弹窗 toggle。
- 工具声明：新增 `buildDirectMcpTools(...)`（同类工具复用 `loadMcpServersSync`、`mcpManager.getLiveTools`、`getValidTools`、`isToolEnabledBy`）；工具名 `mcp__<server>__<tool>`，sanitize、≤64 字符、去重、总数上限 32；`parameters` 直接用 MCP `inputSchema`（`AgentTool.parameters` 接受任意 JSON Schema），非法/缺失回退空对象 schema。
- 调用管线：把 `executeCall` 主体抽成 `callMcpToolByFullName({...})`，网关 call 与直接工具共用审批/task 分流/输出防护/审计。
- 注入与重建：`src/tools/tools.ts` 在网关之外追加直接工具；子代理不动；`reloadMcpToolsIfPresenceChanged` 的判定扩展为“网关存在性 + 直接工具全名排序列表”。
- 已知限制：缓存为空（首个会话）不下发直接工具；连接后新增工具不自动重建，需配置/启停变化触发。
- 审批展示：直接工具复用现有 MCP 审批卡（`toolName:"mcp"`），本轮不改卡面；转录行显示 `mcp__...`。

### P3 · 技能预算与正文闸门

- `src/skills/discovery.ts`：`SKILLS_PROMPT_BYTE_BUDGET = 12_000`、`SKILL_DESCRIPTION_MAX_CHARS = 250`；`budgetSkillsForPrompt` 按 `mergeLayers` 现有优先级顺序截断 description，超预算从尾部丢条目，末尾追加一行省略名单（名字上限 20，仍可按名 `use_skill`）；`skillsPromptBlock` 改走该函数。
- `src/skills/skill-use-tool.ts`：`MAX_SKILL_BODY_BYTES = 100_000`，截断后追加提示，`details.truncated = true`。
- 兼容性：仅影响系统提示词文本；省略行保证技能仍可被按名加载。

### P4 · 审批作用域

- 线格式（加性）：`tool_confirm` 增加可选 `rememberScope: "session" | "project" | "user"`；审批卡 payload 增加 `rememberScopes` 数组；`packages/pi-protocol/src/interactions.ts` 的 `permissionPayloadSchema` 增加同名字段（looseObject，旧行可读）。
- Sidecar：`resolveMcpApproval`/`applyToolConfirm`/`ToolConfirmInput` 增加可选 scope；会话级用 per-thread 内存集合，并在 `forgetThreadStates`（`src/sessions/registry.ts:289`）清理；项目级写 `.kova/permissions.local.json`（现行为）；用户级写 `~/.kova/permissions.json`（`layerPaths` 已有路径，不调用 `ensureGitignored`）。
- 结算入口：桌面卡片、Inbox、ACP、IM 均走同一 `applyToolConfirm`；未传 scope 的入口回落 `project`，行为与今天一致。
- 桌面：`PendingToolApprovalView` 增加 `rememberScopes`；`confirmToolApproval` 增加可选末位参数；MCP 审批卡用现成 `dropdown-menu` 提供三档，非 MCP 审批保持原按钮。
- 安全边界：只有用户在卡上显式选择才写用户级文件；工作区层配置永远不能触发用户级授权。

### P5 · 服务器摘要增量

`mcpPromptBlock` 已存在（上限 20 台、含 description）。本次补：每行追加 `(N tools)`（N 取 `getValidTools`，只读缓存，避免连接后抖动）；文案与 P1 对齐为 `search (params included) → call`。无启用服务器仍返回空串，保持字节稳定约定。

## 5. 影响面

| 层 | 涉及项 | 影响与兼容性 |
|---|---|---|
| 纯内部 | P1 搜索格式化、P3 预算/截断、P5 文案 | 仅模型可见文本；协议与落盘不变 |
| 配置契约 | P2 `expose` | 新增可选字段；需同批打通 payload/draft/设置页回环 |
| 线格式（加性） | P4 `rememberScope`、`rememberScopes` | 旧客户端不传 → project；旧挂起行无字段 → 旧按钮 |
| 工具声明面 | P2 `mcp__server__tool` | 仅 opt-in 服务器；cap 32；影响该会话工具表与 ACP 工具列表 |

调用方清单：

- P2：`src/mcp/mcp-config.ts`、`src/protocol/payloads.ts`、`src/tools/tools.ts`、`src/sessions/resolve.ts`、`apps/desktop/lib/mcp/mcp.ts`、`apps/desktop/components/settings/components/mcp-settings.tsx`。
- P4：`src/protocol/handlers/interactive.ts`、`src/inbox/index.ts`、`src/acp/agent.ts`、`apps/electron/main/im/router.ts`、`apps/desktop/lib/pi/pi-interactions.ts`、`apps/desktop/components/agent-thread/tool-approval-card.tsx`、`packages/pi-protocol/src/interactions.ts`、`src/sessions/registry.ts`。

不受影响：版本号、子代理 MCP 作用域、配置哈希与密钥绑定、审计、task 分流、技能设置页清单、Connectors 目录。

## 6. 兼容与回滚

- P1/P3/P5 回滚 = 还原常量与格式化函数，无数据迁移。
- P2 回滚 = 删除 `expose` 字段或改回 gateway；已写字段被旧版本当作未知字段忽略（标准层）或诊断（覆盖层），不会阻断加载。
- P4 回滚 = 客户端不传 `rememberScope` 即回到今天的 project 行为；已写入用户级名单是普通 JSON 条目，可手工删除。

## 7. 验证

| 层 | 验证 |
|---|---|
| sidecar MCP | `bun test test/mcp`（含新增 schema summary、direct 工具、scope 落盘用例） |
| sidecar 技能 | `bun test test/skills`（预算截断、正文截断） |
| sidecar 全量 | `bun scripts/run-tests-isolated.mjs`、`bun run typecheck` |
| 桌面 | `bun test lib`、`bun run typecheck` |
| 手工 | fake server：search 直接 call → `expose:"direct"` 出现 `mcp__fake__echo` → 三档记住分别落到内存 / local / user 文件 → 设置页编辑后 `expose` 不丢 |

## 8. 执行顺序

1. P1（独立、收益最大）
2. P3（独立、纯 sidecar）
3. P5（依赖 P1 文案）
4. P2（含设置页回环，先后端后桌面）
5. P4（协议 + sidecar + 桌面，最后做）

每步保持独立可合并；P2/P4 各自补一组回归测试后再进入下一步。

## 9. 风险与开放问题

- P1 摘要可能诱导模型跳过 describe 直接 call 错嵌套参数 → 复杂 schema 仍内联原文，describe 保留。
- P2 工具声明变化影响前缀缓存 → 仅 opt-in、cap 32、只在表面签名变化时重建。
- P2 设置页回环遗漏会静默丢配置 → 已列入同批实现与验证。
- P3 截断隐藏技能 → 省略名单保留名字。
- P4 权限语义 → 用户级写入只发生在审批结算内；工作区层永不授予。
- 开放问题：直接工具的审批卡是否显示真实工具名（当前复用 `mcp` 卡面），暂定不改，收集反馈后再定。
- 远程会话的 MCP 网关与直接工具始终在**本机 sidecar** 执行（`mcpManager` 不分远程/本地）；
  远端工作区的 `.mcp.json` 不会在本机被读取，实际生效的是系统层配置。属既有行为，
  本次未改变，记录待后续远程 MCP 方案统一处理。
- PTC（`run_code`）的工具面由只读白名单决定，网关与直接暴露工具都不在名单内；
  若未来开放，子调用仍走 `runToolCall`（审批/审计同链），白名单是唯一控制点。

## 10. 交叉审查后的加固（2026-11-19）

首轮实现后经交叉审查补齐：

- **设置页回环**：`enabledTools` 与 `connectorId` 纳入表单草稿往返——此前编辑任意 MCP
  服务器会静默丢掉工具白名单（授权面反向放宽）与 Connector 身份。
- **作用域闸门**：子代理的 MCP 白名单改按「已知服务器最长前缀」判定；朴素
  `split("__")[0]` 会让只允许 `crm` 的子代理调 `crm__prod__tool`。
- **记住作用域全通道**：Inbox 审批卡支持本会话/本项目/所有项目三档；ACP 在结构化选项里
  增加「所有项目」一档；IM 保持 project（文本通道不做三档）。
- **直接工具 schema 闸门**：单工具 schema 超过 16KB 时不单独声明，退回网关可调用，
  避免异常 schema 拖垮整张工具表。
- **会话授权迁移**：sidecar 在 threadId 改绑（UI 刷新）时迁移会话级免审批，不再因刷新失效。
- **边界修正**：空 `enum` 不再产出空类型；摘要与技能 description 截断均按 code point，
  不切开代理对。

验证：sidecar 194 个测试文件全绿、desktop 1480 用例全绿、双 typecheck 干净。
