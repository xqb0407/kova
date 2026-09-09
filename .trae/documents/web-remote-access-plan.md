# 网页远程接入 pi-agent 实现方案（WS 直连 + 配对码）

## Context

桌面端（Tauri）通过 Rust 桥 + NDJSON stdio 驱动 pi-agent sidecar，会话/历史均落用户本机。现有网页分支（`/api/chat`）是云端演示，与"底层客户端处理"的产品定位相悖。目标：**网页端作为远程入口穿透回用户桌面客户端**——sidecar 始终跑在桌面端，网页通过 WebSocket 连接执行，让用户在公网访问自己的桌面 agent。

已拍板的决策：
1. **穿透方式**：内网穿透直连（Cloudflare Tunnel / Tailscale 等任意 TCP 隧道）。桌面端只在本地起 WS 服务，不做中继服务器。
2. **认证**：配对码流程——桌面 UI 显示 6 位码，网页输入后换取长效 token（桌面存 kv，网页存 localStorage），后续连接带 token。
3. **远程 MVP 功能面**：流式聊天 + 会话列表/历史/重命名/删除 + 中断。模型/技能设置、工作区选择不开放（远程 `cwd=null`，新会话落桌面用户主目录，为已知限制）。

## 架构总览

```
浏览器(公网隧道域名)                 桌面客户端(Tauri)
┌──────────────────┐   wss   ┌────────────────────────────────┐
│ WsPiChannel       │ ──────▶ │ remote.rs WS 网关 (0.0.0.0:8787)│
│ (lib/pi-ws-       │  NDJSON │  ├ pair/auth 状态机             │
│  channel.ts)      │ ◀────── │  ├ id 重写 + 路由表(静态)        │
│ RemoteThreadList  │         │  └ 复用 pi_agent.rs 的           │
│ + adapter 原样复用 │         │    stdin/stdout 路由            │
└──────────────────┘         └────────────────────────────────┘
```

桌面 webview 仍走 invoke（不经 WS）；桌面与远程可同时在线（sidecar 单实例，id 全局唯一可路由）。

## A. Rust 侧 WS 网关

### 依赖（Cargo.toml）

```toml
tokio = { version = "1", features = ["sync", "net", "rt", "macros", "time", "io-util"] }
tokio-tungstenite = "0.26"   # 只要 WS + JSON，不引入 axum/hyper 全家桶
futures-util = "0.3"
uuid = { version = "1", features = ["v4"] }
```

无需动 `capabilities/default.json`（自注册命令无权限要求）。

### 新模块 `src-tauri/src/remote.rs`（核心，≈300 行）

**WS 第一层协议**（auth 后透传 sidecar 原始格式，id 必填）：

```jsonc
// 客户端 → 服务端（未认证阶段）
{ "type": "pair", "code": "483920" }
{ "type": "auth", "token": "<64hex>" }
// 客户端 → 服务端（authed 后，sidecar 原样格式）
{ "type": "prompt", "id": "pi-xxx", "text": "...", "threadId": "...", "sessionId": "...", "cwd": null }
{ "type": "abort" }                    // 无 id，全局
{ "type": "list_sessions", "id": "..." }  // new_session/get_history/delete_session/rename_session/ping 同理

// 服务端 → 客户端
{ "type": "paired", "token": "<64hex>" }
{ "type": "authed" }
{ "type": "error", "errorText": "...", "attemptsLeft": 2 }
{ "type": "closed", "reason": "gateway stopped" }
// authed 后全部为 sidecar 原样行：{id, chunk} 流或管理响应行
```

**id 重写与路由**：网关把远程消息 id 重写为 `rem-{connSeq}-{origId}` 后写入 sidecar stdin，并登记路由表 `sid → (该连接出站 mpsc, origId)`。stdout 行命中路由表则改回 origId 投递到对应连接出站队列，终结性消息（`chunk.type == finish|error` 或管理响应）顺手摘除路由。隔离本地 `pi-{n}`/`mgr-{n}` 命名空间。

**生命周期命令**（注册进 lib.rs 的 `generate_handler!`）：

```rust
pi_remote_start(app, state, port: Option<u16>) -> RemoteStatus  // 默认端口 8787
pi_remote_stop(state) -> ()
pi_remote_status(state) -> RemoteStatus  // { running, port, code, connections }
pi_remote_refresh_code(state) -> String
```

