# 自动化（定时 Agent 任务）实施计划

> 需求基线（已确认）：
> 1. 执行形态：**每次触发新建独立会话**，结果留在该会话，可回看，不打断当前对话。
> 2. 创建方式：**表单界面创建 + 对话里让 agent 帮建 + 预置任务模板**，三种都要。
> 3. 错过补偿：**app 重开后合并补跑一次**（不逐次补）。
> 4. UI：**侧边栏"自动化"→ 主区整页管理视图**（任务卡片列表 + 新建弹窗 + 运行历史）。
>
> 技术基线：复用 pi 官方扩展 `pi-task-scheduler`（/Users/herther/Downloads/pi-master/packages/pi-task-scheduler）
> 的 PersistentTaskScheduler（内含 croner、文件锁、崩溃恢复、runHistory），以 **Mode 2（宿主控制）** 方式接入
> sidecar；不重写调度核心。

---

## 进度（实施时回填）

- **M1–M3：完成**。vendor 调度核心 + 装配/runner/补跑 + 协议与 agent 工具；管理页全套（卡片/编辑器/预览/历史跳转/⚡徽标/模板选择器）。
- **M4：完成**。
  - 4.1 系统通知点击直达会话：Rust `notify_show`（`src-tauri/src/notify.rs`，插件 JS 层无点击回调）→ `app://notification-click` → `lib/notify` → `lib/open-session` 总线 → Base `reload + switchToThread`；Rust 命令失败自动回落 JS 插件路径（不报错）。webhook 侧 automation.* 由事件注册表自动出现在下拉，无需额外工作。
  - 4.2 once 完成后卡片显示置灰"已完成"（区分手动暂停）；30 天 GC 在 `runtime.ts::onceTasksToPurge` 启动时执行。
  - 4.3 `maxConcurrentRuns: 2` / `maxTasks: 30` 本地扩展（`index.ts`，NOTICE.md 已记录）；排队显示 runHistory `queued` 条目，历史行显示"排队中"。
  - 4.4 快捷键 `openAutomations`（默认 ⌘⇧A，`lib/shortcuts.ts`），设置→快捷键页自动列出。
- **M5：程序化验证完成**——root `tsc` 0 错、`bun test` 624/624；sidecar `bun test` 547/547（automation 50/50）；`cargo check` 通过；`next build` 成功。GUI 交互走查与渲染截图视觉验收待 macOS 授予"辅助功能/屏幕录制"权限后补做。
- **追加（composer 风格配置行）**：编辑器"执行指令"下方改为工作目录/权限档/模型三枚 composer 同款胶囊（`ModelSelector` 复用、`toolPolicyProfile` 借 ModePicker 下拉形态、目录胶囊含最近/浏览/手动输入），全部受控于任务字段；不嵌真 ComposerPrimitive/ModePicker（那些绑当前会话草稿与会话偏好）。新任务目录默认预填当前工作区；模型 composite id 统一 `provider/model` 形态。
- **追加（侧边栏列表联动，2026-09-16）**：定时任务触发/结算后侧边栏会话列表原本不自动刷新（reload 只在用户动作处发生）。现 `automation_fired`/`automation_run_done` 帧经 `lib/automation-live::setAutomationFrameSync` 去抖 500ms 驱动 `aui.threads.reload()`（`base.tsx` 注册），新物化的定时会话免手动出现；⚡ 徽标仍在 done 帧记账 run→session 后挂上。
- **追加（功能补齐，对照参考产品，2026-09-16）**：编辑/立即运行/历史此前藏在卡片 ⋯ 菜单里，界面无可见入口。本轮：①TaskCard 头部直排 ▶立即运行 / ✎编辑 / 🕘历史展开按钮，⋯ 只留删除；②页面加「定时任务 | 运行记录」双 tab，运行记录页跨任务聚合 runHistory（`lib/automation-history.ts` 纯函数：flatten/按天分组/搜索过滤，配 6 条时区无关单测），条目点击跳回实际会话；③任务 tab 加搜索框（名称+指令）与状态下拉筛选（全部/启用中/已暂停/最近失败）；④批量管理模式：卡片勾选/全选、底部操作条批量启用/暂停/删除（删除两段式确认），循环复用现有单条命令，清单镜像自然收敛。root `tsc` 0 错、`bun test` 631/631。保持电脑唤醒开关与闲时任务未做（参考产品有，待排期）。
- **追加（live 反馈三修，2026-09-16）**：①暂停开关回弹——运行帧驱动的 `refreshAutomations` 陈旧清单应答晚于 `set_enabled` 落盘覆盖写结果；`lib/automations` 清单请求统一发单盖单调 seq，写应答抬升 barrier、更早发单的刷新应答按过期快照丢弃（配 2 条竞速回归单测）。②"Cannot update a component while rendering"警告——TaskCard 展开历史把 `refreshAutomations()` 写进 setState updater（渲染期 emit 冒泡到父组件），移出 updater。③定时会话点进去空白无 loading——根因是转录在 agent_end 才整体落盘、轮初无消费方也就无流登记：线程挂载时探一次 `list_running`，真在跑就重建在飞流登记，框架 resume 效果订阅登记库自动重挂实时流（Rust 重放缓冲补齐已产出 chunk）；turn 收尾事件顺手清理该会话的陈旧登记（避免下次点击空转 resume/重复倒灌）；历史拉取失败或"索引说有消息但首查为空"时延迟 400ms 重试一次并打 `[pi-history]` 日志进 web.log 便于回查。root `tsc` 0 错、`bun test` 634/634。③为机理修复+防御，请点开一个运行中的定时会话复测；若仍空白，web.log 的 `[pi-history]` 行可直接定位。

