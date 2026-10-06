# 工作流模式深度分析(自审计,v1)

> 定稿于 2026-10-06。方法:把 `workflow-mode` 分支的 11 个提交当**第三方代码**重审——以真机会话日志(dev 会话 `aafe073b` 的 workflow_state 行、sidecar 现场)与源码为准,逐条列出「已证实 / 未证实」的判断。与 `workflow-mode-design.md`(目标态设计)互补:那份写「要建成什么样」,这份写「现在离它多远、差在哪一行」。
>
> 一句话结论:**运行时骨架是真的**(真机日志证明并发执行、abort、resume 重放都工作),但三条对外承诺里有两条名不副实(重启恢复、后台进度送达),另有一批需要产品化前封掉的缺陷。

## 0. 结论摘要

| 层 | 状态 | 依据 |
|---|---|---|
| 提案 → 确认 → 执行 → 回投 主链路 | ✅ 真机验证 | 现场:两个 delegate 并发 running、resume 时 interrupted→pending→running 正确重放 |
| 内容寻址 journal 的**进程内**回放 | ✅ | resume 路径审计 + 单测(指纹含依赖链与 args) |
| 内容寻址 journal 的**重启后**回放 | ❌ 名不副实 | `readRunFile` **零调用点**:全量 journal 写进 `.kova/workflows/*.json` 后从不读回;转录行是瘦身的(无 results/fingerprint)→ 重启后 resume 全部重跑,且下游插值出 `<missing step result>` |
| 后台进度送达 UI | ❌ 渠道错 | 推进用 turn 作用域的 `sendEventChunk`(无活跃请求**静默丢弃**),而委派层早已用 turn 无关的通知行解决了同一问题;现场表现:条冻在「运行中 0/7」而 journal 里两步都在 running |
| 编排器行为一致性 | ⚠️ 概率性 | 三次提示词类事故(设计=聊设计、编排=自己干、确认=接管),每次靠收紧提示词收敛;缺评测集 |
| 与宿主集成(线程键) | ⚠️ 高危接缝 | Kova 的 threadId 双键制(`__LOCALID_` 草稿 id vs 会话 UUID,"本会话新建的线程 mainThreadId 恒为草稿 id");工作流每个产出面(chunk/轮询/请求)都要带对键 |

## 1. 分层审计

### 1.1 恢复层:三条承诺,一条成立(高危)

**承诺 A(成立)**:同一进程内暂停/恢复时,`done` 且指纹一致的步骤 0 token 回放。审计:runner 起点的指纹重算(`runner.ts` 指纹重算段)+ args 入种子,正确。

**承诺 B(不成立)**:进程重启后 resume 从 journal 回放。**证据:`readRunFile` 在整个 src 下零调用点**(只有定义,`journal.ts:49`)。事实链:
1. `commitWorkflow` 双写:转录行(`slimRunForTranscript` **剥掉 result 与 fingerprint**,`workflow.ts:110`) + 全量 run 文件(写了,没人读);
2. `restoreWorkflow`(重启/重新物化时)只读转录行 → 恢复出的 journal 有状态、**无结果、无指纹**;
3. 执行器起点发现 `entry.fingerprint === undefined` → 全部重置 pending → **全量重跑**;
4. 更糟的是下游插值:`resolveStepPrompt` 的 resolver 查 `run.steps[dep].result` → 无 → `<missing step result>` 混进 prompt。

严重度:**高**——这是"journaled resume"这个卖点的根,现在重启场景下它只是"重新跑一遍"。

**承诺 C(不成立)**:崩溃/断电后步骤级恢复。同因于 B;且 `restoreWorkflow` 与"槽位仍存活但 run 被驱逐"两种来源混用时,会用瘦身行**覆盖**内存里的活槽(见 1.4)。

**修法**:`restoreWorkflow` 增加 run 文件水合——从瘦身行拿 `runId`(与 sessions 行的 cwd),`readRunFile(cwd, runId)` 取全量 journal,按 `(key, status)` 合并:文件里有 result/fingerprint 就用文件的;文件缺失(换目录、被清理)时保持现状并在 statusLine 标注"历史结果不可用"。另:瘦身行建议保留 `fingerprint`(100 步 × 64B ≈ 8KB,值得),这样"步骤是否需要重跑"单凭转录即可判定。

### 1.2 交付层:进度走错了渠道(高危,已部分兜底)

**事实**:`sendEventChunk` 的契约是"该线程无活跃请求时**静默丢弃**"(`protocol/stream.ts:87`),设计给"轮内旁路"。工作流执行器是**轮外后台**,模型回合一结束,`activeReqByThread` 无该线程条目 → 后续每次步骤结算的推进 chunk 全部丢弃。现场证据:条上停在确认响应带去的 `运行中 0/7 步 0 token`,而同时刻 journal 里 `fetch-prices/fetch-news` 都是 running。

**对照**:委派层的 `subagent_activity` 是**无 id 通知行**(`send(...)`),注释明说"父 turn 已结束后台委派仍在跑也送达"——同行场景,已有正确先例。

