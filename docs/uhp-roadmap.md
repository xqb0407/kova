# UHP Full / 可选能力路线图

V1 只实现并声明 **Core + Extended**。本文把尚未实现的 Full 与可选能力按规范章节拆开，记录端点、对象字段、Kova 侧接入点、缺口和验收方式，后续直接续做，不需要重新调研。

> 原则：**不实现就不声明**。所有未实现能力在 discovery 中必须是 `false`；不能为了让 suite 少 skip 而虚报。

## 状态总览

| 能力 | 规范归属 | V1 | 依赖 | 预计改动面 |
|---|---|---|---|---|
| `harness_management` | Full | ❌ | 本地 harness registry 已有 | `uhp/harness-registry.ts`、`uhp/server.ts` |
| `harness_retirement` | Full | ❌ | 会话软删除窗口 | `uhp/store.ts`、Kova session 索引 |
| `session_sharing` | Full | ❌ | 只读分享 token | 新 `uhp/share.ts`、`share.ts` 参考 |
| `plugins` | 可选 | ❌ | Agent Plugins 1.0.0 包格式 | Kova plugins/skills/MCP |
| `environments` | 可选 | ❌ | 只读环境构建/挂载 | worktree / remote SSH / sandbox |
| `memories` | 可选 | ❌ | memory 树/记录/授权 | Kova memory/knowledge |
| `input_requests` | 可选 | ❌ | Question/审批映射 | `data-question`、`permissions/interactions` |
| `resume` | 可选 | ❌ | 中断轮次恢复 | transcript / agent state |
| `session_branching` | 可选 | ❌ | `fork_session` + seq 映射 | `fork_session` handler |
| `idempotency` | 可选 | ❌ | prompt 幂等台账 | `remote.ts` 台账 |
| `background` 事件跟随 | 规范 Tasks | ⚠️ 仅轮询 | 事件端点 | `task-service.ts` |
| `max_step` 强制 | Full T-12 | ⚠️ 近似 | 按 tool-call 轮数在 adapter 侧 abort | `task-service.ts` |
| rate limit / TLS / daemon | 安全/部署 | ❌ | 网关/隧道 | `uhp/server.ts` |

---

## 1. Harness CRUD（Full）

### 端点

| 方法 | 路径 | 语义 |
|---|---|---|
| POST | `/v1/harnesses` | 创建 configured harness，返回 `chrn_...` |
| PUT | `/v1/harnesses/{id}` | 全量替换可变配置；`id`/`base`/`createdAt` 不变 |
| DELETE | `/v1/harnesses/{id}` | 退休 harness；按 `harness_retirement` 决定会话保留/软删除 |

### 对象字段

创建/更新请求（snake_case）：`name`、`base`、`default_model`、`system_prompt`、`mcp_servers`、`skills`、`plugins`、`environment`、`disabled_tools`、`max_step`、`timeout_seconds`。

响应/GET（camelCase）：`id`、`object:"harness"`、`name`、`base`、`baseLabel`、`defaultModel`、`systemPrompt`、`mcpServers`、`skills`、`plugins`、`environment`、`disabledTools`、`maxStep`、`timeoutSeconds`、`createdAt`（Unix ms）。

### Kova 接入点

- `apps/electron/main/uhp/harness-registry.ts` 已持久化 `UhpHarnessProfile`，并预留 `source: "local" | "api"`。
- `saveHarnessProfile` 已处理 `name/base/defaultModel/systemPrompt/approvalLevel/workspace/maxStep/timeoutSeconds`；需要补：
  - `mcpServers`：把远程 HTTP/SSE MCP 配置传到 sidecar 的会话级 MCP 白名单；stdio 只能走 plugins。
  - `skills`：把 skill bundle 物化到会话工作区 `/.kova/skills/<name>/`，或映射到 Kova 技能发现目录。
  - `disabledTools`：sidecar 需要在工具表构建时硬过滤；若 base 不支持逐工具禁用，则作为 standing instruction 并在响应 metadata 标明。
  - `environment`：接 environments 能力。
- `POST` 需要 `Idempotency-Key`：复用 `remote.ts` 的 prompt 幂等台账思路，key 存 24h。
- `PUT` 需要 `ETag` / `If-Match`：可在 profile 上加 `version`，`If-Match` 不匹配 → 412 `precondition_failed`。
- `DELETE` 默认保留会话；若开启 `harness_retirement`，在 profile 上记 `retiredAt/restorableUntil`，列表/读取可隐藏，窗口内可恢复。

### 验收

- Full check `F-03`/`F-04`：skills 以文件夹往返、无关编辑不丢内容。
- 未知字段 → 422 并指出字段名与可能目标；`id/object/createdAt` 等服务端只读字段接受并忽略。
- `base` 不支持 → 422 `unsupported_base`；默认模型不支持 → 422 `model_not_available`。
- 退休时有运行中任务 → 409 `harness_busy`（或先取消再退休）。

