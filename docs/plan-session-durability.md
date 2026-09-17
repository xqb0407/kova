# 会话持久化与崩溃恢复改造计划（session durability）

> 背景：2026-09-17 事故排查结论 —— 会话 `efcae0c7`（"写个小游戏word世界"）中，
> assistant 回复连续流式了 ~12 分钟但 **一行都没有落盘**，app 重启（`child.kill()`）
> 把 sidecar 连同内存中的 run 直接抹掉。根因三件套：
> 1. assistant 消息只在 `agent_end` 才 persist（`stream.ts:213`），运行中途零提交点；
> 2. 运行态（running 表、state.messages）纯内存，重启后无任何"接续/结算"逻辑；
> 3. Rust 退出处理是 SIGKILL（`pi_agent.rs:485 kill_on_exit`），sidecar 连收尾机会都没有。
>
> 设计参照：pi harness（`~/Downloads/pi-main/packages/agent/src/harness/`）的
> 事务化 journal + 持久状态机。按成本分三档落地，L0 必做，L1 可选，L2 只做调研。

---

## L0：消息级即时落盘 + 宿主优雅停机（必做，预计 2~3 小时）

**效果**：崩溃/强杀最多丢"当前正在流式的那一条消息"；正常退出零丢失。

### L0-1. `message_end` 粒度 persist

文件：`apps/sidecar/pi-agent/src/stream.ts`

- 现在 `message_end` 分支：`role === "user"` → `persist(run, { earlyUser: true })`；
  assistant → `if (!reqId) break;` 再走错误上报。
- 改为：**assistant 与 toolResult 的 `message_end` 也调用 `await persist(run)`**，
  且必须放在 `if (!reqId) break;` 之前——旁路 run（无前端直播、自动化）同样要落盘。
- `transcript.persist()` 的 `run.persistedSeq` 增量机制天然支持，不用改签名。
- 注意标题触发：非 earlyUser 的 persist 会 `void maybeSummarizeSessionTitle(run)`，
  内部已有 per-session one-shot 占坑防抖（transcript.ts:~330），首轮第一条
  assistant message_end 就触发标题（行为变化：更早，属改善）；确认测试
  `transcript.test.ts` "persist" 块对 `titleTries` 的期望是否需要跟随。
- 性能：每条消息多一次 `appendFileSync` + 一次 `sessionTouch` RPC（低频，轮级×N），
  可接受；不要在这条路径上加 fsync。

测试：`apps/sidecar/pi-agent/src/transcript.test.ts` 新增用例 ——
run 中途（只到第一个 assistant message_end）读 `readTranscript`，断言 assistant
行已存在且 seq 连续。

### L0-2. sidecar `shutdown` 控制消息（先落盘再退）

文件：`apps/sidecar/pi-agent/src/protocol.ts`（消息分发处，参考现有 `case "abort"`）、`index.ts`

- 协议新增入站消息 `{"type":"shutdown","id"?}`：
  1. 对 `running` 表全部 run 执行现有 `abortRun()`（abort 使 vendored core 的
     `streamAssistantResponse` 在 `done/error` 分支把 **partial 消息**推入
     `state.messages` → `agent_end` → `persist`；即 abort 路径配合 L0-1 就是"结算在飞内容"）；
  2. `cancelAllEntries()` 清队列，未执行的排队项不恢复；
  3. 等所有 run settle（参考 `agent.waitForIdle` 语义：`run.agent` 当前 promise），
     上限 5s；
  4. 回 `{"id", "type":"shutdown_ok"}` 后 `process.exit(0)`；超时直接 exit。
- 无 id 时按通知处理，只回 exit。

### L0-3. Rust 退出路径改为"先 stdin 通知，宽限后再 kill"

文件：`apps/desktop/src-tauri/src/pi_agent.rs`（`kill_on_exit`，行 485 附近）

