# 移动端并入 apps/mobile + 通讯统一 WebSocket 计划

## 0. 一句话目标

把独立工程 `~/Desktop/pi-kova-mobile`（Expo SDK 57 / RN 0.86 / `@assistant-ui/react-native`）作为 **`apps/mobile`** 落进本仓库（bun workspaces 已声明 `apps/*`，`apps/mobile/` 目前只有 `.gitkeep`），并把与后端的通讯**收敛到唯一一条链路：桌面端 `remote.rs` WS 网关 ⇄ pi-agent sidecar**，删除脚手架自带的 HTTP `/api/chat` 链路。

## 0.1 执行状态（2026-10-03）

| 阶段 | 状态 | 备注 |
|---|---|---|
| W1 落位 + 依赖装配 | ✅ | 移动端 typecheck / vitest / `export:web` 全绿；桌面端 tsc 零回归 |
| W2 摘除 HTTP 链路 | ✅ | 死代码删除；`app/api/` 目录不存在 |
| W3 协议单源 | ✅ | `apps/mobile/lib/pi-protocol/` 已删，改 `"pi-protocol": "workspace:*"` |
| W4 品牌与 ATS | ⚠️ 部分 | scheme→`pikova`、ATS、cleartext 已配；显示名/`bundleIdentifier` 仍按 §7 待定项 5 待确认 |
| W5 水合与可靠性 | ✅ | `hydrateStorage` 纳入启动序列；重连改指数退避 + 回前台重试，4 条状态机测试锁住 |
| W6 `lib/pi` 抽包 | ❌ 改判 | 见 §W6：受宿主绑定分叉与 app 层耦合阻塞，转为独立设计任务 |
| W7 `remote.rs` | ⏸ | 未动网关（§7 待定项 6） |

装配过程中修掉的 4 个真实问题（都不是"顺手改"，是迁移必须跨过的坎）：`typescript` 别名导致 `tsc` 未链接；根 overrides 钉在 `@assistant-ui/core 0.3.21` 使 `invokeUserCallback` / `answerToolCall` 不存在；`@types/react` 双副本造成 `Components` 类型互不兼容；`babel-preset-expo` 在 hoisting 隔离后对 `@babel/core` 不可见。另有一个环境陷阱：源码直接 import 未声明的包时，解析会逃到 `/Users/herther/node_modules` 的陈旧副本——已把 `@assistant-ui/core` / `@assistant-ui/react` / `assistant-cloud` 补为显式依赖。


## 1. 现状事实（已核对代码）

### 1.1 生效链路已经是 WS

| 环节 | 位置 | 说明 |
|---|---|---|
| 通道创建 | `apps/mobile/components/ui/runtime-provider.tsx#L46-L52` | `new WsPiChannel(url, token)`，建在 ref 里防 StrictMode 双开 |
| 通道注册 | 同上 `#L73-L86` | `setPiChannel()` 必须先于任何 `piRequest`，effect 顺序不可调换 |
| 客户端 | 同上 `#L54-L60` | `WsPiClient` 实现 PiClient 契约，`usePiRuntime` 挂外部 store |
| 协议实现 | `lib/pi/pi-ws-channel.ts` | auth 前出站缓冲、断线重连一次、原始行喂 `onRawLine` |
| 配对 | `lib/mobile/pair.ts#L14-L86` | 裸开 WS 发 `{type:"pair",code}` 换 token，与 auth 是两条独立协议 |
| 凭据存储 | `lib/mobile/secure-store.ts#L45-L93` | `pi_remote_token` / `pi_remote_host`，iOS Keychain `THIS_DEVICE_ONLY`，web 降级 localStorage |
| 启动分支 | `app/_layout.tsx#L72-L148` | 未配对 → `ConnectScreen`；已配对 → `RuntimeProvider` |

结论：**移动端不需要新增 WS 能力，需要做的是"删掉另一条链路 + 把重复的 pi 层收敛到单源"**。

### 1.2 要删的 HTTP 残留（全部为死代码或仅演示用）

