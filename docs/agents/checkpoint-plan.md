# Checkpoint（回合级改动快照与 Undo）实现计划

> 参考实现：`参考档案仓（本地留存，不入库）/src-tauri/src/checkpoint.rs`（2172 行）+ `checkpoint/turn.rs`（915 行）。
> 目标：kova 的会话获得「这一轮 agent 改了什么、单文件回滚、整轮回滚」能力，且**所有权判定严格**——没把握的编辑只展示、不提供 Undo。
> 本文档 = 参考实现 拆解 + kova 落地方案 + 分期。文末附「其他值得学习且改动不大」清单。

---

## 1. 参考实现 是怎么做的（拆解）

### 1.1 双层结构

| 层 | 存储 | 职责 | Undo 资格 |
|---|---|---|---|
| **条目层**（shadow copy） | app 数据目录 `checkpoints/<session>/files/` 下按路径镜像 before/after 两份 blob + `manifest.json` | 会话所有权的 before/after 对、行数统计、跨会话分歧检测 | 只有在**结构化编辑开始前**捕获过 before 快照（`prepared` 集）的文件 |
| **回合层**（git-backed） | 仓库内隐藏 refs `refs/<项目名>/checkpoints/<session>/<turn>/{before,after}`（commit-tree 产物） | 整轮工作区 diff 审阅（含 bash 等无边界改动的兜底）、隔离 worker 的增量搬运（`apply`） | 整轮回滚走 git restore；共享/分支移动/事后被改 → 拒绝 |

两层并存的目的不同：条目层回答「这几行是不是本会话写的」，回合层回答「这一轮工作区实际发生了什么」。**cleanup/清理路径比 review UI 更严**（`verified_worker_delta`，checkpoint.rs:800——无法重建归属的增量宁可不删）。

### 1.2 Manifest 字段语义（checkpoint.rs:500-528）

```
cwd                      会话工作区根；cwd 变了整个 checkpoint 目录作废重建
files: {rel → SnapshotKind}   编辑【前】的快照（Contents/Missing/Skipped）
after: {rel → SnapshotKind}   本会话最近一次编辑【后】的工作区内容
touched                  本会话声称动过的全部路径（prepare 或 capture 都算）
tracked                  在 HEAD 里存在过的路径（区分「新文件」与「改旧文件」）
prepared                 有编辑前真实边界的路径 —— 只有这些 undoable
diverged                 本会话两次编辑之间内容变过 → 第三方并发写入 → 行数归属不再 exact
stats: {rel → ±行数}      before/after 对稳定行数（diverged 后置 exact=false）
```

对外每文件两个布尔：`exact`（行数能否精确重建）与 `undoable`（是否有安全的事前快照）。

### 1.3 触发时机（前端驱动，App.tsx:13712 `trackSessionEdits`）

```
tool.started / tool.updated 且是编辑类（isEditTool(kind,title,preview)）
  ├─ 未完成态 → prepare(paths)   # 编辑前抓 before 快照，登记 prepared
  └─ completed/success → capture(paths)  # 抓 after + stats + touched；发现 after≠工作区现值 → diverged
turn 边界 → begin_turn(id) / finish_turn(id)   # git 层：capture_workspace 两次 + diff
```

prepare/capture 按会话排队串行（`enqueueCheckpoint`）。**先 prepare 后 capture 的顺序就是"安全 undo 边界"的来源**；只有 capture 没配到 prepare 的（比如上一版程序漏了、或 bash 改的）——"retained for review but deliberately not undoable"（checkpoint.rs:172）。

### 1.4 git 捕获不碰用户状态（turn.rs:641 `capture_workspace`）

- 临时 `GIT_INDEX_FILE=<os tmp>/<项目名>-checkpoint-<uuid>`：`read-tree HEAD` → `add -A` → `write-tree` → `commit-tree` → `update-ref`。**用户的 index、stash、分支全程不动**（undo 注释同调："The user's Git index is never reset"）。
- `-c core.fsync=objects,reference` 强制落盘，快照必须比 app 活得久。
- sparse checkout 仓库直接拒绝（add -A 语义会被破坏）。
- refs 挂在用户仓库对象库里白嫖去重与打包；会话删除时 `forget_turns` 按前缀 `for-each-ref` 统一 `update-ref -d`。