## 架构总览

```
┌────────────────────────── sidecar (Bun) ──────────────────────────┐
│ automation/                                                        │
│  ├ scheduler.ts        vendored PersistentTaskScheduler（适配 import）│
│  ├ stores.ts           vendored JsonScheduledTaskStore + FileLock    │
│  ├ tools.ts            vendored createSchedulerTools（适配 ctx 来源） │
│  ├ runner.ts  (新写)   任务→新会话→prompt-queue→agent 循环            │
│  ├ hooks.ts   (新写)   scheduler hooks → agent-events + 推送帧       │
│  └ templates.ts(新写)  预置模板静态定义                               │
│ protocol.ts: 6 个 automation_* 命令 + 2 个上行通知帧                  │
│ tools.ts: 注册 scheduler_* LLM 工具                                 │
└──────────────────────────────┬─────────────────────────────────────┘
                    Tauri invoke / WebSocket (pi-channel)
┌──────────────────────────────┴─────────────────────────────────────┐
│ lib/automations.ts          CRUD 客户端 + kv 映射(会话→任务) + 订阅    │
│ components/automations/*    管理页 / 卡片 / 编辑器 / 历史 / 模板库      │
│ clone-thread-shell.tsx      "自动化"菜单接线（现为占位，:235/:160）    │
│ base.tsx                    主区视图切换（对话 ⇄ 自动化）              │
│ thread-list.aui.tsx         自动化会话 ⚡ 徽标                        │
│ lib/agent-events.ts         automation.fired / completed / failed   │
└─────────────────────────────────────────────────────────────────────┘
```

存储：任务定义用上游自带 `JsonScheduledTaskStore`（原子写，文件放 sidecar 数据目录，与 sessions 同级）。
不新增 SQLite 表——生产库由 Rust 宿主持有，加列需双侧迁移，避免之。**"会话→自动化任务"映射存 kv**
（`automation.session-map`），供 UI 打徽标与筛选，规避 sessions 表 schema 变更。

## 数据契约

### ScheduledTask（上游类型，原样采用）
`{ id, prompt, name?, description?, type: 'cron'|'once'|'interval', schedule, intervalSeconds,
   enabled, model:{provider,model,thinkingLevel?}, workspaceDir?, timeoutMs?, runCount,
   lastStatus, nextRunAt, runHistory(≤25条, 每条含 scheduled-run sessionId) }`

与上游的三处刻意差异：
1. **scope 传 `{}`**（app 级资产），不按来源会话隔离；`workspaceDir` 仅作归组展示用。
2. **runner 新建会话**执行（上游是 sendUserMessage 回原会话）。
3. **补跑策略**：scheduler.start() 前扫描 store，`enabled && nextRunAt < now && now-nextRunAt < 一个周期`
   的任务合并补跑一次（runHistory 记 `catch-up run`），其余按上游"错过不补"。

### 协议命令（下行，仿 list_subagents 风格）
| 命令 | → 应答 |
|---|---|
| `automation_list {id}` | `automations {tasks, templates, status}` |
| `automation_save {id, task}` | `automations {...}`（create/update 合一，带 id 即 update） |
| `automation_delete {id, taskId}` | `automations {...}` |
| `automation_set_enabled {id, taskId, enabled}` | `automations {...}` |
| `automation_run_now {id, taskId}` | `automation_triggered {taskId}` |
| `automation_preview {id, type, schedule}` | `automation_previews {nextRunsIso: string[]}`（croner nextRuns(3)，编辑器实时预览用） |

### 上行通知帧（新增"无 id 请求应答"类别，pi-channel 需容忍未知 id 帧）
| 帧 | 前端行为 |
|---|---|
| `automation_fired {taskId, taskName, runSessionId, localThreadId?}` | 刷新任务列表 + 系统通知 + 注册会话映射；若该会话已挂载则附加 |
| `automation_run_done {taskId, runSessionId, status: 'success'|'error', error?}` | 完成通知（走既有 notify/webhook 管线）+ 列表刷新 |