- `hooks/use-app-runtime.ts` —— `useChatRuntime` + `AssistantChatTransport`，全项目无引用（只在 `.agents/skills/react-native/SKILL.md` 文档示例里出现）。
- `hooks/anonymous-session-fetch.ts` + `hooks/anonymous-session-fetch.test.ts` —— 仅被上面这个死文件引用。
- `app/api/chat+api.ts` —— 无引用；它是 `expo-server` 的 route handler。
- `package.json` 里的 `expo-server`、`@ai-sdk/openai`、`@ai-sdk/react`（若无其他用处需二次确认 `ai` 包仍被 `lastAssistantMessageIsCompleteWithToolCalls` 之外的地方使用）。
- `vercel.json`、`.env.example` 中的 `OPENAI_API_KEY` / `EXPO_PUBLIC_CHAT_ENDPOINT_URL`、`README.md` 里对应段落。
- `lib/pi/mock/mock-transport.ts` + `ConnectScreen` 的「先逛逛」入口 —— **保留**（无桌面端时的离线演示 + CI 冒烟）。约束：mock 与真连接在 UI 上必须显著区分（入口文案与顶部常驻标识均注明「演示数据，未连接桌面端」），且 mock 分支不得参与断链横幅/重连逻辑（现 `runtime-provider.tsx#L44`、`#L96-L101` 已按 `mock` 早退，迁移后需回归验证）。

### 1.3 协议层重复（迁移后必须单源）

- `mobile/lib/pi-protocol/` 是 `packages/pi-protocol/src/` 的复制，且有 3 个文件已偏移：`interactions.ts`、`payloads.ts`、`transcript.ts`。
- `mobile/lib/pi/` 与 `apps/desktop/lib/pi/` 有 19 个同名文件内容不一致（含 `pi-ws-channel.ts`、`pi-channel.ts`、`pi-bridge.ts`、`pi-runtime/pi-client-base.ts`、`pi-runtime/runtime/*` 全套），桌面另有 40 个文件移动端没有（`tauri-pi-client.ts`、`pi-running.ts`、`pi-context.ts`、各类 `.test.ts`）。

### 1.4 网关侧既有约束（`apps/desktop/src-tauri/src/remote.rs`）

- 端点 `ws://<ip>:8787/ws`，`DEFAULT_PORT = 8787`；**默认只绑 `127.0.0.1`**，需 `remote.bind.lan == "true"`（设置页「局域网访问」）才绑 `0.0.0.0`。
- 握手：`pair` → `paired{token}`（token 只下发一次）；`auth{token}` → `authed`；`MAX_PAIR_ATTEMPTS = 5`，未认证阶段逐帧 `AUTH_TIMEOUT = 10s`。
- 出站：sidecar NDJSON 原样透传，仅 `id` 重写为 `rem-{conn}-{id}`；除 `abort` 外必须带字符串 `id`；`REMOTE_DENIED_TYPES` 黑名单（凭据/MCP/skills/subagents/memory/automation 写操作）以**请求级错误帧**拒绝（`error.code = "REMOTE_DENIED"`），不断连。
- 入站：带 id 行还原 id 投递；无 id 自发通知按白名单广播 10 类：`turn_changed`、`session_state`、`subagent_activity`、`automation_fired`、`automation_run_done`、`plugin_op_result`、`context_changed`、`design_themes`、`design_theme_set`、`thread_event`。
- **无应用层心跳、authed 后无空闲超时**；每连接出站队列 `2048`，慢客户端直接被踢线（`kick_conn`）——移动端的自动重连 + 快照自愈是刚需，不是加分项。
- 无 TLS。公网走 Cloudflare Tunnel / Tailscale。`secret.rs` 的 `encrypt/decrypt` 当前是明文透传，token 实为明文落盘（注释与实现不符，移动端侧按"明文网络 + 只存 Keychain"对待）。

## 2. 分阶段计划

### W1 落位 `apps/mobile`（纯搬迁，不改行为）

