# ACP（Agent Client Protocol）模式

`kova-worker` 现在可以直接作为 **ACP agent** 被编辑器（Zed 等）以子进程方式拉起。
同一个二进制既能被 Kova 桌面端用 NDJSON 协议驱动，也能用 `--acp` 切换到标准
ACP（JSON-RPC 2.0 over stdio）。

- 协议版本：ACP v1（`@agentclientprotocol/sdk@0.4.9`）
- 传输：stdio，newline-delimited JSON-RPC 2.0
- stdout 只输出 JSON-RPC；日志/诊断全部走 stderr
- 代码：`apps/sidecar/pi-agent/src/acp/`

## 启动

```bash
# 开发态（源码直跑）
cd apps/sidecar/pi-agent
bun run acp

# 编译产物
kova-worker --acp

# 也支持环境变量
KOVA_ACP=1 kova-worker
```

### Zed 配置示例

```json
{
  "agent_servers": {
    "Kova": {
      "command": "/path/to/kova-worker",
      "args": ["--acp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

`command` 指向 `apps/electron/binaries/kova-worker`（打包版在应用资源目录里）。
如果使用自定义数据目录：

```json
"args": ["--acp", "--data-dir", "/Users/me/.kova/acp-work"]
```

## 数据目录与凭据

优先级从高到低：

1. `--data-dir <path>` / `--data-dir=<path>`
2. `KOVA_ACP_DATA_DIR`
3. `KOVA_DATA_DIR`
4. 默认 `~/.kova/acp`（目录权限 0700）

目录布局：

```
<data-dir>/
  state.db          # 本地 SQLite（会话索引/凭据/模型/kv）
  sessions/         # 会话 JSONL 转录
  task-workspace/   # 无工作目录会话的兜底执行目录
  library/          # 资料库缺省根