## 无人值守审批策略（重要设计点）

定时会话没有人在键盘前，逐工具审批会把任务挂死。方案：automation 会话默认
**"需审批工具一律按任务创建时的授权档位执行"**——任务定义里 `toolPolicyProfile`
（上游字段，恰好存在）映射为三档：`read-only`（默认，安全）/ `workspace-write` / `full`；
sidecar 在 automation 会话上按档位自动放行或自动拒绝，**不弹审批**。UI 创建弹窗里放一个
"允许权限"三选下拉。档位校验放 runner 层，防 LLM 工具建任务时提权。

---

## M1 · 调度器进家（sidecar 地基）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| 1.1 | 引入 croner 依赖 | `sidecar/pi-agent/package.json` | bun install 通过 |
| 1.2 | **取最新公开源码**（`npm pack @amaster.ai/pi-task-scheduler`@0.1.15，勿用本地下载的 beta.15 旧拷贝）vendor 并适配 import：`ToolDefinition/ExtensionContext`（pi-coding-agent）→ sidecar 惯用的 `AgentTool`（pi-agent-core），typebox 同源已核实；文件头保留出处注释，`sidecar/pi-agent/src/automation/LICENSE-APACHE-2.0` + `NOTICE.md`（Apache-2.0 归属要求） | `sidecar/pi-agent/src/automation/{scheduler,stores,json-file,tools}.ts` | `bun run build:sidecar` 通过 |
| 1.3 | 移植上游 3 个测试文件（vitest→`bun test` 机械改写），跑绿 | `src/automation/__tests__/*` | 调度/存储/恢复语义回归有保障 |
| 1.4 | 装配：`index.ts` 启动时构造 scheduler（JSON store 路径进 sessions 同级数据目录，lock 同目录），stop 挂 exit；scope `{}` | `sidecar/pi-agent/src/index.ts` | smoke：起进程建一条 `interval 5s` 任务能连续触发 |
| 1.5 | **Rust 小改：sidecar 启动即拉起**。现状 `pi_agent.rs:146 ensure_spawned` 为懒启动（首次 pi_prompt/pi_request 才 spawn），app 开着没聊过天则调度器不存在。在 `lib.rs` setup 调一次 `ensure_spawned`（约 10 行）；scheduler JSON/lock 路径经 `resolve_app_data_dir` 以 env 下发（仿 `PI_SESSIONS_DIR`） | `src-tauri/src/lib.rs`、`pi_agent.rs` | 冷启动 app 后不发任何消息，5s interval 任务照样触发 |

## M2 · 触发回路（无头执行 + 事件）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| 2.1 | runner：ensureSession（title=任务名，登记 kv session-map）→ 注入系统提示"定时任务，勿反问，按合理假设完成" → `dispatchPrompt` 走现有队列；timeoutMs 用 AbortSignal 兜底；工具审批按 `toolPolicyProfile` 三档自动放行 | `automation/runner.ts`（新）+ prompt-queue 旁路入口 | 5s interval 任务真实跑完一轮，JSONL transcript 落盘可回放 |
| 2.2 | hooks：onTaskStarted/onTaskCompleted/onTaskFailed → ①协议通知帧（stdout/ws 广播，无 id）②`emitAgentEvent("automation.fired"/"automation.turn.done")` 接通知管线 | `automation/hooks.ts`（新）、`lib/agent-events.ts`、`lib/pi-channel.ts`、`lib/pi-ws-channel.ts`、`protocol.ts` | 任务触发瞬间前端列表状态变 `running` |
| 2.3 | 补跑：start() 前扫 missed nextRunAt，合并补跑 + runHistory 记录 | `automation/scheduler.ts`（薄封装）| 设 `once +1m` 后杀进程，重开观察到补跑一次 |
| 2.4 | LLM 工具注册 + `toolPolicyProfile` 写死 `read-only` 默认 | `tools.ts` | 对话里说"30秒后提醒我喝水"能建出任务并触发 |

