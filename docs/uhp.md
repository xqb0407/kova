# UHP（Unified Harness Protocol）接入

状态：V1 已实现，默认关闭。  
协议基线：**2026-10-19**（OpenAPI 3.1 + JSON Schema 2020-12，Apache 2.0）。  
一致性目标：**Core + Extended**。Full 与可选能力见 [uhp-roadmap.md](./uhp-roadmap.md)。

## 1. 是什么

UHP 是一个 HTTP 契约：Client 提交任务、Server 选择并驱动 Harness，Client 不需要知道背后是 pi-agent、Codex、Claude Code 还是 Hermes。任务表面刻意贴近 OpenAI Responses API，流式使用 SSE。

Kova 同时实现两侧：

- **UHP Server**：Electron 主进程把内置 pi-agent 暴露成标准 harness，外部 Client / CI 可以驱动。
- **UHP Client**：sidecar 的 Task 子代理可以把任务委派给外部 UHP 服务（HarnessRouter、另一台 Kova、未来任何兼容实现）。

两段共用 `packages/uhp-protocol` 的类型、SSE 编解码、错误模型和 ID 规则。

```
外部 Client / CI
   │  HTTP + SSE  (:8788, Bearer, UHP-Version)
   ▼
Electron main — apps/electron/main/uhp/
   │  discovery / auth / harness registry / tasks / SSE / files
   ▼
pi-agent bridge（piPrompt / piRequest / frame tap）
   ▼
apps/sidecar/pi-agent（内置 harness）

Kova Task 子代理（backend: uhp）
   → packages/uhp-protocol client
   → 外部 HarnessRouter / Kova UHP Server
```

## 2. 启动与配置

设置 → 智能体 → **UHP**。

| 项 | 默认 | 说明 |
|---|---|---|
| 启用服务端 | 关 | 开启后监听 `127.0.0.1:<port>` |
| 端口 | `8788` | 仅回环地址；非 loopback 需要 TLS（后续） |
| 默认工作区 | `<appData>/uhp/workspace` | 任务未带 `metadata.cwd` 时使用 |
| 任务审批档 | `workspace-write` | UHP 任务无人应答审批卡；`auto` 需显式选择 |
| API Key | 首次启用生成 | 只显示一次；轮换后旧 key 立即失效 |
| 并发任务 | `2` | 超过时返回 429 `rate_limit_error`；同一会话同时只允许一个任务 |
| 可用 Harness | 自动创建 | 默认模型取当前可用模型；V1 设置页只读展示，可用 `uhp_save_harness` 命令调整 |

API Key 使用 AES 加密后存 SQLite kv（`uhp.server`），不会以明文落盘。客户端发送：

```http
Authorization: Bearer <key>
UHP-Version: 2026-10-19
```

`GET /v1/uhp` 是唯一免认证端点；其余端点缺失/错误 token 一律 401。  
浏览器联调 Demo：服务启用后打开 <http://127.0.0.1:8788/demo>（同源调用，无需 CORS）。

## 3. V1 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/uhp` | discovery；versions / default_version / conformance_class / capabilities |
| GET | `/v1/harnesses` | 当前可用的 configured harness |
| GET | `/v1/harnesses/{id}` | 单个 harness |
| GET | `/v1/models` | 按 provider 分组的模型目录 |
| GET | `/v1/harnesses/{id}/models` | 该 harness 可用模型 |
| POST | `/v1/responses` | 创建任务；`stream:true` 走 SSE，否则返回最终 response |
| GET | `/v1/responses/{id}` | 读取响应（含 `in_progress` 快照） |
| DELETE | `/v1/responses/{id}` | 删除已存储响应；不取消运行中任务 |
| GET | `/v1/responses/{id}/input_items` | 原始输入（`{object:"list",data:[...]}`） |
| POST | `/v1/responses/{id}/cancel` | 取消任务；到达 `cancelled` 终态 |
| GET | `/v1/sessions` | UHP 创建的会话列表（cursor 分页） |
| GET | `/v1/sessions/{id}` | 会话详情（含 turns） |
| GET | `/v1/sessions/{id}/turns` | 会话轮次 |
| POST | `/v1/sessions/{id}/cancel` | 取消该会话在飞任务 |
| DELETE | `/v1/sessions/{id}` | 取消 + 删除 Kova 会话/转录/产物 |
| POST | `/v1/files` | `multipart/form-data` 上传（默认上限 20 MiB） |
| GET | `/v1/sessions/{id}/files` | 会话产物列表 |
| GET | `/v1/sessions/{id}/files/archive` | 产物 zip |
| GET | `/v1/containers/{cid}/files/{fid}/content` | 产物下载 |
| GET | `/v1/containers/{cid}/files/{fid}/pdf` | 未实现 → 501 `preview_unavailable` |

### 能力声明

V1 的 discovery 固定返回：