### 1.5 回合审阅与 Undo 资格（turn.rs:442 `undo_turn`）

`RecordedTurn { id, before, after, head, shared, dismissed, edited }`：

- `edited` = 本会话成功结构化编辑工具**上报**的路径集；共享快照只对这些文件出卡片（"Shared reviews require successful edit evidence for each displayed file"——turn.rs:1 头注释）。
- `shared` = begin_turn 时扫描同仓库其他活跃会话的 turn（`active_turns`），有重叠即置真：diff 照录（exact），**Undo 永久不可用**。
- `head` 记录了 turn 开始时 HEAD：finish 前分支动过 → 拒绝整合/回滚。
- 恢复资格三连：非 shared ∧ HEAD 未动 ∧ 每个被恢复文件当前内容 == 记录的 after（`restorable`）；任一失败整体拒绝，不做部分恢复。恢复用 `git restore --source <before> --worktree -- <file>`，before 为 Missing 的新文件直接删。
- **崩溃恢复语义**：begin 已发、finish 没发（reload/崩溃）→ 下个 begin_turn 检测 pending，先 finish 原边界再继续（turn.rs:80）；老版本产生的孤儿 turn 走 `recover_orphaned_turn`：从 transcript 确认的编辑路径重建审阅，但 `head=None, shared=true`——**恢复出来的记录永远只读不 Undo**。
- dismiss/keep：用户看过卡片点掉（dismissed 集）；`keep` = 接受本轮改动、留档历史。

### 1.6 隔离 worker 的增量搬运（`apply`，checkpoint.rs:215）

编排 worker 在独立 worktree 跑，收尾把「本 worker 的净改动」搬回 lead checkout：要求 worker/lead 的 HEAD 同一个 commit；逐文件预检（目标已是 after → 计 already_applied，幂等重试；目标既非 before 也非 after → lead 动过，整体拒绝并保留 worker worktree 人工审）；符号链接路径直接拒绝。`cleanup_safe` 用同一 verified delta 判断 worktree 是否可安全删除。

---

## 2. kova 的落地设计

### 2.0 架构差异与一个关键简化

参考实现 的事件流是「provider 进程 → Rust → 前端」，前端观察 tool 事件再回调 checkpoint，边界靠事件语义推断。kova 的 **write/edit 工具 execute 就在 sidecar 进程里**（`src/tools/tools.ts:417` 起的自建 Write/Edit，`AgentTool.execute` 全可控），所以：

- 条目层的 prepare/capture 直接包在 execute 前后——路径来自工具参数，**边界天然精确，不需要从事件猜**，比 参考实现 更可靠也更简单。
- git 层保留，但只用于**回合审阅与 bash 兜底**；**恢复源统一用条目层 shadow copy**（非 git 仓库同样可用），git 层不做文件恢复。取舍写死：bash 改过的文件无事前快照 → 只审不 undo（与 参考实现 "deliberately not undoable" 同一语义，但少一条 git restore 恢复路径要维护）。

### 2.1 模块与目录

```
apps/sidecar/pi-agent/src/checkpoint/
  index.ts        # 协议注册 + 对外命令
  store.ts        # 条目层：manifest + shadow blobs（非 git 仓库的唯一层）
  turn.ts         # 回合层：git 私有索引捕获 + diff + shared 检测（git 仓库才有）
apps/electron/main/checkpoint-ipc.ts   # 主进程转发 + 目录托管（PI_CHECKPOINT_DIR 覆盖，测试用）
```

存储：`<app_data>/checkpoints/<threadId>/{manifest.json, files/before/<rel>, files/after/<rel>, turns/<turnId>.json}`；git 层 refs 挂用户仓库：`refs/kova/checkpoints/<threadId>/<turnId>/{before,after}`。manifest 写用 `automation/json-file.ts` 的原子写 + .bak 自愈。字段语义直接搬 §1.2 的 manifest + RecordedTurn，一个不落（`prepared/diverged/exact/undoable/shared/head/edited/dismissed` 是这套设计的正确性骨架）。

