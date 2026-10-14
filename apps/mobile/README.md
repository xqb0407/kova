# Kova Mobile（`apps/mobile`）

Pi Kova 的移动端：**Expo 客户端，不含任何后端**。所有 AI 处理、会话存储、文件操作都在你自己的桌面客户端里（`apps/desktop` 的 Tauri 宿主 + `apps/sidecar/pi-agent`），手机通过 **WebSocket 连桌面端的远程网关**（`apps/desktop/src-tauri/src/remote.rs`）执行。

桌面端的网页端（同一套 sidecar 协议、同一个 `/ws`）走的是同一条链路，所以移动端与桌面端可同时在线、共享同一份本地会话。

## 开始

1. 仓库根装依赖（bun workspaces，移动端依赖装在 `apps/mobile/node_modules`，与桌面的 Next/react 版本互不干扰）：

   ```bash
   bun install
   ```

2. 桌面端：设置 → 远程访问 → 开启网关，并**打开「局域网访问」**（默认只绑 `127.0.0.1`，手机连不上）。默认端口 8787，端点 `ws://<桌面机局域网 IP>:8787/ws`。

3. 起移动端：

   ```bash
   bun run dev:mobile          # = bun run --filter mobile start
   bun run --filter mobile ios
   bun run --filter mobile android
   bun run --filter mobile web
   ```

4. 在配对屏**扫桌面端设置页的二维码**（或手输地址 + 6 位配对码）。配对成功换取长效 token，存进系统安全存储（iOS Keychain / Android Keystore），之后重连不再需要配对码。

跨网段或公网访问：网关无 TLS，按主工程 `docs/remote-access.md` 的方式二/三走 Cloudflare Tunnel（https 下自动 `wss://`）或 Tailscale。

## 通讯链路

```
Expo App ──ws /ws──▶ 桌面 remote.rs 网关 ──NDJSON stdio──▶ pi-agent sidecar
```

- **配对**：`{type:"pair", code}` → `{type:"paired", token}`（token 只在这一次下发）。见 [pair.ts](file:///Users/herther/Desktop/ai-teamplte/apps/mobile/lib/mobile/pair.ts)。
- **复连**：`{type:"auth", token}` → `{type:"authed"}`；authed 之前的出站消息先排队，防 `unauthorized` 竞态。
- **业务帧**：sidecar 协议原样透传，每条请求带字符串 `id`（网关改写为 `rem-<连接>-<id>` 并在回帧时还原）；prompt 的流式 `chunk` 按 id 归组，直到 `chunk.type` 为 `finish`/`error`。
- **自发通知**：网关按白名单广播无 id 帧（`turn_changed`、`thread_event`、`subagent_activity`、`context_changed`、`automation_fired` 等），侧边栏运行指示与桌面端同源。
- **能力边界**：管理面写操作（凭据、MCP、技能、子代理、记忆与个性化、自动化）在网关按 `REMOTE_DENIED` **请求级**拒绝，不影响连接本身——表现为该次操作提示「该操作仅限桌面端」。
- **可靠性**：网关既无应用层心跳也无 authed 后的空闲超时，且慢消费者写出站队列上限（2048 帧）会被直接踢线。移动端的应对是指数退避重连（3s 起、30s 封顶、8 次上限后交 UI）+ 回前台立即重试 + 重连后按 `list_running` 重新水合在飞流。状态机见 [pi-ws-channel.ts](file:///Users/herther/Desktop/ai-teamplte/apps/mobile/lib/pi/pi-ws-channel.ts)，测试见 [pi-ws-channel.test.ts](file:///Users/herther/Desktop/ai-teamplte/apps/mobile/lib/pi/pi-ws-channel.test.ts)。

## 目录

- [app/_layout.tsx](file:///Users/herther/Desktop/ai-teamplte/apps/mobile/app/_layout.tsx) — 启动序列：水合 `syncStorage` → 读配对凭据 → 未配对进配对屏，已配对挂 `RuntimeProvider`。顺序不能调，播种类 store 依赖它。
- [components/ui/runtime-provider.tsx](file:///Users/herther/Desktop/ai-teamplte/apps/mobile/components/ui/runtime-provider.tsx) — `WsPiChannel` + `WsPiClient` + `usePiRuntime`；`setPiChannel` 必须先于任何 `piRequest`。
- [lib/pi/](file:///Users/herther/Desktop/ai-teamplte/apps/mobile/lib/pi) — pi 通道与运行时（与桌面端 `apps/desktop/lib/pi` 同源，宿主实现不同：桌面 Tauri、移动 WS）。跨端载荷类型一律取 workspace 包 `pi-protocol`（`packages/pi-protocol`），不在本地抄一份。
- [lib/mobile/](file:///Users/herther/Desktop/ai-teamplte/apps/mobile/lib/mobile) — 移动端宿主适配：SecureStore 凭据、配对握手、AsyncStorage 同步垫片。
- [metro.config.js](file:///Users/herther/Desktop/ai-teamplte/apps/mobile/metro.config.js) — bun workspace 解析（workspace 包的 `.ts` 源码经 symlink 进 bundle）+ uniwind/RNW 的解析例外。

## 演示模式

配对屏的「先逛逛」用 `mock:` scheme 走本地脚本化流式（`lib/pi/mock/mock-transport.ts`），不连桌面端，供无桌面环境预览与 CI 冒烟。web 端 `?demo=1` 直进演示。**演示数据不参与断链/重连判定**，界面会明确标注未连接桌面端。

## 校验

```bash
bun run typecheck:mobile
bun run test:mobile
bun run build:mobile:web     # expo export --platform web + 资源扁平化
```

明文 `ws://` 需要两端放行：iOS 走 `app.json` 的 `NSAppTransportSecurity`，Android 走 `usesCleartextTraffic`。这两项只为局域网/隧道场景打开，不要把网关地址暴露到不受信网络。

安全须知与功能边界同主工程 [docs/remote-access.md](file:///Users/herther/Desktop/ai-teamplte/docs/remote-access.md)：手机持有的是你桌面助手的对话与文件操作能力，配对码、token 与地址都按凭据对待。
