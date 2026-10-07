# 垂直业务子代理能力模型设计

日期：2026-10-07
状态：待评审

## 1. 背景与问题

现有子代理定义只有六个字段（`name` / `description` / `tools` / `maxTurns` / `model` / `prompt`），
表达不出一份业务能力。真正的硬阻塞在 `subagent-definitions.ts:68`：

```ts
const KNOWN_TOOLS = ["bash", "read", "write", "edit", "glob", "grep"];
```

`parseSubagentYaml` 对表外的工具名只记 warning，`validateDraft`（写路径）直接报错。
而会话的 `baseTools`（`tools/tools.ts:326`）已经构建了约 20 个工具，含 `use_skill`、
`mcp` 网关、`memory_write/read/search`、`WebFetch` / `WebSearch`、`todo`。
子代理在结构上够不到其中任何一个。

结果：一个垂直业务 agent（客服、售后、风控、数据分析）无法接触它赖以工作的
知识库、MCP 服务器、技能与业务数据，只能读文件跑命令。

## 2. 目标与非目标

### 目标

- 定义文件能声明四个正交能力维度：基础工具、技能白名单、MCP 服务器白名单、知识源
- 能力按需加载（渐进式披露），不预加载正文，不占满上下文
- 作用域是结构性的：未声明即不可达，不是"给了再拒绝"
- 未声明任何新维度的既有定义，行为与提示词字节级不变

### 非目标（本期明确不做）

- 向量 RAG / embedding / 切分。仓库目前无任何此类基础设施，本期不引入。
- 业务 API（HTTP）工具。现有 `WebFetch` / `WebSearch` 无鉴权、无路径约束；
  本期不新建受约束的 `api_call`，业务 API 走 MCP 通道。
- 把垂直业务包做成插件发行形态。`plugins/manifest.ts` 已能打包
  skills + mcpServers + subagents，未来可复用，但不是本期交付物。
- 子代理嵌套委派。维持现状：delegate 不能继续 `Task`。

## 3. 方案选择

评估过三条路径：

**方案 A — 仅白名单扩容。** 把 `KNOWN_TOOLS` 换成真实会话工具目录。成本最低，
但它是平表、无作用域：声明 `mcp` 的子代理能碰到所有已配置服务器，
`skills` / `knowledge` 仍无处声明。表达不了"垂直业务 agent"。**否决。**

**方案 B — 能力授予模型。** 定义携带四个正交维度，每维有独立解析步骤与独立的
提示词目录块。定义本身就是能力包。**采纳。**

**方案 C — 插件作为打包单位。** 发行形态最佳，但在"加一个客服 agent"和
"装一个业务包"之间多一层包装，与"在 YAML 里直接声明"的诉求不符。**否决，
但保留兼容性**：插件层子代理走同一套 schema 与解析器，未来加打包不返工。

## 4. 能力模型

### 4.1 定义 schema

`SubagentDefinition` 在现有字段旁新增三个字段：

```yaml
name: Customer-Service
description: 处理退款咨询与售后政策查询
prompt: |
  你是售后专员……
tools: [read, glob, grep, WebFetch]
skills: [refund-policy, tone-guide]
mcp:
  servers: [crm, notion]
knowledge:
  - name: 产品手册
    type: files
    path: ./docs/**/*.md
  - name: 售后政策库
    type: mcp
    server: notion
    tool: notion__search
maxTurns: 60
```

```ts
export type KnowledgeSource = {
  name: string;
  type: "files" | "mcp";
  /** type = "files"：工作区相对 glob */
  path?: string;
  /** type = "mcp"：服务器名与工具全名 */
  server?: string;
  tool?: string;
};

export type SubagentDefinition = {
  // ...既有字段不变
  skills?: string[];
  mcpServers?: string[];
  knowledge?: KnowledgeSource[];
};
```

`parseSubagentYaml` 的未知键白名单（现 `subagent-definitions.ts:312`）加入
`skills` / `mcp` / `knowledge`。解析错误仍按现有约定降级为诊断，不赔上整个清单。

### 4.2 可授予工具目录

`KNOWN_TOOLS` 改名为 `GRANTABLE_TOOLS`，语义是"允许表的允许表"：

```ts
export const GRANTABLE_TOOLS = [
  // 宿主执行的内置编码工具（tools.ts）
  "bash", "read", "write", "edit", "glob", "grep",
  "task_output", "task_stop",
  // 网络（http-tools.ts 注册名是 CamelCase：WebFetch / WebSearch）
  "WebFetch", "WebSearch",
  // 能力授予目标（skill-use-tool.ts / todo-state.ts / agent-memory.ts）
  "use_skill", "todo", "memory_read", "memory_search",
] as const;
```

