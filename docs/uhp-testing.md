# UHP 测试与联调指南

本文给出四层测试的入口、覆盖范围、示例请求和常见排障方式。  
V1 的自动化测试不依赖真实模型；官方 conformance 需要真实模型与 Python suite。

## 1. 快速命令

```bash
# 共享契约（SSE / 能力表 / ID）
bun run test:uhp

# Electron 主进程：UHP 配置、模型投影、multipart、zip、HTTP/SSE 集成
bun run --filter kova-electron-main test

# sidecar：UHP Client、外部子代理、YAML 定义
bun run --filter pi-agent-sidecar test

# 桌面 UI / i18n
bun run --filter desktop test

# 全量类型检查
bun run typecheck
```

当前基线：

- `uhp-protocol`：15 pass
- `kova-electron-main`：405 pass（含 UHP server 集成 26 项）
- `pi-agent-sidecar`：2865 pass（含 UHP 10 项）
- `desktop`：1579 pass

数字会随代码演进变化，以实际输出为准。

## 2. 测试分层

| 层 | 文件 | 覆盖 |
|---|---|---|
| 契约单测 | `packages/uhp-protocol/test/sse.test.ts` | SSE 分帧、CRLF、多行 data、跨 chunk、编码 |
| 契约单测 | `packages/uhp-protocol/test/capabilities.test.ts` | Core/Extended 能力位、全量 key、false 显式存在 |
| 契约单测 | `packages/uhp-protocol/test/ids.test.ts` | `resp_`/`chrn_`/`hsess_`/`file_`/`cntr_`、discovery |
| Server 单测 | `apps/electron/test/uhp-core.test.ts` | 配置归一、模型投影、constant-time auth、multipart、zip |
| Server 集成 | `apps/electron/test/uhp-server.test.ts` | discovery、auth、版本、harness/model、非流式/流式、取消、续接、上传、预算、产物、usage、并发上限、cwd/file 安全、Unicode 下载、stop |
| Client 单测 | `apps/sidecar/pi-agent/test/uhp/client.test.ts` | discovery、SSE 消费、错误 envelope |
| Client 集成 | `apps/sidecar/pi-agent/test/uhp/uhp-run.test.ts` | 外部 SSE → `SubagentActivityItem` → report、未配置服务器 |
| 子代理定义 | `apps/sidecar/pi-agent/test/subagent/uhp-definition.test.ts` | `backend: uhp`、无 tools、YAML 往返 |
| UI | `apps/desktop/lib/i18n/keys.test.ts` 等 | UHP 设置页/子代理编辑器 key 对齐与表单保留 |

Server 集成测试用一个 fake `UhpBridge` + 内存 store，不需要 Electron、SQLite、模型凭据或 sidecar 进程。启停、SSE、上传、产物、预算、取消都在测试里可控。

## 3. 浏览器 Demo

服务端启动后直接打开：

<http://127.0.0.1:8788/demo>

`GET /` 会 302 到 `/demo`。页面与 `/v1` 同源，所以不需要改 CORS；API Key 只保存在浏览器 `sessionStorage`，不会进 URL。

Demo 支持：

- Discover：看版本、conformance class、capabilities；
- 刷新 Harness / Model；
- 非流式与 SSE 流式任务；
- `previous_response_id` 续接；
- Cancel；
- `timeout_seconds` / `max_step` / `max_output_tokens`；
- 上传文件并作为 `input_file`；
- 加载 `/v1/sessions`、`/turns`、`/files`；
- 事件流与最终 response JSON 对照显示。

页面由 `apps/electron/main/uhp/demo.ts` 提供，CSP 为 `default-src 'none'`，只允许同源 `connect-src` 与内联样式/脚本。

## 4. 手工联调：启动服务端

1. 设置 → 智能体 → **UHP** → 启用服务端。
2. 复制 API Key（只显示一次）。
3. 确认“可用 Harness”里有一个 `chrn_...`，并设置默认工作区。
4. 默认端口 `8788`，只监听 `127.0.0.1`。

```bash
export UHP_BASE=http://127.0.0.1:8788
export UHP_KEY='<设置页里的 key>'
export UHP_HARNESS='chrn_...'
```

### 3.1 Discovery（免认证）

```bash
curl -s "$UHP_BASE/v1/uhp" | jq
```

### 3.2 Harness / Models

```bash
curl -s -H "Authorization: Bearer $UHP_KEY" "$UHP_BASE/v1/harnesses" | jq
curl -s -H "Authorization: Bearer $UHP_KEY" "$UHP_BASE/v1/models" | jq
curl -s -H "Authorization: Bearer $UHP_KEY" \
  "$UHP_BASE/v1/harnesses/$UHP_HARNESS/models" | jq
```

### 3.3 非流式任务

```bash
curl -s -X POST "$UHP_BASE/v1/responses" \
  -H "Authorization: Bearer $UHP_KEY" \
  -H "Content-Type: application/json" \
  -H "UHP-Version: 2026-10-19" \
  -d '{
    "input": "Reply with exactly: pong",
    "model": "provider/modelId",
    "metadata": { "harness_id": "'"$UHP_HARNESS"'" }
  }' | jq
```

### 3.4 流式任务（SSE）

```bash
curl -N -X POST "$UHP_BASE/v1/responses" \
  -H "Authorization: Bearer $UHP_KEY" \
  -H "Content-Type: application/json" \
  -H "UHP-Version: 2026-10-19" \
  -d '{
    "input": "Write a one-line hello.",
    "stream": true,
    "metadata": { "harness_id": "'"$UHP_HARNESS"'" }
  }'
```

