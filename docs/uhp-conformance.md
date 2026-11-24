# UHP 一致性测试

V1 目标：官方 suite 的 **Core 41/41** 与 **Extended 50/50**。  
协议版本：**2026-10-19**（只声明这一版；不虚报 2026-10-04 等旧版）。

## 1. 准备

1. 在 Kova 里配置至少一个可用模型（设置 → 模型）。
2. 打开 设置 → 智能体 → UHP → 启用服务端。
3. 复制 API Key（只显示一次）并确认“可用 Harness”里有一个 `chrn_...`。
4. 确认端口（默认 `8788`）与 harness 默认模型。

```bash
export UHP_BASE_URL=http://127.0.0.1:8788
export UHP_API_KEY='<Settings → UHP 里的 key>'
export UHP_HARNESS_ID='chrn_...'
export UHP_MODEL='provider/modelId'
```

## 2. 安装 suite

官方仓库：

```bash
pip install "git+https://github.com/HarnessRouter/harnessrouter.git#subdirectory=protocol/conformance"
```

插件检查需要可访问的 MCP fixture；离线环境可用 `--plugin-mcp-url` 指向本地副本。V1 不声明 plugins，因此 Extended 运行不会要求它。

## 3. 运行

```bash
# Core
uhp-conformance \
  --base-url "$UHP_BASE_URL" \
  --api-key "$UHP_API_KEY" \
  --class core \
  --harness-id "$UHP_HARNESS_ID" \
  --model "$UHP_MODEL" \
  --json report-core.json

# Extended
uhp-conformance \
  --base-url "$UHP_BASE_URL" \
  --api-key "$UHP_API_KEY" \
  --class extended \
  --harness-id "$UHP_HARNESS_ID" \
  --model "$UHP_MODEL" \
  --json report-extended.json
```

Kova 仓库封装：

```bash
bun run uhp:conformance -- --class core
bun run uhp:conformance -- --class extended
```

包装脚本从 `UHP_API_KEY` / `UHP_HARNESS_ID` / `UHP_MODEL` 读环境变量，额外参数原样转发。

## 4. 报告解读

- `conformant`：所有必测项都实际运行并通过。
- `conformant_with_skips`：必测项无失败/错误，但有 skip；**skip 不等于 pass**。
- `highest_class_passed`：只有整类覆盖且通过才计入。
- `coverage`：缺失/重复的 check id。
- `suite_version`：记录到验收报告；升级 suite 后需重跑并对比。

V1 允许的 skip 只应来自显式声明为 `false` 的可选能力（`input_requests`、`resume`、`session_branching`、`idempotency`、`plugins`、`environments`、`memories`、`session_sharing`、`harness_management`）。Core/Extended 必测项不得 skip。

## 5. 常见失败

| 现象 | 排查 |
|---|---|
| `401` | key 是否复制完整；轮换后旧 key 已失效 |
| `unsupported_protocol_version` | 客户端发了非 `2026-10-19` 的 `UHP-Version` |
| `harness_not_found` | `--harness-id` 必须是 `chrn_...`，不是名字 |
| `model_unavailable` | 模型未配置凭据/未启用；或不是 `provider/modelId` |
| 任务卡在 `in_progress` | Kova 侧模型请求是否卡住；`timeout_seconds` 是否设置 |
| SSE 检查失败 | `sequence_number` 缺口/重复，或终态前缓冲了全部事件 |
| 文件检查失败 | 上传超过 20 MiB、路径穿越、缺少 `nosniff` |
| 取消检查失败 | 取消后未到 `cancelled` 终态；查 Kova `piAbort` 日志 |

## 6. 成本与 CI

更完整的单测/手工联调示例见 [uhp-testing.md](./uhp-testing.md)。

suite 会跑约 7 个真实 agent 任务，消耗模型 token 与数分钟时间。建议：

- 作为**手动验收**或 nightly，不进每个 PR 的必跑测试；
- 使用便宜模型；
- 把 `report-core.json` / `report-extended.json` 作为构建产物保存；
- 记录 `suite_version` 与协议版本，升级时重跑。

单测/类型检查不依赖 suite：

```bash
bun run test:uhp
bun run --filter kova-electron-main test
bun run --filter pi-agent-sidecar test
bun run typecheck
```