### 2.2 挂钩点

| 时机 | 位置 | 动作 |
|---|---|---|
| 会话启动 | `sessions/sessions.ts` run 初始化 | `ensure(threadId,cwd)`：git 基线 diff 预快照（上限 500 文件，对齐 参考实现）；cwd 变更 → 整目录重建 |
| 回合开始/结束 | sidecar 的 agent loop 回合边界（与 appMode 热替换同层的 hook，落地时定位 `protocol.ts`/`sessions` 的 turn start/finish 点） | `begin_turn` / `finish_turn`（含 pending 恢复，§1.5） |
| Write/Edit 执行 | `tools/tools.ts` 各编辑 execute 包装器 | 入口 `prepare(paths)` → 真 execute → 成功 `capture(paths)`；失败不 capture（改动可能半途，保守留 diverged） |
| MultiEdit/批量 | 同工具参数里的全路径集 | 一次 prepare/capture（对应 HarnessEvent `paths[]` 多文件语义） |
| 会话删除 | thread 删除路径 | `forget`：删目录 + `for-each-ref` 前缀清 refs |

并发：sidecar 单进程，per-thread promise 队列串行（`subagent/memory.ts:26-30` 已有同款纪律）。

### 2.3 协议消息（`protocol.ts` 清单追加）

```
checkpoint_status  { threadId, turnId? } → { files:[{rel,status,additions,deletions,exact,undoable}] }
checkpoint_diff    { threadId, turnId?, rel } → { original, current, binary, tooLarge }
checkpoint_undo    { threadId, turnId, rel? } → { status } | 明确拒绝原因（shared/branch moved/file changed after）
checkpoint_keep    { threadId, turnId, rel? } → { status }        # 接受改动，卡片收起
事件：turn 结束时随 transcript 附本轮 changeSummary（回合卡片数据源，前端不必再拉）
```

### 2.4 UI（apps/desktop）

- 回合结束在 transcript 该回合尾部出「本轮改动 N 文件 +M −K」卡片：展开逐文件 diff（original/current），每行按钮 [回滚此文件]；卡片头 [整轮回滚]（全 undoable 才出现，否则只 [审阅]）；[保留] 收起。
- 拒绝原因如实显示（"文件在快照后被其他会话/你改动过"），对齐 参考实现 的文案风格——**宁可少给一个 undo 按钮，不给错误的安全感**。

## 3. 分期

| 期 | 内容 | 触及 | 验收 |
|---|---|---|---|
| **P0 条目层最小可用** | store.ts（manifest+shadow）+ write/edit execute 包装 + `checkpoint_status/diff/undo(单文件)` + 回合卡片（数据源 stats） | sidecar 2 新文件、tools.ts、protocol、desktop 卡片组件 | 单文件回滚精确；bash 改动只审不 undo；非 git 目录可用；cwd 变更重建；上限 500 文件 |
| **P1 回合层** | turn.ts 私有索引捕获 + begin/finish + shared/head/edited 判定 + 整轮回滚（restore 仍走 shadow copy）+ keep/dismissed | +turn.ts、回合边界挂钩 | 并发两会话同仓库 → 双双 shared 只审；分支中途被用户切走 → 整轮拒绝；reload 打断 → 下轮 begin 先 finish 原边界 |
| **P2 卫生** | refs gc/会话删除清理、orphan turn 恢复（只读档）、fsync 落盘纪律、`cleanup_safe` 语义对接 worktree 生命周期（若做隔离 worker 再启用 `apply` 搬运） | 同上 | kill -9 sidecar 重启后状态自洽；仓库里无僵尸 refs（脚本断言前缀计数） |

工作量估计：P0 ≈ 700 行（sidecar）+ 前端卡片；P1 ≈ +500；P2 ≈ +300。P0 独立可交付，先吃到 80% 用户价值。