**默认不授予、且刻意缺席的工具：**

| 工具 | 缺席理由 |
|---|---|
| `Question` | 子代理问不了用户；其 system prompt（`run.ts:43`）已声明此事 |
| `mcp` | 只能经 `mcp.servers` 授予，不能按裸工具名声明，否则作用域可被绕过 |
| `browser` / `screenshot` / `imagegen` | 属主代理交互面，子代理无 UI 承载 |
| `open_file` / `open_panel` | 发 `data-panelOpen` chunk，子代理无面板 |
| `subagents_*` / `skills_*` / `plugins_*` / `design_themes_*` / `scheduler_*` | 管理面，已在 `resolve.ts:110` 明确排除出 `baseTools` |

大小写不敏感，但**保留原样存库**：会话工具注册名大小写不一致
（`WebFetch` 是 CamelCase，`use_skill` 是 snake_case）。
现有 `parseSubagentYaml` 无条件 `.toLowerCase()`（`subagent-definitions.ts:282`），
对既有六个全小写工具无害，但会让 `webfetch` 永远匹配不上注册名 `WebFetch`——
工具静默解析为空。因此解析改为：先按小写查 `GRANTABLE_TOOLS` 拿到**规范注册名**，
再以规范名落库。解析器不再对 `tools` 逐项小写化。

**解析规则**：YAML 只能命名本表内的工具（大小写不敏感）；落库为规范注册名；
运行时还需该工具确实存在于会话 `baseTools`。两条件都满足才授予。

**现有解析器的相等性缺陷须一并修掉**：`subagent/tools.ts:162` 现为
`baseTools.find((t) => t.name === name.toLowerCase())`——对 `WebFetch` 这类
CamelCase 注册名永远匹配失败。新解析器按规范注册名做精确匹配。

### 4.3 技能授予

`skills` 是按名白名单，解析复用主代理同一套四层发现
（工作区 > 生态·工作区 > 系统 > 生态·用户）。

- 未声明 `skills` → 不注入任何技能目录，`use_skill` 不可用
- 声明了但某技能在当前作用域不存在 → 诊断提示，该条从目录中消失（不静默）
- 目录只含 name / description / location 三行，正文经 `use_skill` 按需加载

### 4.4 知识源

知识源是通用抽象，覆盖形态各异的来源：

- `type: files` — 工作区相对 glob，指向 markdown / 文本 / 表格等本地资料
- `type: mcp` — 命名一个 MCP 服务器与工具（如飞书表格、Notion）

**按需拉取，永不预加载。** 系统提示词只得到每源一行的目录；`kb_search` 对
file 类源做关键词检索，返回排序后的 `path:line` 命中，agent 再自行 `read`。

`kb_search` 上限（防止语料打爆子代理上下文）：

| 上限 | 值 | 理由 |
|---|---|---|
| 单次检索读取字节 | 8 MiB | 覆盖常规产品手册规模 |
| 返回命中条数 | 50 | 与 `grep` 的 200 上限同族，取更紧 |
| 单命中行长度 | 400 字符 | 与 `grep` 一致 |

`type: mcp` 的知识源不进 `kb_search`；目录行直接告知服务器与工具名，
agent 走作用域化的 MCP 网关调用。

**依赖约束**：声明了 `knowledge` 的 `files` 源，就必须同时授予 `read`，
否则 agent 拿到 `path:line` 却打不开文件。此约束在 `validateDraft` 与
`parseSubagentYaml` 的 warnings 里各报一次——解析层只警告（不丢弃定义），
写路径层报错（拒绝保存）。`grep` / `glob` 同理：建议授予但不强制，
强制会让知识型定义无谓地拿到写权限以外的全套检索工具。

## 5. 作用域化 MCP 与审批问题

这是本次设计里唯一需要额外论证的部分。

现状（`mcp-tools.ts:194`）：`buildMcpTool(cwd, threadId)` 暴露全部 active 服务器，
未命中 `approveTools` 的调用进 `requestMcpApproval`（`mcp-tools.ts:426`），
挂起等前端审批卡。

**约束**：子代理在后台跑，没有 UI 线程，也无法向用户提问
（`composeSubagentSystemPrompt` 已写入这条限制）。子代理不能自己协商授权。

**方案**：子代理拿到的是**作用域化网关**，不是共享网关。