```json
{
  "streaming": true,
  "sessions": true,
  "cancellation": true,
  "files_input": true,
  "files_output": true,
  "session_listing": true,
  "harness_management": false,
  "harness_retirement": false,
  "input_history": false,
  "input_requests": false,
  "resume": false,
  "session_sharing": false,
  "session_branching": false,
  "idempotency": false,
  "harness_idempotency": false,
  "plugins": false,
  "environments": false,
  "memories": false
}
```

未支持的能力必须显式 `false`，不能省略。

## 4. 任务模型

### 请求

```json
{
  "input": "Fix the failing test in src/foo.test.ts",
  "model": "anthropic/claude-sonnet-4",
  "metadata": {
    "harness_id": "chrn_...",
    "cwd": "/absolute/path/inside/workspace"
  },
  "instructions": "Be concise; report exact file paths.",
  "stream": true,
  "previous_response_id": "resp_...",
  "timeout_seconds": 600
}
```

- `input` 支持字符串和 Responses 风格数组；V1 Core 只要求文本。
- `metadata.harness_id` 选 harness；缺省用服务器默认 harness。续接时省略则继承 `previous_response_id` 的 harness。
- `metadata.cwd` 是 **Kova 扩展**：UHP 规范没有 cwd 字段。必须是 harness 工作区内路径，否则 400 `invalid_input`；越界路径不会在磁盘上被创建。
- `model` 是 canonical `provider/modelId`；不可用时 422 `model_unavailable`。续接时省略模型会优先沿用上一条响应仍可用的模型。
- `tools`、`include` 接受但忽略，并写入响应 `metadata.ignored_fields`。
- `max_step` 按工具调用轮数在 adapter 侧强制；`max_output_tokens` 以约 4 chars/token 估算强制；超限会 abort 并以 `incomplete` + reason `max_steps` / `max_output_tokens` 收尾。`timeout_seconds` 由 server 侧 AbortController 强制执行。三者都必须是正整数。
- `background:true` 立即返回 `in_progress` response，客户端用 `GET /v1/responses/{id}` 轮询。
- 同一 session 并发任务返回 409 `session_busy`；全局并发超过 `maxConcurrentTasks` 返回 429。不要依赖 Kova 队列。
- `input_file` / `input_image` 的 `file_id` 必须存在；未知 id 返回 404 `file_not_found`。客户端自带的 `path` 字段会被丢弃，只有服务端解析出的路径会交给 harness。

### 响应

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1760000000,
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "previous_response_id": null,
  "model": "anthropic/claude-sonnet-4",
  "output": [
    {
      "id": "msg_...",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        { "type": "output_text", "text": "…", "annotations": [] }
      ]
    }
  ],
  "store": true,
  "usage": null,
  "metadata": {
    "session_id": "hsess_...",
    "harness_id": "chrn_...",
    "ignored_fields": []
  }
}
```

- `metadata.session_id` 是 UHP 会话 id；Kova 内部 session id 保存在响应记录里。
- `usage` 从会话转录的 assistant usage 行按任务时间窗汇总；拿不到带 timestamp 的 usage 时为 `null`（允许；不伪造 0）。
- `output` 支持 `message`、`reasoning`、`function_call`、`function_call_output`、`input_request`；未知类型客户端应忽略。

### SSE

请求 `stream:true` 时返回 `text/event-stream`：

```
id: 0
data: {"type":"response.created","sequence_number":0,"response":{...}}

id: 1
data: {"type":"response.output_text.delta","sequence_number":1,...}