---

## 2. Session sharing（Full）

### 端点

- `POST /v1/sessions/{id}/share` → `{ id, object:"session.share", url }`
- `GET /v1/sessions/{id}/share` → 当前 share 或 404
- `DELETE /v1/sessions/{id}/share` → 撤销
- 分享页只读，不能作为 API 凭据；撤销/删除会话后返回 404/410。

### Kova 接入点

- 新增 `apps/electron/main/uhp/share.ts`：生成随机 `share_...` id + 只读 token，存 SQLite kv；只暴露经过脱敏的会话 turns（不含系统提示词、工具参数中的秘密、绝对路径）。
- 可参考现有 `share.ts` 的“渲染自包含 HTML/截图”能力，但 **不要** 复用截图作为会话分享；UHP 需要可读文本/HTML。
- 删除会话时级联撤销 share；`DELETE /v1/sessions/{id}` 先撤销 share。

### 验收

Full `R-01`–`R-08`：未授权不能读、分享只读、撤销生效、bodyless publication、不能借分享页调用 API。

---

## 3. Plugins（可选）

### 规范要点

- Agent Plugins 1.0.0 包：根 `plugin.json` + `mcp.json` + `skills/<name>/SKILL.md`。
- 对象字段：`name`、`enabled`、`files`、`blob`、`manifest`、`mcpServers`、`skills`、`skipped`。
- `POST/PUT /v1/harnesses` 接受 `plugins`；`GET /v1/harnesses/{id}/plugins/{name}/files` 返回完整包；`GET /v1/harnesses/{id}/plugin` 导出直接配置。
- stdio MCP 必须在 agent 沙箱内运行；只展开 `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`。
- 插件冲突 → 409 `plugin_conflict`；坏包 → 422 `plugin_invalid`。

### Kova 映射

- Kova 已有插件/技能/MCP 三层：`src/plugins/`、`src/skills/`、`src/mcp/`。
- 新增 `uhp/plugins.ts`：
  - 解析 `plugin.json`/`mcp.json`，映射到 `McpServerDef` 与 skill 目录；
  - 安装到 `<appData>/uhp/plugins/<harnessId>/<pluginName>/`；
  - 运行时把 enabled 插件的 MCP/skills 合并进该 harness 的会话配置；
  - 导出时剥离 `auth`/`headers`，并把省略项写入 `skipped`。
- 安全：stdio 命令不得在宿主 shell 执行；用 Kova 沙箱/子进程白名单。

### 验收

Full `P-02`/`P-06`/`P-11`：插件派生、凭据安全导出、经插件 MCP 实际调用一次工具。

---

## 4. Environments（可选）

### 规范要点

- 只读环境 = 源码 + 构建依赖，固定在 mount；与 session 可写工作目录分离。
- 端点：`/v1/environments` CRUD、files、directories、import、build、versions、activate、`/harnesses`。
- 状态：`empty/building/ready/failed`；版本不可变，同一时间一个 active。
- 任务通过 `metadata.environment` 覆盖 harness 默认环境；环境缺失/未就绪必须拒绝。

### Kova 映射

- 最小可行：把 Kova 的 **worktree + sandbox** 作为环境构建器：
  - `POST /v1/environments` 接收 archive/git；
  - build 在临时目录执行 `npm/pip/apt`（需要运行时白名单）；
  - ready 后只读挂载到会话 cwd 下的 `.uhp-env/`，会话 cwd 仍可写；
  - 环境版本 = build 快照目录 + manifest。
- remote SSH 会话可作为后续“远程环境”；V1 不混入。
- 安全：构建以任务级权限运行，不继承服务器主密钥；禁止环境内写回。

### 验收

- 任务引用未就绪环境 → 409 `environment_not_ready`；不存在 → 404。
- 会话内写环境路径被硬拒绝；两个会话的 cwd 不互相可见。

---

## 5. Memories（可选）

### 规范要点

- 可选的 provider-backed memory 树；对象：memory、record、grant、job、consolidation、graph。
- 记录类型：`episode/fact/note/procedure/link/entity`；内容 part：text/file。
- 授权：member/group/provider；权限 read/write/create/delete，向下继承。
- 端点覆盖 recall/query/graph/observe/prime/consolidations/erase 等。

### Kova 映射

- Kova 已有 `src/agent/memory.ts`（Markdown + 关键词）与 `knowledge-core`。
- 新增 `uhp/memories.ts` 适配层：
  - memory 树 → 目录树/命名空间；
  - record → Markdown 文件 + frontmatter；
  - recall/query → 现有 `kb_search` / memory 检索；
  - grants → 文件权限 + 会话级白名单；
  - consolidate → 后台任务写提案，人工接受/拒绝。
- 不把 memory 内容直接拼进 system prompt；作为带来源的 data 段注入。