1. `search` / `describe`：索引按 `mcp.servers` 过滤，只列已声明服务器的工具
2. `call`：目标服务器未声明 → 立即拒绝，错误文本告知该子代理可用哪些服务器
3. `call`：目标服务器已声明
   - 命中该服务器的 `approveTools` glob → 直接执行
   - 未命中 → **审批卡转发到父线程**（`run.threadId`），用户在父会话看到并裁决

第 3 条是本设计里唯一让子代理能阻塞在人的地方。选择它而非"一律拒绝"的理由：
`approveTools` 默认不配置（`isToolApprovedBy` 在无配置时返回 false），
若一律拒绝，任何未预配置 MCP 服务器对子代理都不可用，垂直业务 agent 形同虚设。
父线程审批卡复用现有机制，无需新建审批系统——子代理阻塞在父卡片上，
是它在无法自行询问用户时唯一诚实的选项。

**该行为的代价已明确接受**：一个等待用户裁决的后台子代理会挂起。
`TaskStop` 可中止它。

## 6. 提示词组装

`composeSubagentSystemPrompt`（`run.ts:33`）现有输出 = 固定框架 + `definition.prompt`。
新增一个 `capabilityBlock`，由新的解析器组装，最多三段：

```
<available_skills>
（复用 formatSkillsForSystemPrompt，已按 skills 白名单过滤）
</available_skills>

<knowledge_sources>
- 产品手册 (files: ./docs/**/*.md)
- 售后政策库 (mcp: notion__search)
</knowledge_sources>

<allowed_mcp_servers>
crm, notion
</allowed_mcp_servers>
```

**不变量**：每个维度未声明时，该段整体省略。因此既有定义的输出提示词
**字节级不变** —— `tools.ts:483` 的静态核心提示词缓存不变式依赖这一点。
此不变量进测试。

## 7. 改动点

| 文件 | 改动 |
|---|---|
| `subagent/subagent-definitions.ts` | schema 解析/序列化/校验；`GRANTABLE_TOOLS`；`skills`/`mcpServers`/`knowledge` 字段 |
| `subagent/tools.ts` | `resolveSubagentTools` 取代 `definition.tools.map(baseTools.find)`；挂载 `kb_search` 与作用域化 MCP 网关 |
| `subagent/knowledge.ts` | **新增**：`kb_search` 工具与 file 类知识源检索 |
| `mcp/mcp-tools.ts` | `buildMcpTool` 增可选 `allowedServers` 参数；过滤 search/describe、拒绝越权 call |
| `subagent/run.ts` | `composeSubagentSystemPrompt` 组装 `capabilityBlock` |
| `protocol/payloads.ts` + `pi-protocol` | `PiSubagentEntry` 携带新字段 |
| `desktop/.../subagents-settings.tsx` | 编辑表单加三段；沿用现有表单与 YAML 双视图模式 |

## 8. 测试

新增 `test/subagent/`，沿用现有断言风格：

1. **schema 往返** — 含新字段的定义 emit 后再 parse，四维度无损；未知键仍记诊断
2. **大小写归一** — 声明 `webfetch`（小写）解析出规范名 `WebFetch`，
   且能在会话工具表中命中（守住 §4.2 记录的既有相等性缺陷）
3. **未声明即不可达** — 无 `skills` 时目录块缺席、`use_skill` 不在工具表；
   无 `mcp` 时网关不挂载
4. **作用域拒绝** — 声明 `servers: [crm]` 的子代理调用 `notion__x` 被立即拒绝，
   且 `search` 结果不含 `notion`
5. **提示词不变式** — 未声明新维度的既有内置定义，`composeSubagentSystemPrompt`
   输出与改动前逐字节相同（对 `Explorer` 等四个内置做快照断言）
6. **`kb_search` 上限** — 超大语料按字节上限截断并显式标注截断，不静默
7. **`read` 依赖校验** — 声明 `files` 知识源但未授予 `read` 时，解析层出警告、
   保存路径报错
8. **跨层解析** — 插件层 / 工作区层定义的 `stateKey` 与开关语义不变（回归）

## 9. 未决与后续

- 业务 API（HTTP）受约束工具：本期不做。触发条件是出现"既有 MCP 覆盖不到的
  业务 API"这一真实需求。
- 向量 RAG：本期不做。若 `kb_search` 的关键词检索在真实语料上召回不足，
  再评估——届时它是 `knowledge` 维度下的实现替换，不影响 schema。
- 垂直业务包的发行：走插件层，复用现有打包。schema 已兼容。