id: 2
data: {"type":"response.completed","sequence_number":2,"response":{...}}
```

- `sequence_number` 从 0 开始，严格 +1，无缺口。
- 恰好一个终态：`response.completed` / `response.incomplete` / `response.failed`。
- 取消使用 `response.failed` + `response.status="cancelled"`（status 是权威值）。
- 终态事件携带完整 response；中途断线可用 `Last-Event-ID` 续传，或用 `GET /v1/responses/{id}`。
- 任务在客户端断线后继续运行。

### Kova chunk → UHP 事件

| Kova chunk | UHP SSE |
|---|---|
| `text-start` | `response.output_item.added` + `response.content_part.added` |
| `text-delta` | `response.output_text.delta` |
| `text-end` | `response.output_text.done` + `response.content_part.done` + `response.output_item.done` |
| `reasoning-*` | reasoning item + `response.reasoning_summary_*` |
| `tool-input-available` | `function_call` item + `response.function_call_arguments.done` |
| `tool-output-available/error` | `function_call_output` item + `response.output_item.done` |
| `finish` | 唯一终态 |
| `error` | `error` 事件 + 终态 `response.failed` |

## 5. 会话与对象

- UHP session id：`hsess_<kovaSessionId>`。
- 只有通过 UHP 创建的会话会出现在 `/v1/sessions`；桌面聊天会话默认不暴露。
- `previous_response_id` 续接同一个 session/thread，保留上下文与工作目录；省略 `metadata.harness_id` 时继承上一条响应的 harness，省略 `model` 时优先沿用仍可用的原模型。
- `previous_response_id` 与显式 `metadata.harness_id` 不一致 → 409 `harness_mismatch`。
- 会话忙 → 409 `session_busy`。
- 删除会话会先取消在飞任务，再删除 Kova 转录、UHP 响应记录与产物。

## 6. 文件与产物

- `POST /v1/files` 保存到 `<appData>/uhp/files/<file_id>/`；超过 20 MiB → 413 `file_too_large`。
- `input_file` / `input_image` 支持 inline `file_data` 或 `file_id`；服务端会解析成 pi-agent 的 prompt attachments。
- 任务完成后，`write` / `edit` 工具产生的文件会被直接追踪；同时对 workspace 做有界 mtime 扫描，兜底 bash / 构建脚本产生的文件。扫描最多 2000 个文件、深度 6，跳过 `.git`/`.ssh`/`.kova`/`.aws`/`.kube`/`node_modules`/`dist`/`build` 等目录，并跳过 `.env`、`.npmrc`、`.netrc`、凭据、私钥/证书类文件；`write`/`edit` 目标同样走这套敏感文件过滤。产物复制到 `<appData>/uhp/artifacts/<sessionId>/`，并在最终 assistant message 上附加 `container_file_citation` annotation。
- 每个会话最多保留 500 个产物、总计 256 MiB；超过后新产物不再复制。产物 archive 上限 512 MiB，超出返回 413 `file_too_large`。
- 下载强制 `X-Content-Type-Options: nosniff` 与 RFC 5987 `Content-Disposition`（ASCII fallback + UTF-8 文件名）。
- 所有 file/container 访问做 realpath containment，拒绝 `..`、绝对路径和符号链接逃逸；删除/归档/保留清理也会重新校验路径。

## 7. UHP Client（子代理）

系统级服务器注册表：`~/.kova/uhp-servers.json`（桌面写入，0600；token 为 `kenc:v1:` 密文）。工作区 YAML 只能引用 server id，不能携带 URL/token。

```yaml
name: codex-reviewer
description: Review a change with an external Codex harness
backend: uhp
uhp:
  server: harnessrouter-local   # ~/.kova/uhp-servers.json 里的 id
  harness: chrn_...             # 可选；缺省用服务器唯一/默认 harness
  model: openai/gpt-5           # 可选；缺省用 harness 默认模型
  cwd: /path/to/project         # 可选；缺省由服务器 harness 决定
prompt: |
  Act as a strict code reviewer. Report only actionable findings with exact paths.
```

设置页的子智能体编辑器也有“执行后端”选择器；YAML 视图与表单都保留 `backend`/`uhp` 字段。`uhp.cwd` 只在服务器支持 `metadata.cwd` 扩展时有意义；连 Kova 自己的 UHP Server 时，它必须位于该 harness 的 workspace 内。

Task 行为：

- 自动 `GET /v1/uhp` 校验 Core/streaming；
- `POST /v1/responses` 流式执行，事件映射到子代理活动面板（文本/思考/工具/错误）；
- 最终 assistant 文本作为 report 回到父会话；
- Stop/TaskStop → `POST /v1/responses/{id}/cancel`；
- 记录 `previous_response_id`，resume 时续接同一外部会话（依赖服务器支持 `previous_response_id`）。

无桌面壳时可用环境变量：

```bash
KOVA_UHP_BASE_URL=http://127.0.0.1:8788
KOVA_UHP_TOKEN=...
KOVA_UHP_SERVER_ID=default
```

## 8. 安全边界

- 默认只监听 `127.0.0.1`；非 loopback 必须 TLS（V1 未开放）。
- UHP 管理命令（开关、端口、key、客户端服务器）全部加入远程网关 `REMOTE_DENIED_TYPES`，网页端不能改。
- 错误 envelope 不包含 token、内部路径或堆栈；日志只记 id/status/耗时/错误码。
- `metadata.cwd` 被限制在 harness 工作区内；文件/产物做 containment 校验。
- 审批：默认 `workspace-write`。若任务仍触发无法结算的审批，服务端以 `failed` + `error.detail.reason="approval_required"` 收尾，绝不挂死。

## 9. 已知限制（V1）

- 服务端随 Electron 主进程存活；应用退出即停止（未来可抽 daemon）。
- `usage` 是转录时间窗内的 best-effort 汇总；provider 未落 timestamp 时为 `null`。`max_step` / `max_output_tokens` 为 adapter 侧近似强制，不是 provider 原生硬预算。
- 不支持 `input_history`、`input_requests`、`resume`、`session_branching`、`idempotency`、`background` 的事件流端点（background 用 response 轮询）。
- 不支持 `harness_management` 远程 CRUD、session sharing、plugins、environments、memories。
- 不暴露桌面聊天会话；UHP 只管理自己创建的会话。

这些能力的规范映射与后续接入点见 [uhp-roadmap.md](./uhp-roadmap.md)。