- 在 `kill()` 前：通过**现有的 stdin NDJSON 写通道**（同 `list_sessions` 等管理请求
  的发送路径）写 `{"type":"shutdown"}`，等 6s 内进程退出或 stdout 关闭，
  再兜底 `child.kill()`。
- `kill_on_exit` 当前是同步 `try_lock`：改造时注意它可能在同步上下线被调用，
  等待逻辑放 `tokio::spawn` + 阻塞退出循环（看 lib.rs 里 plugin 的 `on_exit`/
  RunEvent 挂点，保持现有调用方签名不变）。
- 已知盲区（写进注释即可）：`tauri dev` 重启/进程组 SIGKILL 不走此路径——
  由 L0-1 的消息级落盘兜底，这正是 L0-1 存在的理由。

### L0 验收（模拟事故场景）

1. `bun test`（sidecar）通过；
2. 手动：发一条会产生多轮工具调用的长任务（如"写个小游戏"），跑到一半
   强杀 app → 重开 → 打开该会话：应看到已完成轮次的 assistant/tool 内容，
   最后一条在飞消息缺失或带 aborted 标记（不再是只剩用户消息）；
3. 正常退出 app → 重开 → 该会话完整（含最后一条 partial，stopReason=aborted）。

---

## L1：日志即重放缓冲 —— 流式帧临时落盘（可选，预计 1 天，先做技术评审）

**效果**：页面刷新/断线重连不依赖前端 sessionStorage 登记与内存 chunk 缓冲，
`attachStream` 从文件续读；远程 WS 二期"网关保留路由 + resume"直接复用。

- sidecar：`sendChunk` 路径把 per-request 的 UI chunk 同步追加到
  `sessions/<sessionId>.frames/<requestId>.jsonl`（append-only，启动时清理
  超过 24h 的孤儿 frames 目录）；run settle 后延迟删除（保留窗口供重挂取尾）。
- 本地通道 `lib/pi-channel.ts` / `pi-transport.ts` 的 `attachStream`：
  改为读 frames 文件全量重放 + tail 续读（fs.watch 或轮询 200ms），
  不再要求与 run 同进程生命周期；remote.rs WS 网关二期同构。
- 注意与 `finish`/`error` 终止块幂等：重放遇到终止块即关流。
- 风险：文件 IO 频率 = chunk 频率（token 级）。先压测；必要时 frames 文件
  按 50ms 批量合并行（pi 的做法是每帧一行 + 结算删除，可参照其
  `harness/runtime/progress.ts` / `drive/response.ts` 的 deleteList 时机）。

## L2：harness runtime 换装调研（只做 spike，不排期）

- 评估直接用 `@earendil-works/pi-agent-core/harness/session`（jsonl repo 已内置，
  含事务/撕裂行容忍/fork）替换手写 `transcript.ts` 的读写层：
  能去掉哪些代码（去重 seq、header、检查点行格式兼容）；
- 评估 Lane 持久状态机（`harness/runtime/drive/*`）接入成本：
  `protocol.ts`/`stream.ts` 的 chunk 映射需要重写到 `entry_added` 事件源上；
- 产出一页结论：替换 or 保持现状+借鉴（checkpoint continuation、
  ToolCall `replay: never|safe` 分类是低成本可借鉴项）。

---

## 执行顺序与提交切分

1. commit A：L0-1 + 测试（sidecar 单包，独立可回归）
2. commit B：L0-2 + L0-3（协议与宿主成对改，同一 commit 便于回滚）
3. L1 评审通过后再单独分支
4. L2 spike 结果放进 `docs/`

## 不要顺手做的事

- 不改 JSONL 现有行格式（`type:"message"` seq 语义保持，前端 `historyToUiMessages`
  与压缩检查点都依赖它）；
- 不动 credential/主密钥相关代码（23:31 日志里的 `credential decrypt failed for 3`
  是迁移遗留脏行，独立小 task：清 `credentials` 表里 provider="3" 的孤儿行即可）。