### 验收

- 无授权读不到（看起来不存在）；删除后不可达；provider 凭据不进入沙箱。
- Full 之外的 suite 不强制；作为差异化能力单独立项。

---

## 6. input_requests / resume（可选）

### input_requests

- 任务以 `incomplete` + `incomplete_details.reason="input_required"` 结束，最后一个 output item 是 `input_request`；客户端下一次请求用 `input_response` + `previous_response_id` 回答。
- Kova 映射：
  - `data-question` / `QuestionCard` / `permissions/interactions.ts` 已有挂起交互台账；
  - UHP task-service 监听 pending interaction，转换为 `input_request` output item，并持久化 `input_request_id`；
  - `input_response` 到达时调用现有 `applyQuestionAnswer`，继续同一 session；
  - 超时/取消 → 410 `input_request_expired` / 409 `input_not_pending`。
- 风险：UHP 任务没有 UI；必须设置较短 `expires_at`，并在无人值守时自动 decline。

### resume

- 中断轮次以 `failed` + `error.detail.reason="interrupted"` 返回；客户端用 `resume` item + `previous_response_id` 继续。
- Kova 已有 `SubagentRun` resume/agent stop 语义；需要把 `workspace: kept|checkpoint|lost` 与 `effects_may_repeat` 映射到 Kova checkpoint。
- 单次使用，重复 resume → 409 `resume_not_pending`。

### 验收

Full `T-13`/`T-14`/`T-15`：问答、secret 处理、resume 拒绝行为。

---

## 7. session_branching（可选）

- 请求：`branch:true` + `previous_response_id`；创建新 session，原 session 不变。
- 响应 metadata 带新 `session_id` 与 `metadata.branched_from:"resp_..."`；只有该响应带 provenance。
- Kova 已有 `fork_session`（支持 `upToSeq`）：
  - response → transcript seq 映射已可在 `UhpResponseRecord.seqStart/seqEnd` 预留字段中落；
  - `branch:true` 时调用 `fork_session({sessionId, upToSeq})`，再以新 session 继续；
  - 分支点不可用 → 409 `branch_unavailable`；准备超时 → 503。
- 验收：`B-01`–`B-06`。

---

## 8. idempotency（可选）

- `Idempotency-Key` 作用于 `POST /v1/responses`（以及 Full 的 harness create）。
- 键在调用者 scope 内保留 ≥24h：重复返回原响应；同 key 不同请求 → 409 `idempotency_key_reused`。
- Kova 已有远程网关 prompt 幂等台账（`seenPrompts`），可抽出为 `uhp/idempotency.ts`。
- 验收：重复提交不重复跑任务/不重复计费。

---

## 9. background / 事件跟随

- 规范：`background:true` 立即返回 accepted，客户端用“events endpoint”跟随。
- V1：已支持 `background:true` 返回 `in_progress`，客户端轮询 `GET /v1/responses/{id}`；没有独立 events 端点。
- 后续：若规范明确 `/v1/responses/{id}/events` 或等价路径，复用 `event-stream.ts` 的有界缓冲 + `Last-Event-ID` 实现 SSE 跟随；同时补 `background` 的终态清理与 retention。
- 验收：`T-11` 轮询报告 `in_progress` 已可过；事件跟随需补。

---

## 10. 其它部署/安全项

| 项 | 现状 | 后续 |
|---|---|---|
| `max_step` 强制 | adapter 按 tool-call 轮数近似强制 | 若要 provider 原生硬预算，sidecar `Running` 加 `maxSteps`/`stepCount`，在 agent loop 内 abort |
| rate limit | 无 | 按 token 计数，429 `rate_limit_error` + `retry_after_ms` |
| TLS / LAN | 仅 loopback | 复用 Kova tunnel/TLS；非 loopback 强制 HTTPS |
| daemon 化 | 随 Electron 存活 | 把 `uhp/server.ts` 抽成独立进程，复用同一 bridge 接口 |
| usage | 从转录 assistant usage 行按任务时间窗汇总；无 timestamp 时为 `null` | provider 未落 timestamp 时补 seq 区间或 usage 协议字段 |
| 保留策略 | 响应 30 天 | session/artifact retention + 文档化 |

## 11. 续做顺序建议

1. `max_step` 的 provider 原生硬预算 + provider 无 timestamp 时的 usage 补账。
2. `session_branching`（Kova 已有 `fork_session`，收益高）。
3. `input_requests`（复用 Question/审批，提升无人值守体验）。
4. `idempotency`（复用 remote 台账）。
5. Full harness CRUD + retirement（网关管理面）。
6. session sharing。
7. plugins / environments / memories（各自独立立项）。
8. daemon / TLS / rate limit（部署形态）。

每一项完成后：更新 discovery 能力位 → 跑对应 class 的 suite → 更新本文状态表。