- 绑定 `0.0.0.0:8787`（隧道回源本机、Tailscale 接口、局域网直连三种覆盖；Windows 首次绑定弹防火墙授权）。
- 配对码：6 位数字，start 时生成，**只存内存**（RemoteState）；校验失败 5 次/连接即断开；未认证 10s 超时断开。
- token：双 uuid 拼 64 hex，存 kv key `remote.token`（持久，重启网关复连有效）。
- 任务模型：`pi_remote_start` 内 TcpListener bind → spawn accept_loop（select shutdown）；每连接单任务：`accept_async` 握手 → split sink/stream → `select!` 入站(pair/auth/透传)与出站队列。
- `RunEvent::Exit` 时停网关。

### `pi_agent.rs` 改造点（最小侵入）

1. stdout 循环（现 L84-90）：本地 pending 未命中之后、`pi-chunk` 广播之前插入 `if remote::try_route(&line) { continue; }`。
2. `CommandEvent::Terminated` 分支：加 `remote::notify_terminated()`（清路由表 + 向所有远程连接推 error）。
3. `write_line` 改 `pub(crate)`（child Mutex 已保证 NDJSON 行原子，多连接并发写安全）。

### `store.rs` 增加两个内部助手

```rust
pub fn kv_get_global(app: &AppHandle, key: &str) -> Result<Option<String>, String>;
pub fn kv_set_global(app: &AppHandle, key: &str, value: &str) -> Result<(), String>;
```

（内部 `app.state::<DbState>()`，不改表结构。）

## B. 前端通道抽象

### 新 `lib/pi-channel.ts`：收口 PiChannel 接口 + 模块级注册表

```ts
export interface PiChannel {
  readonly kind: "tauri" | "ws";
  request(payload: Record<string, unknown>, timeoutMs?: number): Promise<PiResponse>;
  promptStream(args: PromptStreamArgs): ReadableStream<UIMessageChunk>;  // args 含 requestId/text/threadId/sessionId/cwd/abortSignal
  abort(): Promise<void>;
  close?(): void;
  onStatusChange?: (cb: (s: PiChannelStatus) => void) => () => void;
}
let current: PiChannel | null = null;
export function setPiChannel(ch: PiChannel | null) { current = ch; }
export function getPiChannel(): PiChannel { return current ??= new TauriPiChannel(); }
```

- `TauriPiChannel`：现 `pi-bridge.ts` 的 invoke("pi_request") 逻辑 + 现 `pi-transport.ts` sendMessages 主体（listen "pi-chunk" → invoke "pi_prompt" → 按 id 过滤）平移。
- 新 `lib/pi-ws-channel.ts`：`WsPiChannel`——connect → 发 `{type:"auth", token}` → authed 置 ready；onmessage：有 `chunk` 字段按 id 走 streams（finish/error 关流），否则按 id 走 pending map；onclose：reject 全部 pending、error 全部 streams、退避重连一次后交 UI。request 注入 id `ws-{seq}-{ts}`；promptStream 先挂 streams 再发 prompt 防漏首批。

### 零改动复用

- `lib/pi-bridge.ts`：`piRequest` 主体缩为委托 `getPiChannel().request(payload, timeoutMs)`，类型导出全保留。
- `lib/pi-thread-adapter.ts`：**完全不动**（只依赖 piRequest 与 getWorkspace）。
- `lib/pi-transport.ts`：`TauriPiTransport` 壳化为从 `getPiChannel()` 取通道实现 `ChatTransport`，同一份实现服务两种 channel。
- **时序约束**：`setPiChannel` 必须先于 `createPiThreadListAdapter()` 首次调用（RemoteRuntimeProvider 的 useMemo 顺序保证）。

### 新 `lib/remote.ts`

`getRemoteConfig()/setRemoteConfig()/clearRemoteConfig()/isRemoteMode()`；存档 localStorage key `pi.remote` = `{url, token}`；`isRemoteMode()` = `!isTauri() && 有配置`（SSR 恒 false）。

### `components/runtime/app-runtime-provider.tsx` 三分支

```
AppRuntimeProvider
 ├─ isTauri() → TauriRuntimeProvider（现状不动）
 └─ RemoteGate
     ├─ 首帧/SSR → null（避免水合不匹配）
     ├─ 无存档 → <ConnectScreen>（输入 ws://IP:8787 或 wss://隧道域名 + 6位码
     │            → 临时 WS pair → 拿 token 存 localStorage → setPiChannel → 进入运行时）
     └─ 有存档 → RemoteRuntimeProvider
            = useRemoteThreadListRuntime + PiTransport(WsPiChannel) + createPiThreadListAdapter()
              （与 TauriRuntimeProvider 完全同构，只换 channel）
              WS 断开重连失败 → 顶部状态条 + 可回连接屏（token 保留）
```

### isTauri 守卫小改清单（远程模式下隐藏桌面专属 UI）