1. `rsync` 排除 `node_modules/ .expo/ bun.lock package-lock.json .agents/ .git` 到 `apps/mobile/`，删掉 `.gitkeep`。
2. `apps/mobile/package.json`：`name: "mobile"`（对齐 `bun run --filter desktop dev` 的用法），删 `expo-server` 与 1.2 的死依赖。
3. 根 `package.json` scripts 增：`dev:mobile`（`bun run --filter mobile start`）、`build:mobile:web`、`typecheck:mobile`、`test:mobile`。
4. `bun install`（根单锁），删 `apps/mobile/package-lock.json`。
5. Metro：现 `metro.config.js#L8` 的 `monorepoRoot = ../..` 在新位置仍指仓库根 ✓，但 `#L11-L48` 那段以 `pnpm-workspace.yaml` + `packages/ui` 为条件，本仓库不成立 → 改为 bun workspace 形态：`watchFolders = [monorepoRoot]`、`unstable_enableSymlinks = true`、`nodeModulesPaths = [apps/mobile/node_modules, root/node_modules]`，并强制 `react` / `react-native` / `react-native-web` / `@assistant-ui/*` 单实例（保留 `resolveRequest` 兜底，但判据从 `kitRoot` 改为「来自仓库根的 workspace 包」）。
6. TS：`apps/mobile/tsconfig.json` 的 `@/*` 保持自指（不接仓库根 paths）；验证仓库根 `tsconfig.tsbuildinfo` 不污染。
7. 跑通：`bun run --filter mobile typecheck`、`bun run --filter mobile test`、`expo start --web` + iOS 模拟器起得来。

**退出标准**：移动端在仓库内可编译可运行，WS 连桌面网关聊天正常，仓库 `bun run dev` / `tauri:dev` 零回归。

### W2 摘除 HTTP 链路

按 1.2 清单删除，并把 `README`/`docs/remote-access.md` 的移动端章节改为「配对 → WS」。删除后 `app/api/` 目录消失，确认 `app.json` 无 `server`/`web.output` 依赖变化（当前 `web.output: "static"` ✓，纯静态导出可行）。

### W3 协议单源（`lib/pi-protocol` → `pi-protocol` 包）

1. 先 diff 三个偏移文件，把移动端的合理改动**上提到 `packages/pi-protocol`**（不合并则显式保留差异并说明），避免"迁移动手即回退桌面行为"。
2. 依赖改 `"pi-protocol": "workspace:*"`，全量替换 `@/lib/pi-protocol` → `pi-protocol`，删本地副本。
3. 风险验证：包 `exports` 直指 `./src/index.ts`（TS 源码），Metro 需能跨 symlink 转译 `.ts`。验证方式：`expo export --platform web` + iOS bundle 各跑一次；若失败，备选是给包加 `dist` 构建步骤或在 Metro 里把该包加入 `unstable_transformImportMeta`/`sourceExts` 白名单。

### W4 移动端原生与深链配置（WS 可达性）

1. `app.json`：`name/slug` 改为 Kova Mobile，`scheme` 改 **`pikova`** —— 现 `scheme: "withexpo"` 与 `connect-screen.tsx#L140-L141` 里硬编码的 `pikova://pair#h=` 不一致，深链配对当前是坏的。`bundleIdentifier` 从 `com.assistant-ui.with-expo` 改为自有标识。
2. iOS ATS：`expo-build-properties` 增 `ios.NSAppTransportSecurity`，放开局域网明文 `ws://`（优先 `NSAllowsLocalNetworking`，需真机验证 RN WebSocket 是否受益；不行则 `NSAllowsArbitraryLoads: true` + 文档说明仅局域网用途）。
3. Android：`android.usesCleartextTraffic: true`（或 `networkSecurityConfig` 只放私有段）。
4. 保持 `enableSceneSupport: true`、`expo-secure-store` 插件不变。

### W5 水合与可靠性修补（迁移期暴露的真实缺陷）