```

ACP 模式没有 Electron 宿主，**强制走本地 SQLite**。即使设置了
`PI_SESSIONS_DIR`，也只会被当作本地会话目录，不会进入 host_query 宿主模式。

## 与桌面端共享模型与凭据

桌面端把凭据 / 自定义 provider / 模型条目自动导出到用户级共享文件：

```
~/.kova/credentials.json   # 0600；KOVA_CREDENTIALS_FILE 可改路径
```

- 桌面端是唯一写入者：启动时整文件重建一次，之后凭据/模型/自定义 provider
  的任何变更（设置页保存、删除、启停）自动重建；原子写，读者永远看到完整文件
- 密钥值用机器派生密钥加密（`kenc:v1:`，AES-256-GCM；`KOVA_CREDENTIAL_SECRET`
  可覆盖派生源）。同用户的任何进程都能解密——这是多端共用的前提；
  文件权限只防其他用户
- sidecar 启动时只读注入本地 SQLite（凭据/自定义 provider/模型条目），
  模型目录与桌面端同源；镜像宁缺毋错，解不开的条目跳过
- 优先级：**共享文件 > 环境变量**（pi-ai 的 stored credential 优先语义）；
  环境变量仍可用于临时覆盖或无桌面端的机器
- 时机：启动时读取。桌面端改完模型后重启 ACP 进程（编辑器里新开会话即可）
  即可生效
- 原始数据不受影响：桌面 `state.db` 三张表仍是桌面 UI 主存储；共享文件是
  可随时重建的导出镜像（删掉后桌面下次启动自动恢复）
- 注意：设置了 `KOVA_CREDENTIAL_SECRET` 时，桌面端与 sidecar 必须拿到同一个值
- 注意：共享的是模型/凭据/自定义 provider；密钥库（secrets，bash 注入用）
  不在共享范围

### 凭据

- 有桌面端：无需任何配置——桌面端配好的模型和 key 自动通过共享文件生效。
- 无桌面端的机器：用 provider 环境变量：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、
  `DEEPSEEK_API_KEY`、`GEMINI_API_KEY`、`ZAI_API_KEY`、`OPENROUTER_API_KEY` 等。
  pi-ai 在“没有存储凭据”时会自动回退到 env。
- 桌面端 `state.db` 里的凭据是 Electron `aes:v1` 加密的，sidecar 本地模式
  没有主密钥，**不要直接指向桌面数据目录**（凭据解不开，且两个进程同时写库）。
  共享文件正是为绕开这一限制而设计的安全通道。
- 本地 `credentials` 表是明文（本地模式的设计如此，注入后的镜像值也落明文）。
  需要持久化时请自行评估机器权限；默认目录已按 0700 创建。

## 支持矩阵

### ACP 方法

| 方法 | 状态 | 说明 |
|---|---|---|
| `initialize` | ✅ | 返回协议 v1、`loadSession`、image/embeddedContext |
| `authenticate` | ✅（空实现） | 凭据来自 env/本地 DB，没有交互式登录 |
| `session/new` | ✅ | 绝对路径 cwd；返回 modes/models |
| `session/load` | ✅ | 回放 user/assistant/tool 历史 |
| `session/prompt` | ✅ | 文本/图片/resource/resource_link |
| `session/cancel` | ✅ | 中止内部 turn；挂起权限按取消结算 |
| `session/set_mode` | ✅ | agent / plan / ask |
| `session/set_model` | ✅ | 仅限已认证模型 |
| `session/update` | ✅ | 正文/思考/工具/图片/plan/模式/命令 |
| `session/request_permission` | ✅ | 映射内部逐工具审批 |
| `fs/*` / `terminal/*` | ❌ | sidecar 自带 read/write/edit/bash，不使用 client 能力 |

### 内部工具

| 工具 | ACP 模式 |
|---|---|
| `bash` / `task_output` / `task_stop` | ✅ 本地执行（超时转后台、进程树 kill） |
| `read` / `write` / `edit` | ✅ 本地执行（read-before-write、JSON guard） |
| `glob` / `grep` | ✅ sidecar 原生 |
| `WebFetch` / `WebSearch` | ✅ 本地 fetch |
| `mcp` 网关 | ✅ 走 `~/.kova/mcp.json` / 工作区 `.mcp.json` |
| `Task` / `TaskWait` / `TaskList` / `TaskStop` | ✅ 子代理工具经本地宿主执行 |
| `todo` | ✅ 映射为 ACP `plan` |
| 技能/记忆/设计主题/知识检索 | ✅ |
| `generate_image` / `see_image` | ✅ |
| `Question` | ⚠️ 降级：问题文本推给用户，内部按取消结算 |
| `browser_*` / `screenshot` / `open_file` / `open_plugin_panel` | ❌ 不注册（桌面 UI 专属） |
| automation 调度 | ❌ ACP 进程不启动调度器 |

### 审批

内部 `data-toolApproval` 会翻译成 `session/request_permission`：

- **批准**：`allow_once` → `tool_confirm{approved:true}`
- **允许并记住**：`allow_always`（仅 `canRemember` 时提供）→ `remember:true`
- **拒绝**：`reject_once` → `tool_confirm{approved:false}`
- **取消/超时/客户端错误**：按拒绝结算，避免内部工具永久挂起
- `plan_exit` 只提供批准/拒绝：ACP 权限卡没有文本输入通道，拒绝等同
  “无修改意见停止本轮”。需要带意见修订请在桌面端操作。

## 流式与历史

- 正文 delta → `agent_message_chunk`
- 思考 delta → `agent_thought_chunk`
- 工具开始/结束 → `tool_call` / `tool_call_update`（含 edit diff、图片结果）
- `todo` 快照 → `plan`
- 模式变化 → `current_mode_update`
- 自定义命令 → `available_commands_update`
- `session/load` 用 `thread_snapshot` 原生消息回放，过滤自动续跑/目标/能力提醒/
  并入等内部注入消息

## 已知限制

1. `session/new` / `session/load` 传入的 `mcpServers` 暂不接入（v1 记日志忽略）。
   请把服务器写进 `~/.kova/mcp.json` 或工作区 `.mcp.json`。
2. `Question` 工具没有稳定的 ACP 对应方法，v1 降级为“文本提示 + 取消”。
3. plan_exit 的拒绝理由无法通过 ACP 权限卡传递。
4. goal 模式不在 ACP 暴露；新建/载入到 goal 档会强制降为 agent。
5. 不发送 usage 更新（ACP 0.4.9 没有该 update）。
6. 同一数据目录不要同时跑多个 ACP 进程并操作同一会话；SQLite 能处理并发写，
   但同一会话的并发 turn 没有跨进程锁。
7. `session/load` 拒绝正在运行的会话；先 `session/cancel`。
8. 浏览器驱动/屏幕截图/文件面板在 ACP 模式不可用（工具不注册）。

## 排障

- 日志全部在 stderr；编辑器通常会把 agent stderr 收进自己的日志面板。
- 设置 `PI_LOG_LEVEL=delta` 可以看到 token 级日志（默认 `event`）。
- 没有模型可选：先确认对应 provider 的 API key 在启动环境里；可以用
  `ANTHROPIC_API_KEY=... kova-worker --acp` 手动起进程观察 stderr。
- 工具不执行：确认没有把 `--data-dir` 指到正在运行的桌面端数据目录；
  ACP 模式必须使用本地 SQLite + `src/local-host`。
- 构建产物验证：`bun run build` 会依次跑 NDJSON ping 与 ACP initialize 两个冒烟。