| 文件 | 改动 |
|---|---|
| `components/settings/settings-modal.tsx` | 桌面端加 "remote" 分区（见 P4）；Model/Skills 现有降级分支不用改 |
| `components/agent-thread/clone-thread-shell.tsx` | 设置按钮（L410 桌面侧栏、L504 移动 Sheet）外层 `isRemoteMode()` 隐藏 |
| `components/agent-thread/header.tsx` | 可选：远程模式隐藏 ModelPicker |
| `composer.tsx` / `workspace-store.ts` / `model-settings.ts` | 无需改（现有 `!isTauri()` 分支已覆盖远程场景） |

桌面端"远程访问"设置分区（settings-modal）：网关开关 + 状态/连接数 + 大字号配对码 + 刷新按钮 + 隧道地址提示文案。

## C. 实施步骤

| 阶段 | 改动文件 | 验收标准 |
|---|---|---|
| **P0 依赖** | `src-tauri/Cargo.toml` | `cargo check` 零新增错误 |
| **P1 Rust 网关** | `store.rs`(+2 助手)、`remote.rs`(新)、`pi_agent.rs`(3 处小改)、`lib.rs`(mod/命令/exit hook) | tauri:dev devtools 执行 `pi_remote_start` → status `{running:true, port:8787, code:"6位", connections:0}` |
| **P2 通道抽象** | `pi-channel.ts`(新)、`pi-ws-channel.ts`(新)、`pi-bridge.ts`、`pi-transport.ts` | **回归**：桌面端聊天流式/列表/重命名/删除/历史/中断与改造前逐项一致（纯重构零行为变化） |
| **P3 远程连接** | `remote.ts`(新)、`connect-screen.tsx`(新)、`remote-runtime-provider.tsx`(新)、`app-runtime-provider.tsx` | 浏览器 localhost:3000 → 连接屏 → 配对 → 运行时全功能通；杀网关显示断开可重连 |
| **P4 守卫与桌面入口** | `settings-modal.tsx`、`clone-thread-shell.tsx`、`header.tsx`(可选) | 桌面设置可开关网关看实时配对码；远程界面无设置入口/工作区胶囊 |
| **P5 隧道文档** | `docs/remote-access.md`(新) | 按文档可完成 cloudflared / Tailscale 两条接入路径 |

注意：动前端前先读 `node_modules/next/dist/docs/` 相关章节（Next 16 有破坏性变更，见 AGENTS.md）。

## D. 验证方案

1. **协议层**（node 脚本/wscat，绕过前端）：桌面启动网关拿配对码后：
   ```jsonc
   > {"type":"pair","code":"<码>"}        ← {"type":"paired","token":"..."}
   > {"type":"auth","token":"..."}        ← {"type":"authed"}
   > {"type":"list_sessions","id":"t1"}   ← {"id":"t1","type":"sessions",...}
   > {"type":"prompt","id":"p1","text":"你好","threadId":"remote-test","cwd":null}
                                          ← 逐行 {"id":"p1","chunk":{...}} 至 finish
   > {"type":"abort"}                     ← 进行中发，流收尾
   ```
   负例：错码 5 次 → 断开；未 auth 发请求 → `unauthorized`；重启网关旧 token 仍可 auth。
2. **多机模拟**：同网段另一设备浏览器开 `http://<桌面IP>:3000` 走 P3 路径。
3. **回归**：P2 后桌面端全功能跑一遍确认零回归。
4. **穿透收尾**：`cloudflared tunnel --url http://localhost:8787` → 连接屏填 `wss://xxx.trycloudflare.com`（https 页面必须 wss）+ 配对码；Tailscale 路径填 `ws://<桌面 tailscale IP>:8787`。
5. **安全确认**：token 仅首次配对下发、kv 明文（MVP 接受，文档注明）；配对 5 次失败断开；网关关闭 WS 全断；abort 为全局（会同时打断本地 prompt，MVP 接受并注释标注）。

## 关键文件

- `src-tauri/src/remote.rs`（新建，网关核心）
- `src-tauri/src/pi_agent.rs`（stdout 路由钩子，3 处小改）
- `src-tauri/src/store.rs`（+2 kv 助手）、`src-tauri/src/lib.rs`（命令注册）
- `lib/pi-channel.ts`、`lib/pi-ws-channel.ts`、`lib/remote.ts`（新建）
- `lib/pi-bridge.ts`、`lib/pi-transport.ts`（壳化委托）
- `components/runtime/app-runtime-provider.tsx`（三分支）、`components/remote/connect-screen.tsx`、`components/remote/remote-runtime-provider.tsx`（新建）
- `components/settings/settings-modal.tsx`（远程访问分区）、`components/agent-thread/clone-thread-shell.tsx`（守卫）