1. `lib/mobile/storage.ts#L12` 声明「启动必须 `await hydrateStorage()`」，但全项目**无调用点**（`app/_layout.tsx` 只 await 了 `loadRemoteConfig`）→ 在 `_layout` 启动序列里补 await，或让 `syncStorage` 首读阻塞水合。
2. 通道重连策略现仅"自动重连一次"（`pi-ws-channel.ts#L109-L118`）。移动端切后台/网络切换是常态 → 改为**指数退避 + 前台激活即重连**，配合既有 `onAuthed` 快照自愈；并把 `OUTBOUND_QUEUE_LIMIT` 踢线视为可重试错误而非终态。
3. 明确"网关拒绝"与"链路故障"分离：`REMOTE_DENIED` 帧只使单次请求失败，不得触发断链 UI。

### W6 `lib/pi` 收敛 —— **实测后判定：不是文件搬迁，是一次依赖注入改造**

原设想是把两侧同源的引擎文件抽成 `packages/pi-client`。执行前按宿主绑定和 app 层耦合逐文件量了一遍，结论是**当前形态下无法安全抽包**，两个独立阻塞点：

**① assistant-ui 宿主绑定分叉**（引擎文件按 host 导入不同的包，内容必然不同）

| 文件 | 桌面 | 移动 |
|---|---|---|
| `runtime/usePiRuntime.ts` | `@assistant-ui/react` | `@assistant-ui/react-native` |
| `runtime/ThreadController.ts` | `@assistant-ui/react` | `@assistant-ui/react-native` |
| `runtime/messageProjection.ts` | `@assistant-ui/react` | `@assistant-ui/react-native` |
| `runtime/runtimeTypes.ts` | `@assistant-ui/react` | `@assistant-ui/react-native` |
| `runtime/hostUi.ts` | `@assistant-ui/react` | `@assistant-ui/react-native` |

这 5 个文件正是 19 处漂移的主要来源——漂移不是"谁落后了"，而是**按宿主各写一份**。

**② 引擎已长进各自的 app 层**（`pi-runtime` 之外没有接缝）

- 移动 `pi-client-base.ts` import `@/lib/mobile/request-id`、`@/lib/host-effects`（移动端把副作用聚合成一个空实现总线）。
- 桌面 `pi-client-base.ts` import `@/lib/pi/pi-session-mode`、`@/lib/pi/pi-goal-limit-draft`、`@/lib/panels/panel-tabs`、`@/lib/workspace/file-tree`、`@/lib/pi/pi-running`、`@/lib/pi/agent-events`、`@/lib/subagent/subagent-runs`，并直接 `window.dispatchEvent("agent-panel:open" | "plugin-panel:refresh")`。
- `turn-checkpoints.ts` 桌面侧依赖 `@/lib/git/git`、`@/lib/git/git-status`、`@/lib/pi/pi-checkpoints`（git 检查点台账）；移动端把类型内联、实现为空。

即：引擎的「结算/面板/git/事件派发」在桌面是真实依赖，在移动是空实现。抽包前必须先把这些做成注入端口，否则包要么拖进 `@/lib/git`、要么拖进 `window`。

**已完成的准备（本次做掉的部分）**

- `pi-protocol` 单源（W3）：`apps/mobile/lib/pi-protocol/` 副本删除，改 `"pi-protocol": "workspace:*"`，6 处 import 切包；三处漂移判定为移动端落后，已按主工程口径收敛（goal 状态机去 `budget_limited`/`tokenBudget` 改用轮数上限）。
- **W6 最大的技术风险已被消解**：Metro 能跨 workspace symlink 转译 `.ts` 源码包，web export 与 bundle 内容均已验证——将来 `pi-client` 落地不会再卡在构建层。
- 引擎文件按可抽性分层（`pi-runtime` 20 个文件）：12 个两侧完全一致且零宿主绑定；3 个一致但有 app 层耦合（`pi-client-base.ts`、`turn-checkpoints.ts`、`index.ts`）；5 个受宿主绑定分叉阻塞。

**后续独立任务（建议按此顺序，勿与搬迁同批）**