## 4. 测试

- 表驱动单测（`PI_CHECKPOINT_DIR` 临时目录 + 临时 git 仓库 fixture，对齐现有 PI_*_DIR 纪律）：prepare→改→capture 的 undo 精确还原；无 prepare 的 capture 不可 undo；diverged 置 exact=false；新文件（before=Missing）undo=删除；同 cwd 换 thread 并发 shared；head 移动拒绝；begin 无 finish 的 pending 续档。
- 恢复资格断言写成「先验全部、后写任何」——中途失败不留半恢复（对齐 参考实现 apply 的 preflight）。
- 回归红线：checkpoint 目录异常（坏 manifest）时**工具照常执行**，快照失败只记日志降级（capture 全链路 catch，参考实现 前端 `void …catch(()=>undefined)` 同纪律——checkpoint 永远不能挡住干活）。

## 5. 刻意不做的

- 不做编辑器缓冲区级别 undo（那是 IDE 的事）；
- 不在 git 层做文件恢复（§2.0 的简化，恢复源唯一）；
- `apply` 增量搬运到 lead checkout：等 kova 有 worktree 隔离 worker 形态再上（P2 预留语义）。

---

## 6. 实施状态

**P0 + 条目所有权查询已落地**（2026-10，kova 侧）：

| 项 | 位置 | 说明 |
|---|---|---|
| sidecar 条目层 store | `apps/sidecar/pi-agent/src/checkpoint/store.ts` | manifest（per-turn 基线/after/ext/stats）+ 影子 blob + 2MiB 上限 + 24 轮裁剪 + symlink 门 + 原子写 + per-session 串行队列；`PI_CHECKPOINT_DIR` 覆盖 |
| 工具包装 | `apps/sidecar/pi-agent/src/tools/tools.ts` hostTool write/edit 分支 | execute 前 prepare / 成功后 capture；轮键 = `activeTurns` 的 requestId（`registry.currentTurnOf`） |
| 协议 | `handlers/checkpoint.ts` + protocol.ts | `checkpoint_status / checkpoint_diff / checkpoint_undo`；`delete_session` 随葬清理 |
| 桌面 turnId 透传 | `pi-client-base`(sessionTurn) → `turn-checkpoints.begin(sid, turnId)` → `pi-checkpoints` 条目/桥 | 老条目无 turnId → 卡片自动退化 |
| 卡片逐文件回滚 | `components/agent-thread/checkpoint-card.tsx` + `lib/pi/pi-edits.ts` | 影子仓库 diff 行 × 所有权清单按 rel 匹配；仅 undoable 挂回滚钮；拒绝原因人话化（`turnEditUndoError`） |
| 测试 | `test/checkpoint/store.test.ts` 16 例 | undo 精确/新文件删除/无边界不可 undo/第三方拒回滚/ext 判 exact/跨轮基线/cwd 重建/超限 skipped/二进制统计未知/symlink/裁剪/forget/降级不抛 |
| 同工作区会话隔离（2026-11 补） | `sessions/registry.ts`(sharedTurns) + `handlers/checkpoint.ts` + `turn-checkpoints.settle` + `git_checkpoint_{diff,files}` 的 paths 作用域 | `noteActiveTurn` 发现同 cwd 并发轮次即给双方打 shared；shared 轮次结算时 diff 只限本会话 write/edit 上报的主根路径、禁整轮撤销；非 shared 轮次把结算刻文件清单定格进条目（`paths`），展开卡片/产物页签/审查视图只按它过滤——后续其它会话的改动不再混入 |