## M3 · 管理界面（前端主体）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| 3.1 | 客户端库：CRUD 封装 + 列表缓存 + `onAutomationEvent(cb)` 订阅 + kv session-map 读写 | `lib/automations.ts`（新，仿 `lib/webhooks.ts`） | 类型完备，无 any |
| 3.2 | 菜单接线与视图切换："自动化"点击 → 主区整页 `AutomationsView`（activeMenu 升级为受控回调） | `clone-thread-shell.tsx:160,235`、`base.tsx` | 点菜单切页，再点对话区元素切回 |
| 3.3 | 任务卡片：名称/调度人话摘要/下次运行倒计时/上次状态点/runCount/启停/⋯菜单(立即运行·编辑·删除)；空态 + 新建按钮 + 模板入口 | `components/automations/*` | 两列响应式卡片栅格 |
| 3.4 | 创建/编辑弹窗：指令文本域、频率（每天/每周/每月预设 → 生成 cron；高级框直填表达式 + `automation_preview` 实时显示下 3 次触发时间）、工作区下拉（WorkspacePicker 同源）、允许权限三档、模型选择（默认跟随全局）、once 相对时间辅助（`+10m`） | `components/automations/task-dialog.tsx` | 非法 cron 红字提示；保存即时生效 |
| 3.5 | 运行历史：卡片展开最近 25 条（时间/状态/耗时），条目点击 → 打开对应会话 | 同上列表组件 | 能跳回 `scheduled-run-*` 会话看 transcript |
| 3.6 | 会话徽标：侧边栏 thread-list 行内 ⚡（kv session-map 匹配），点击 ⚡ 跳任务详情 | `thread-list.aui.tsx` | 自动化会话在"任务/项目"分组正常显示但带来源 |
| 3.7 | 模板库：4–6 个静态模板（每日晨报/每周周报/仓库每日巡检/定期竞品扫描），一键预填编辑弹窗 | `automation/templates.ts` + 前端选择器 | 模板列表来自 sidecar 应答 |

## M4 · 收尾体验

| # | 任务 | 验收 |
|---|---|---|
| 4.1 | 完成通知：Tauri 系统通知"『晨报』已完成 →"点击直达会话；复用 webhook 派发（automation.* 事件可订阅） | 断网渠道降级不报错 |
| 4.2 | once 任务：完成后置灰"已完成"，30 天 GC 删除（kv 计数即可） | 列表不堆积死任务 |
| 4.3 | 边界：系统时间回拨容忍（scheduler 只信 croner 轮询）；任务数上限 30；全局并发闸 2（超出排队，runHistory 记 `queued`）；同任务重入已由 runningTaskIds 保证 | 压测 5 任务同刻触发行为正确 |
| 4.4 | 设置页联动：webhook 事件下拉出现 automation.*；快捷键注册 `Cmd+Shift+A` 直达自动化页 | 与既有设置体系一致 |

## M5 · 测试与验收

- `bun test`（sidecar）：automation 全套（含移植用例 + 补跑/档位/三档审批新用例）
- `tsc` + `next build`；GUI 走查清单：建 cron 任务→预览时间对→到点自动新会话→徽标→历史跳转→补跑→通知
- 视觉验收：管理页渲染后逐页判（卡片栅格、弹窗、空态）

## 风险与既定取舍

1. **复用方式已拍板：Vendor（不进 npm 依赖）**。社区包 `@amaster.ai/pi-task-scheduler`（Apache-2.0，已发公开 npm，最新 0.1.15）的调度核心拷入我仓后即为自有代码，不受其 beta 节奏与 pi-coding-agent 版本耦合影响；NOTICE+许可证文件满足合规。上游后续更新按需手动 diff 合并（改动集中在 runner/hooks 挂载点，不动调度核心）。
2. **时区语义**：croner 按 sidecar 进程本地时区解释，DST 跳变时上游行为是"跳过/合并"该时刻；文档写明，不做 tz 字段（对齐 ChatGPT Tasks：跟随系统）。
3. **app 关闭不执行**（M2.3 补跑已缓解）；开机自启列 P2，用 `tauri-plugin-autostart` 静默启动。
4. **不碰 Rust 宿主 schema**：所有新持久化走 kv 与 JSON 文件，规避 src-tauri 状态库迁移；若未来要"按任务聚合运行会话"再评估 sessions 加列。Rust 侧唯一改动是 M1.5 的"启动即 spawn sidecar"（行为改动，非 schema）。
5. **P2 的 Rust 边界（本期不做，避免误以为已支持）**：①"存在启用任务时关窗→托盘常驻 / ⌘Q 确认"——否则用户退出 app 任务全停，"重开补跑"只覆盖合盖/崩溃场景；②关机也能跑：`tauri-plugin-autostart` 或 launchd 常驻 headless sidecar，工程量集中在 Rust；③kill_on_exit 打断运行中任务已有 running→error 恢复兜底，可选加"被打断自动重跑"。
6. **安全**：automation 默认 `read-only` 档位；`full` 档在 UI 上有黄条警示。定时任务 prompt 自包含 + "勿反问"注入，避免 question 工具挂起（runner 里对 automation 会话直接禁用 question 工具）。

## 里程碑顺序与依赖

M1 → M2（依赖 1.4）→ M3（依赖 2.2 的事件与命令，3.1 可与 M2 并行）→ M4 → M5。
M1/M2 全部在 sidecar，可先用 CLI smoke 验证完再开前端，UI 阶段无后端不确定性。
预计 M1–M2 为纯后端半天级；M3 为主体；全程不改 assistant-ui runtime 层（PiTransport 不感知自动化）。