1. 定义端口 `PiClientEffects`（`emitAgentEvent` / `refreshFileTree` / `resyncRunning` / `applyDelegationChunk` / `openPanel` / `resolveCwd` / 检查点台账 / `newRequestId`），桌面接真实现、移动接空实现或 RN 等价物；`pi-client-base.ts` 与 `turn-checkpoints.ts` 改为构造注入。
2. 把 12 个一致文件 + 上述两文件迁入 `packages/pi-client`（`exports` 指 `src/*.ts`，依赖 `pi-protocol`；包内禁止 import `@tauri-apps/*`、`expo-*`、`react-native`、`window`）。
3. 解决宿主绑定：包内只保留与宿主无关的状态机与投影类型，`usePiRuntime`/`ThreadController`/`messageProjection`/`runtimeTypes`/`hostUi` 留在各 app，或引入「按 host 注入的类型契约」再上提——这一步取决于 assistant-ui 是否会提供跨 `react` / `react-native` 的统一入口，先向上游确认再决定，别自己造第二套。
4. `apps/desktop/next.config.ts` 的 `transpilePackages` 加 `"pi-client"`（与 `"pi-protocol"` 并列）。
5. 每步单独提交，验收门：`apps/desktop` tsc、`apps/mobile` typecheck/test/export、桌面端 git 检查点卡片与面板联动不回归。

### W7 网关侧待办（`remote.rs`，视需要另开计划）

- 应用层心跳（服务端 30s ping 或要求客户端 20s 内 `{"type":"ping"}`），避免蜂窝/NAT 半开连接占着 `authed_txs`。
- `GET /ws` 增加 `?client=mobile` 标识与连接数上限（现无上限）。
- 慢客户端队列 2048 踢线前先降级（丢弃可重建的 `thread_event` 而非 `prompt` chunk）。
- 可选：`pi_remote_status` 增加已配对设备列表，供移动端「撤销本设备」。

## 3. 文件映射与处置

| 源（pi-kova-mobile） | 目标（apps/mobile） | 处置 |
|---|---|---|
| `app/`（除 `app/api/`） | `app/` | 保留 |
| `app/api/chat+api.ts` | — | 删除（W2） |
| `hooks/use-app-runtime.ts`、`anonymous-session-fetch*` | — | 删除（W2） |
| `lib/pi-protocol/` | — | 删除，改用 `pi-protocol` 包（W3） |
| `lib/pi/`、`lib/mobile/`、`components/`、`global.css`、`assets/` | 同名 | 保留 |
| `metro.config.js` | 同名 | 重写 monorepo 分支（W1.5） |
| `package.json` | 同名 | 改名 `mobile`、删死依赖（W1.2） |
| `app.json` | 同名 | scheme/包名/ATS（W4） |
| `vercel.json`、`package-lock.json`、`bun.lock`、`.expo/`、`node_modules/` | — | 不入库 |
| `README.md` | 同名 | 重写为「配对 → WS → 桌面网关」说明，指向 `docs/remote-access.md` |
| `debug-chat-text-pan-scroll.md` | `docs/` | 移位（非必需） |
| `.agents/skills/` | 仓库根已存在 | 不重复入库 |

## 4. 验收标准

1. 仓库根 `bun install && bun run --filter mobile typecheck && bun run --filter mobile test && bun run --filter desktop build && bun run --filter pi-agent-sidecar test` 全绿。
2. 真机（iOS + Android）与桌面同一局域网：桌面开网关并允许局域网 → 手机扫桌面二维码/手输 6 位码 → 配对成功 → 会话列表、历史回放、流式回复、中断、工具审批、提问卡片全部可用。
3. 断链矩阵：网关关闭（收 `closed` 帧）、sidecar 退出（`pi-agent terminated`）、手机切后台 5 分钟、Wi-Fi→蜂窝切换、慢消费者被踢线 —— 五种情形均自动重连并重新水合在飞流，不出现「假连接成功」。
4. token 被桌面「撤销所有设备」后，手机 auth 失败 → 退回配对屏（不无限重连）。
5. 管理面操作在手机上给出「该操作仅限桌面端」的局部提示，连接保持。
6. 桌面端零回归：`apps/desktop` 的 tsc 通过，根 overrides 上调（`@assistant-ui/core ^0.3.22`、`store ^0.3.16`、`tap ^0.9.20`）不改变桌面行为。移动端校验门：`bun run --filter mobile typecheck`、`test`（含 `pi-ws-channel.test.ts` 的 4 条重连状态机用例）、`export:web` 全绿。`packages/pi-client` 抽包属后续独立任务（§W6），本次验收不含它。