**相对计划的偏差（有意为之）**：
- 计划里"per-turn undo 复用影子仓库 git restore"改为 **sidecar 影子副本直写恢复**——回滚目标 = 该轮首次编辑前内容，Electron 侧零改动，且非 git 工作区同样可用。
- ext（diverged）检测放在 **prepare 侧**（agent 第二次编辑动手前比对旧 after）而非 capture 侧——capture 侧比对会把 agent 自己本轮的第二次写入误判为第三方改动（单测锁住）。
- 整轮撤销、refs 治理维持现状（影子仓库 LRU），未引入 `refs/kova/checkpoints`；shared 检测已按 §1.5 语义补齐（见上表）。整轮 patch 在结算刻显式存档（`snapshot`），后续展开/审查不再覆盖它——避免用户中途手改后"撤销"把新改动一起抹掉。
- 读取侧会话键统一为 `useMainSessionId()`（线程列表项 initialize 落定的 remoteId = sessionId）：新建会话的 `mainThreadId` 是 `__LOCALID_` 草稿 id，直接拿它读检查点 store / 查 sidecar 会永久 miss（卡片不出现、逐文件回滚失效），属于既有问题一并修正。

**未做（后续期）**：P1 的 begin/finish 双端回合键强绑定（现用 prompt reqId，语义已够）、`checkpoint_keep/dismissed` 卡片记账、worker worktree `apply` 搬运。

---

## 附录：其他「值得学习、改动不大」清单（按性价比排序）

| # | 借鉴点 | 参考实现 出处 | kova 落点 | 量级 |
|---|---|---|---|---|
| 1 | **配额墙事件**：`usage.limited {resetsAt}` —— provider 限流不是报错文案，是"重置倒计时"UI | `harness/core/types.ts` | sidecar 错误分类 → protocol 事件 → 输入框禁用+倒计时 | 小 |
| 2 | **后台让出提示**：`background.updated {tasks[]}` —— agent 让出回合但 runInBackground 任务在跑，UI 显示"还在忙"，跑完唤醒 | 同上；kova 已有 runInBackground/task_output，缺这条事件与状态 | agent loop 结束检查活体 task → 事件 + 侧栏转圈 | 小 |
| 3 | **回复媒介纪律**：长报告→artifact 文档卡、图表/对比→自包含 HTML 卡（含主题 CSS 变量、禁 100vh 约定），聊天正文只留结论 | `monoFiles.ts <artifact_rules>` | 纯系统提示词一段（kova artifacts 已存在） | 极小 |
| 4 | **reaction 回复**：用户只"收到/谢谢"时允许整条回复 `<reaction>👍</reaction>`，渲染贴回用户消息 | `monoFiles.ts <reaction_rules>` | 提示词一段 + 渲染一个特判 | 极小 |
| 5 | **草稿语义**：agent 给别的会话/给用户发消息可以先 `draft`——存而未发，人审后决定 | `docs/agent-access.md` sessions.draft | subagent 委派结果 / habit 汇报先落 draft 块 | 小 |
| 6 | **会话文件夹组织**：`folders.list/move` 侧栏分组，agent 自己会归置 | 同上 | 侧栏纯 UI + 一个元数据字段 | 小 |
| 7 | **记忆条目过期/归档/截断自整理/写时脱敏** | `control_cli.rs:107-240` | 已立项：`docs/agents/custom-agent-memory.md` P0 | 见彼文档 |
| 8 | **首条消息幂等键**：断线/重启后 Retry 拿同一命令回执，不重复建会话 | remote-access.md「Retry 持原 command ID」 | kova remote.ts 的 new_session+首消息合并为带 idempotency key 的命令 | 小 |
| 9 | **确定性分支名 + 元数据 journal**：worktree/分支创建崩溃后可凭名字找回归属 | `worktrees.rs:390`、删除 journal :527 | `apps/electron/main/git.ts` worktree 辅助 | 小 |
| 10 | **测试法**：假 provider/假依赖可执行 + 临时 loopback + 表驱动并发竞态测试，全离线 | remote-access.md「Verify」节 | 已有 vitest，补「假 git 仓库 + 杀进程恢复」类用例模板 | 小 |

> 共同原则（这才是"学习"而非"抄袭"的部分）：**边界诚实**——没把握的事只展示不承诺；**状态可恢复**——一切异步都有幂等键/回执/journal；**降级不阻塞**——辅助设施永远不能挡住主流程。