预期看到：

```
id: 0
data: {"type":"response.created",...}

id: 1
data: {"type":"response.output_item.added",...}

...

data: {"type":"response.completed","response":{...}}
```

检查点：`sequence_number` 从 0 连续递增；恰好一个终态；`response.created` 最先出现。

### 3.5 取消

```bash
# 先发一个 background 任务
RESP=$(curl -s -X POST "$UHP_BASE/v1/responses" \
  -H "Authorization: Bearer $UHP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"Run a long task","background":true,"metadata":{"harness_id":"'"$UHP_HARNESS"'"}}')
ID=$(echo "$RESP" | jq -r .id)

curl -s -X POST "$UHP_BASE/v1/responses/$ID/cancel" \
  -H "Authorization: Bearer $UHP_KEY" | jq .status
# 期望 "cancelled"
```

### 3.6 上传文件并作为 input_file

```bash
FILE=$(curl -s -X POST "$UHP_BASE/v1/files" \
  -H "Authorization: Bearer $UHP_KEY" \
  -F "file=@./README.md")
FILE_ID=$(echo "$FILE" | jq -r .id)

curl -s -X POST "$UHP_BASE/v1/responses" \
  -H "Authorization: Bearer $UHP_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [{
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Summarize this file." },
        { "type": "input_file", "file_id": "'"$FILE_ID"'" }
      ]
    }],
    "metadata": { "harness_id": "'"$UHP_HARNESS"'" }
  }' | jq
```

### 3.7 会话与产物

```bash
# 发一个任务并保存响应，取 session_id
RESP=$(curl -s -X POST "$UHP_BASE/v1/responses" \
  -H "Authorization: Bearer $UHP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","metadata":{"harness_id":"'"$UHP_HARNESS"'"}}')
SESSION=$(echo "$RESP" | jq -r .metadata.session_id)

curl -s -H "Authorization: Bearer $UHP_KEY" "$UHP_BASE/v1/sessions" | jq
curl -s -H "Authorization: Bearer $UHP_KEY" \
  "$UHP_BASE/v1/sessions/$SESSION/turns" | jq
curl -s -H "Authorization: Bearer $UHP_KEY" \
  "$UHP_BASE/v1/sessions/$SESSION/files" | jq
```

下载产物：

```bash
curl -s -H "Authorization: Bearer $UHP_KEY" \
  "$UHP_BASE/v1/containers/<cntr_...>/files/<file_...>/content" -o artifact.bin
```

## 5. 手工联调：UHP Client（子代理委派）

设置 → 智能体 → UHP → 客户端：添加服务器（URL + token）。  
或在 `~/.kova/uhp-servers.json` 由桌面写入后，创建子代理 YAML：

```yaml
name: external-reviewer
description: Review with an external UHP harness
backend: uhp
uhp:
  server: local             # 设置页里的服务器 id
  harness: chrn_...         # 可选
  model: openai/gpt-5       # 可选
  cwd: /path/to/project     # 可选
prompt: |
  Act as a strict reviewer. Report actionable findings with exact paths.
```

然后在主会话让模型 `Task` 到 `external-reviewer`。观察：

- 子代理活动面板出现外部文本/思考/工具流；
- TaskWait 收敛后 report 回到父会话；
- TaskStop 会调用 `POST /v1/responses/{id}/cancel`；
- 完成后活动文件里保留 `externalResponseId`，resume 会续接同一外部会话。

## 6. 官方一致性测试

```bash
pip install "git+https://github.com/HarnessRouter/harnessrouter.git#subdirectory=protocol/conformance"

UHP_API_KEY=... UHP_HARNESS_ID=chrn_... UHP_MODEL=provider/model \
  bun run uhp:conformance -- --class core

UHP_API_KEY=... UHP_HARNESS_ID=chrn_... UHP_MODEL=provider/model \
  bun run uhp:conformance -- --class extended
```

完整说明见 [uhp-conformance.md](./uhp-conformance.md)。

## 7. 常见排障

| 现象 | 检查 |
|---|---|
| `401 authentication_error` | key 是否完整；轮换后旧 key 已失效 |
| `400 unsupported_protocol_version` | `UHP-Version` 是否 `2026-10-19` |
| `404 harness_not_found` | 使用 `chrn_...` id，不是 harness 名字 |
| `422 model_unavailable` | 模型是否已配置凭据/启用；是否 `provider/modelId` |
| 任务一直 `in_progress` | 模型请求是否卡住；是否设置 `timeout_seconds` |
| SSE 没有事件 | `stream:true` 是否在 JSON body；反向代理是否缓冲 |
| 取消不结束 | 查日志 `piAbort` / `host_cancel`；sidecar 工具是否杀干净 |
| 文件列表为空 | agent 是否用 write/edit 或 bash 改了 workspace；扫描跳过目录/敏感文件 |
| UHP Client 连不上 | URL 是否 HTTPS（非 loopback 禁止明文 HTTP）；token 是否有效 |

## 8. 测试盲区

自动化测试使用 fake bridge，不验证：

- 真实 provider 的 token 计量与 usage 行；
- 真实 sidecar 的 `new_session`/`prompt`/`abort` 时序；
- 官方 conformance 的 41/50 项语义检查；
- Electron 真实端口、打包后的二进制资源路径。

这些需要真实模型 + 安装包/桌面环境才能覆盖，因此 conformance 不能由单测替代。