**修法(结构性)**:工作流推进改为通知行(`{type:"workflow_activity", runId, ...}`)承载,前端在 Tauri 通道侧消费进 store;chunk 仅保留"轮内即时刷新"角色。短期兜底(已上,`2dad6d5`):运行中 2.5s 轮询 `get_workflow_state`——有效但把延迟与请求量都劣化了,且掩盖问题而非解决。

### 1.3 执行器正确性

- **[中] 启动竞态**:`startWorkflowExecution` 的去重守卫(`runner.ts:98-100`)是同步的,但 `executions.set` 在**一串 await 之后**(:170)。两个近同时的 kick(双击确认的第二个请求、确认+恢复)可双双穿过守卫 → 同一步骤被派发两次(双倍花费 + 双份副作用)。修法:守卫通过后**立即** `executions.set` 占位(占位对象中的字段先置 pending,后续填充),失败路径在 finally 删除。
- **[中] 无步骤超时**:`WorkflowStep` 没有 `timeoutMs`,delegate/synthesize/verify 的执行没有外层时限(provider 重试只治瞬时错误)。一个卡死的 provider 流或自旋的 agent 会让步骤永远 running,而停摆兜底只抓"就绪缺口",抓不到"挂起"。修法:步骤 schema 加 `timeoutMs`(默认取一个 run 级值,如 30min),用 AbortController + 定时器包裹 `executeStepWithRetries`;超时按可恢复失败计(进 retries/onFail 语义)。
- **[低] gate.args 的插值与注入**:工具 schema 承诺"args 里可用 {{step-key}} 占位符"(`tools.ts` gate.args 描述),**实现根本没做插值**——字面 `{{x}}` 会被当普通参数传给 shell(静默错误)。而修它时要当心:我拼命令用的是 `[command, ...args].join(" ")`(字符串拼接),一旦 args 支持插值,剧本参数(用户填/未来导入)就进入 shell 字符串——**参数注入**。修法:实现插值时**逐参数 shell 转义**(或改用 argv 数组通道),并在文档里写明 gate.args 的信任边界。
- **[低] foreach 子项文本里的占位符**:`expandForeach` 把上游行原文存进 `entry.item`,经 `resolveStepPrompt` 先替换 `{{item}}`、再替换 `{{key}}`/`{{args.x}}`。若某行文本自身含 `{{other}}`,会被二次插值(同 run 数据,风险低,但语义意外的 prompt 会进子代理)。修法:item 替换后对该段做占位符转义,或子项解析时只允许 `{{args.*}}`。
- **[低] 步骤级 `model` 在 gate 上被静默忽略**;`error: undefined` 显式写入 journal(序列化后无害,读回时可省)。schema 层面给 gate 拒绝 `model` 或文档写明无效。

### 1.4 槽位与生命周期

- **[中] `clearWorkflow` 零调用点**(死导出)。对照:`clearGoal` 在**驻留驱逐**路径被调用(`registry.ts:194`),而工作流槽什么都不清。后果:槽位随线程数单调增长,且**槽里带着全部步骤结果**(最坏 ~100×12k ≈ 1MB/run);被驱逐会话重新打开时 `restoreWorkflow` 又会用瘦身行覆盖或"复活"槽。修法:与 goal 对齐——驱逐/删除会话时清理;或改为"槽位是纯缓存,随 run 终态 + LRU 淘汰"。当前不对称本身就是设计债。
- **[中] 转录行按次提交**:每个步骤状态迁移都追加一行 `workflow_state`(running→done ≈ 2-4 行/步;百步 run ≈ 数百行 × 10KB 级),随会话历史每次加载都要扫。修法:只在**状态类迁移**(proposing/proposed/running/paused/终态)落行,步骤级细节交给 run 文件;或对行做节流。

### 1.5 宿主集成:线程键双制(架构性风险)

- 事实(Kova 既有规则,非本功能引入):"本会话新建的线程 `mainThreadId` 恒为 `__LOCALID_` 草稿 id,只有刷新恢复的线程两者同值"。同一会话的 threadId 会在 `rebindRunThread`(`resolve.ts:230`)处迁移,该函数是"刷新后键漂移的唯一正确落点",我已在那里挂了 `migrateWorkflow`。
- 现场证据:同一 run 的 workflow_state 行 threadId 先为会话 UUID、后为 `__LOCALID_twaED6D`——槽位确实经历了迁移,但**凡是没有走 rebind 的键漂移都会让产出面失联**:chunk 路由按 `run.threadId` 查活跃请求、轮询按 UI 的 `mainThreadId` 请求、`workflow_confirm` 按 `msg.threadId` 找槽——三者任一错位,症状都是"静默无反应"。
- 这不是工作流独有的 bug,而是**本功能把所有产出面都压在了一根脆弱的键上**。缓解(分层):
  1. 结构性:后台推进走通知行(1.2),不再依赖活跃请求;
  2. 槽位寻址:**以 `runId` 为主键**(UI 发 runId 而非 threadId),`threadId` 只作展示分组——工作流槽本就该是 run 级对象,而不是"线程的附件"。这是把 1.5 从"小心键"变成"无键可错"的根治项。
  3. 兜底:已上的轮询 + `get_workflow_state` 水合。