## 5. 风险登记

| 风险 | 证据 | 对策 |
|---|---|---|
| bun workspace 下 RN 多实例致 Metro 红屏 | 现 config 的 pnpm/`packages/ui` 判据在本仓库不成立 | W1.5 强制单实例解析；`react/react-native/react-native-web` 只允许一处 |
| `pi-protocol` exports 指 `.ts`，Metro 转译失败 | `packages/pi-protocol/package.json#L6-L8` | W3.3 双端 bundle 验证 + 备选 dist |
| iOS ATS 拦掉明文 `ws://` | `remote.rs` 无 TLS；`app.json` 未配 ATS | W4.2/4.3 |
| 深链配对当前已坏 | `scheme: withexpo` vs 代码里 `pikova://pair#h=` | W4.1 统一 |
| `hydrateStorage` 未 await，首帧读空 | `storage.ts#L12` 与全项目无调用点 | W5.1 |
| 无心跳 + 队列 2048 踢线 | `remote.rs#L110-L113`、无 idle 超时 | W5.2 客户端退避重连；W7 服务端心跳 |
| 协议包漂移被静默合并，桌面行为回退 | `interactions/payloads/transcript` 三处 diff | W3.1 先判定归属再删副本 |
| token 实为明文落盘 | `secret.rs#L25-L38` 透传 | 手机侧只进 SecureStore；文档如实描述威胁模型 |

## 6. 暂不做

- 推送通知（APNs/FCM）、多网关/多设备管理 UI、离线消息队列、端到端加密、移动端管理面（模型/MCP/技能设置）。
- W1–W5 期间不改 sidecar、不改桌面端 UI；对 `apps/desktop` 的唯一可能改动是 W7 的 `remote.rs` 网关侧（心跳/连接上限/降级丢弃），该项是否并入本次发版见 §7 待定项 6。

## 7. 决策

已定（2026-10-03）：

1. **`apps/mobile` = 纯 WS 远程客户端** —— `app/api/chat+api.ts`、`hooks/use-app-runtime.ts`、`hooks/anonymous-session-fetch*`、`expo-server`、`@ai-sdk/*`（若无其他引用）、`vercel.json`、`OPENAI_API_KEY`/`EXPO_PUBLIC_CHAT_ENDPOINT_URL` 全部删除。移动端不再自带任何后端形态，唯一出口是桌面网关 `ws://…/ws`。
2. **演示模式保留** —— `mock:` scheme + 「先逛逛」入口保留，UI 必须显著标注为演示数据且不参与断链/重连判定（见 1.2 末条）。
3. **W6 原定"一并做掉"，实测后改判为独立设计任务** —— 引擎层存在 assistant-ui 宿主绑定分叉（`react` vs `react-native`）与 app 层耦合（git/面板/`window` 事件），抽包不是文件搬迁而是依赖注入改造。本次只交付 W1–W5 + W6 的前置（协议单源、可抽性分层、Metro 跨 workspace 源码包验证），详见 §W6 的阻塞点与后续步骤。

仍待定：

4. 移动端 web 导出（`expo export --platform web`）是否纳入桌面网关静态托管（现托管 `apps/desktop/out/`），实现同一地址手机浏览器即开；还是只发原生包。
5. 品牌标识取值：`scheme: pikova`（修好深链配对）、`bundleIdentifier`、显示名。
6. W7 的 `remote.rs` 改动（心跳、连接数上限、降级丢弃策略）是否并入本次发版。