### 1.6 模型契约

- 三次事故全在"语义搬运"上:从 goal 抄「用户消息即接管」到执行器形态(错,已修 `2dad6d5`);「设计一个工作流」当聊设计(错,已修 `60dc8ca`);「编排工作流」当"你去干"(错,靠 bash 只读守卫 + 提示词兜,已修 `ff97160`)。规律:**每一次都是把相邻模式的直觉直接搬过来,而不是从本模式的执行模型重新推导**。
- 缺评测集:pi-dw 为同类问题造了 comprehension harness(给模型真契约、测它产出的剧本是否合法/可用)。Kova 现在只有"提案校验"这一个结构性兜底(有效:现场模型被拒后自修重提,但每次拒=一轮花费)。
- 建议:①把三份"提示词事故"固化成 3-5 个 comprehension 场景(设计请求/歧义请求/插话请求/追问进度),接进发布前手测清单;②编排档的"支持模型"分级(flash 档的指令遵循波动大,产品上要么建议更强模型,要么把校验拒绝率作为观测指标)。

## 2. 缺陷清单(按严重度)

| # | 级别 | 缺陷 | 证据 | 修法 |
|---|---|---|---|---|
| 1 | 高 | 重启后 resume 不成立:run 文件写了不读 | `readRunFile` 零调用点 | restore 时从 run 文件水合 results+fingerprint |
| 2 | 高 | 后台进度 chunk 静默丢弃,UI 冻结 | `stream.ts:87` + 现场 | 改通知行承载(对齐 subagent_activity) |
| 3 | 中 | 执行器启动竞态(守卫与占位之间有 await) | `runner.ts:98` vs `:170` | 守卫通过即同步占位 |
| 4 | 中 | 无步骤超时,挂起步骤让 run 永远 running | 全文件无 timeout | 步骤 timeoutMs + AbortController |
| 5 | 中 | `clearWorkflow` 死导出,槽位不清 | 零调用点 vs `registry.ts:194` 的 clearGoal | 驱逐/删除对齐 goal |
| 6 | 中 | 转录行按次提交,历史膨胀 | `workflow.ts:96` | 只在状态类迁移落行 |
| 7 | 低 | gate.args 插值没实现(schema 撒谎);实现时须防注入 | `tools.ts` gate.args 描述 vs `runner.ts` 拼接 | 逐参转义或 argv 通道 |
| 8 | 低 | foreach item 二次插值 | `resolveStepPrompt` 顺序 | item 段转义 |
| 9 | 低 | gate 的 model 被静默忽略;`error: undefined` 写入 | plan-state / runner | 校验层拒绝或文档写明 |
| 10 | 架构 | 产出面全押 threadId 单键(双键制下易失联) | 1.5 现场 | 槽位寻址改 runId 为主键 |

## 3. 产品化验收线(可检查的)

**发布前必须(A 级)**:
1. 重启恢复演练:跑到中途 kill sidecar → 重启 → resume → 断言:已完成步骤不重跑、下游插值无 `<missing …>`。**这是缺陷 1 的验收。**
2. 后台可见性演练:确认后**关闭聊天窗/切到别的线程**再回来 → 条与运行卡显示真实推进(并发数、完成数);期间不依赖任何轮内请求。**缺陷 2。**
3. 挂起演练:注入一个 hang 的 delegate → 步骤在 timeout 内转为失败/可恢复,run 不以"永远 running"结束。**缺陷 4。**
4. 双触发演练:对确认/恢复各双击一次 → 无重复派发(日志中同一步骤只有一个 delegationId)。**缺陷 3。**
5. 陌生同事走通:未读文档的同事独立完成「提需求 → 确认 → 拿报告」,中途不求助。**模型契约与可见性的综合验收。**

**可随迭代(B 级)**:失败步骤单点重试按钮;确认卡上的成本/时长预估;剧本文本里的 gate 命令在设置页可见可核;运行历史的筛选。

## 4. 建议的迭代顺序(下一轮起)

1. **恢复真相**:缺陷 1(约 1 个迭代)——它决定"journaled resume"是功能还是演示。
2. **后台送达**:缺陷 2(通知行通道)——顺带解决轮询的劣化。
3. **执行器加固**:缺陷 3+4+5+6(都是小改,一批做完)。
4. **安全与边角**:缺陷 7+8+9。
5. **架构项**:缺陷 10(runId 主键)——放在 2 之后、有 A 级验收兜底时做,避免过早大改。
6. **模型评测**:comprehension 场景集——与 1-3 并行,不占主线。

repeat-until / 配额自动恢复继续压后:它们加的是**新能力**,而上面 1-4 修的是**已承诺能力的真实性**。承诺不真的功能,能力越多越像演示。
