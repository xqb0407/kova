# 改造方案：自定义 Agent 实例 + 条目化记忆（借鉴 MonoCode Monos）

> 范围：仅 kova-electron（apps/sidecar/pi-agent、apps/electron、apps/desktop、packages）。
> 不引入 MonoCode 的多 provider harness、/operator 全局控制 CLI；这两块另行立项。
> 参考实现：`/Users/herther/Downloads/monocode-main`（下文简称 Mono，引用其文件路径供对照）。

---

## 1. 目标与形态

**一句话**：在 kova 现有的「全局人格 + 文件级记忆 + 子代理 + 定时任务」四块能力之上，长出第五个一等产品——**可创建的 Agent 实例**：每个实例有自己的持久人格（SOUL）、条目化记忆（会过期、会归档、可自维护）、自己的习惯（habits，跑完向本体会话汇报），并且用户能像普通会话一样与它开**长驻对话**。

Mono 的完整形态见 `monocode-main/src-tauri/src/mono.rs:1-15`（目录合同）与 `src/features/monos/model/monoFiles.ts:333`（注入块）。本方案取其中 kova 缺的三件事：

1. **记忆条目语义**：条目级 add/replace/remove、日期戳、`until` 过期、满员自动归档、截断信息反哺提示词让 agent 自整理、写入脱敏。
2. **人格实例化 + 写权分层**：人格从全局单例变成每实例一份；agent 自改人格走 CAS，且只有长驻前台会话有写权，habit 运行只读。
3. **习惯归属 agent**：定时任务从"应用级"变成"某个人格的习惯"，结果回投它的会话，运行间回填上次战绩。

## 2. 现状盘点与差距

| 能力 | kova 现状 | 与 Mono 的差距 |
|---|---|---|
| 人格 | `agent/personalization.ts`：全局 `~/.kova/soul.md` + `rules.md`，实时读盘，注入点 `modes.ts:237`（`personalizationPromptBlock`），set 时全量热替换活动会话 | 单例；agent 不能自改；无 CAS；无"每次会话绑定不同人格"的概念 |
| 主记忆 | `agent/memory.ts`：global/workspace 双作用域、文件粒度 markdown、注入（`memoryPromptBlock`，逐文件 4K/整段 12K，`truncateMiddle`）+ `memory_search` 行检索；版本史 `.history/`、回收站 `.trash/`、append 盖时间戳 | 文件级而非**条目级**：没有单条 add/replace/remove、没有 `until` 过期、没有满员归档、截断行不告知 agent（agent 无从自整理）、写入不脱敏 |
| 子代理 | `subagent/`：YAML 定义三层发现（内置/系统/工作区/插件，`subagent-definitions.ts:4-11`）、能力五维「未声明即不可达」（`capabilities.ts:1-10`）、记忆三档 none/private/shared（`subagent/memory.ts`） | 子代理是**委派执行器**：无持久会话形态、无人格编辑面、private 记忆在 `<cwd>/.kova/agent-memory/`（工作区局部、无版本史、被定位为"中间产物不是用户资产"） |
| 自动化 | `automation/`：croner + tasks.json + 启动补跑 + 单实例锁 + 并发闸（`runtime.ts`），任务形状 `ScheduledTask`（`automation/index.ts:40-60`，含 `sessionId`、`toolPolicyProfile`、runHistory） | 任务是应用级资产：不归属任何人格、结果不回投某个"本体的聊天"、无 posted/quiet/failed 三态回填、无"沉默是对的答案"判定 |
| 协议 | `get/set_personalization`、`get/set_memory`、`new_session(mode/model/appMode/cwd)`（`protocol.ts:68,115-120`；`handlers/sessions.ts:109`） | 无 agent 实例 CRUD；会话不携带实例绑定 |

**架构判断**：不要新造一套"Mono"。kova 的子代理系统已经解决了实例最难的部分——三层发现、YAML schema、能力解析、缓存签名、reload 链路。本方案 = **给子代理定义体系增加一种新形态 `resident: true`（长驻代理）**，配一份实例作用域的用户资产目录；记忆条目语义则直接升级 `agent/memory.ts` 的工具面，两条线在"长驻会话"处汇合。

## 3. 数据设计

### 3.1 实例目录（新）

```
~/.kova/agents/<id>/            # PI_AGENTS_DIR 可覆盖（与 PI_MEMORY_DIR 同纪律，测试用）
  agent.yml                     # 实例元数据：复用 SubagentDefinition schema + 新字段（见 3.2）
  SOUL.md                       # 人格（对齐 Mono：与全局 personalization 分离，用户在设置页编辑，agent 经工具 CAS 改）
  RULES.md                      # 常驻指令
  MEMORY.md                     # 条目化主记忆（预算注入，见 3.4）
  memory/<topic>.md             # 主题笔记（按需读，不注入）
  memory/archive.md             # 溢出/过期条目（只进检索，不注入）
```

目录纪律照抄 Mono 的两条（`mono.rs:1-15,88`）：

- **身份文件不放仓库**：agent 对仓库有完整写权，人格放仓库里等于可被任何会话或 PR 改掉。
- **枚举制路径**：agent 侧工具只允许上述五类文件（不嵌套、不隐藏、不可逃逸目录）；程序内部写用旁写 + rename（kova 已有 `automation/json-file.ts` 的原子写模式可复用）。

工作区记忆（`<cwd>/.kova/memory`）保持现状不动——实例记忆与它是叠加关系：长驻会话同时注入两者，workspace 在前（更具体，沿用 `memoryPromptBlock` 的排序纪律）。

### 3.2 `agent.yml` schema（扩展 `SubagentDefinition`）

```yaml
id: release-bot            # 实例 id = 目录名
name: 发布管家
emoji: 🚢
resident: true             # 关键新字段：可开长驻会话（缺省 false = 仅作委派子代理）
description: 盯发布窗口和回归
model: { provider, model, thinkingLevel }   # 默认模型（沿用现有覆盖链）
projects:                  # 工作范围（Mono 的 monoProjectsBrief 对应物，可空）
  - path: /Users/x/repo-a
  - path: /Users/x/repo-b
capabilities: ...          # 沿用五维「未声明即不可达」
memory: private            # 长驻形态强制 private（实例目录），shared/none 仅对委派形态有效
```

发现层与遮蔽顺序沿用 `subagent-definitions.ts` 的三层设计，新增 `~/.kova/agents/` 为**用户层**（优先级最高，因为可写）；`resident: true` 的条目在设置页「智能体」页签出现「打开对话」入口，委派工具面（Task）同时可见——一个实例既能被委派，也能被聊天。

### 3.3 会话绑定

- `new_session` 增加可选 `agentId`（`handlers/sessions.ts:109` 同层解析）；会话元数据持久化 `agentId`，restore 时随 mode/model/cwd 一起水合（`handlers/sessions.ts:333` 的按需补记录路径要覆盖它）。
- 绑定后该会话的系统提示词**不再拼全局 `personalizationPromptBlock` 的人格段**，改拼实例段（见 4.1）；结构化字段（称呼、风格）仍取全局，实例 yml 有覆盖则优先。
- 非绑定会话行为字节级不变（缓存纪律，`personalization.ts:12`）。

### 3.4 条目化 MEMORY.md

格式（对现有文件兼容，无法解析的行按普通文本对待，只注入与检索、不参与条目操作）：

```markdown
- [2026-10-15 →2026-11-01] 11 月发布分支冻结，只走 hotfix (releases)
- [2026-10-01] 用户偏好中文回复
- [2026-09-20] ~~用户偏好中文回复~~ → 用户改要英文简报
```

规则与 Mono `control_cli.rs:107-240` 对齐：

| 动作 | 语义 |
|---|---|
| `memory_add {fact, topic?, until?, tags?}` | 追加一行日期戳条目；`topic` 存在时写主题文件（主文件只留索引需要时再说）；`until` 为 `YYYY-MM-DD`，加载时已过期 → 移入 archive.md |
| `memory_replace {find, fact}` | 按**子串唯一定位**一个条目，划掉旧文（保留划线行一轮）再追加新条目；多匹配/零匹配返回明确错误让 agent 重试 |
| `memory_remove {find}` | 删除定位到的条目（写错的才删）；删除前该条移入 archive.md 留痕 |
| `memory_search {query, since?}` | 跨 MEMORY.md + 主题 + archive 的行检索（复用 `scoreLine`）；`since` 为 `7d/24h/2w` 或日期，按条目日期过滤 |
| `memory_read {}` | 总览：主文件、注入预算用到多少、主题名清单 |

**预算与自整理**（对齐 `monoFiles.ts:195-322`）：主文件注入预算 = 前 200 行或 8KB（先到为准）；超预算不再 `truncateMiddle` 掐中间，而是**整行起丢尾**，并在注入块尾追加：

```
[12 more lines in MEMORY.md did not load; move older detail into topic files or prune.]
```

——让 agent 知道该整理自己的记忆了。程序侧兜底：MEMORY.md 超过硬上限（如 400 行）时，最老条目自动搬 archive.md（对齐 Mono「Oldest entries move to the archive when MEMORY.md is full」）。

**写入脱敏**：`memory_add` 落盘前跑 secret 正则集（`sk-`、AKIA、`ghp_`、PEM 头、`Bearer `…），命中则拒写并提示。对齐 Mono `<memory_rules>` 末句「Never save secrets… they are redacted anyway」。

## 4. 注入与协议改造

### 4.1 注入块合成（`modes.ts composeModeSystemPrompt` 新分支）

绑定 `agentId` 的会话，段序改为：

```
静态核心 → 模式段 → 【实例段】agentRulesBlock(agentDir) → 记忆段（实例 MEMORY.md + workspace/global 主记忆，沿用现预算） → cwd 行 → 环境段
```

`agentRulesBlock` 的内容直接借 Mono `monoContext` 的写法（`monoFiles.ts:333-360`），逐段对应：

- `<identity>`：你是谁 + 工作范围（`monoProjectsBrief` 的中文改写，projects 来自 agent.yml）。
- `<soul>`：SOUL.md 全文（预算沿用 `PERSONA_MAX_CHARS` 4K），附**自改流程规则**：只在用户明确要求时改；先 `soul_read` 拿全文+hash，保留其余内容合入修改，再 `soul_update {text, expectedHash}`；文件变了重读重放；habit 运行与其他会话永远不能改 soul。
- `<memory_rules>`：3.4 的动作清单与"主动保存、别等着被要求""条目一行一个事实"纪律。
- `<habits_rules>`：见 4.3。
- 记忆正文 `<memory>` 块：预算截断 + 主题名目录行。

**hash 门控**：实例段与记忆段各自带内容 hash，记录到会话的 run 状态里（对齐 Mono `Handed { soulHash, memoryHash }`）。现热替换链路（protocol 层重建活动会话系统提示词）改为**只重建该 agent 的会话**且内容真变了才重建——避免每次记忆写入引爆全量热替换，守住缓存纪律。

### 4.2 工具面（绑定会话才注册，条件注册纪律沿用 `memory.ts:745-758` 双闸模式）

| 工具 | 参数 | 门控 |
|---|---|---|
| `agent_memory_add / replace / remove / read / search` | 见 3.4 | 实例目录；execute 内实时校验会话仍绑定 |
| `soul_read {}` / `soul_update {text, expectedHash}` | CAS | 仅长驻前台会话；`residentRun: false` |
| `habits_add / update / run / remove` | 见 4.3 | 描述里写明"先向用户建议、同意后才加"（Mono `<habits_rules>` 纪律）|

### 4.3 习惯（habits）= 带 `agentId` 的自动化任务

**不另起存储**：给 `ScheduledTask`（`automation/index.ts:40-60`）增加可选 `agentId`、`lastOutcome?: "posted" | "quiet" | "failed"`。复用 croner、补跑、单实例锁、并发闸、`toolPolicyProfile`。`habits_*` 工具是对 `automation/` mgmt 通道的实例作用域封装。

运行形态对齐 Mono：

1. 每次触发开**隐藏会话**（现有 runner 已会建 run session），首条消息用 `<habit_run>` 模板（借 `monoHabits.ts:353-375`），要点：告知"用户不会看到这次运行"；回填 `lastRunAt` + 上次 `lastOutcome` 的一句话（"上次没发现值得说的"/"上次未能完成"）；要求**最终回复要么是一条用户想看的汇报，要么恰好是 `QUIET` 标记**；"回复前先用 memory 工具保存值得记住的事"。
2. 结果判定：末段匹配 QUIET（容忍先絮叨后宣布沉默的截尾逻辑，`monoHabits.ts:377`）→ `quiet` 不发；有正文 → `posted`，作为一条带 habit 标记的**内部块**写入该 agent 的长驻会话 transcript（会话开着则实时投、关着则落 transcript 待恢复）。
3. 本体苏醒注入：agent 长驻会话收到用户新消息时，若上次用户消息之后有 habit 发帖，注入 `<while_you_were_away>` 摘要块（时间 + habit 名 + 600 字截断，对齐 `monoHabits.ts:388-402`），规则一句"用户已看到，别复述、接着干"。
4. `failed` 写 runHistory（现有），下一次运行提示词可见；连败 N 次（如 3）自动 disable 并在 agent 会话投一条系统提示。

### 4.4 协议消息（`protocol.ts` 清单追加）

```
list_agents / create_agent / update_agent / delete_agent     （仿 subagents mgmt handlers）
get_agent_files {agentId} / set_agent_file {agentId, file, text, expectedHash?}
new_session / session 元数据 + agentId
automation 载荷 + agentId、lastOutcome
```

## 5. 前端（apps/desktop）

- **设置 → 智能体**：现有子代理页加「长驻」分区（resident=true）；实例详情页四个页签 = SOUL / 记忆（复用现有记忆页组件，作用域指向实例目录，条目级渲染 + archive 视图）/ 习惯（复用 automations-cards 页，过滤 agentId）/ 项目范围。
- **侧栏**：agent 实例出现为可展开入口，点击打开（或恢复）它的长驻会话；会话卡片带实例头像与名字。
- **transcript**：habit 发帖块特殊渲染（小图标 + habit 名 + 时间，用户可见、agent 侧是 internal 块）。
- 手机端（apps/mobile）：只做展示与发起，不做实例编辑。

## 6. 分期实施

| 期 | 内容 | 触及文件 | 验收 |
|---|---|---|---|
| **P0** | 记忆条目语义：add/replace/remove/find 定位、until 过期、满员归档、尾行截断 + 自整理提示、写入脱敏。作用于**现有 global/workspace 记忆**（先让主 agent 吃到红利） | `agent/memory.ts`（+工具三件套参数）、`subagent/memory.ts` 同步复用、对应测试 | 单条目 replace 幂等；过期条目不再注入；secret 正则集单测；默认提示词不变 |
| **P1** | 实例目录 + `resident` 定义 + mgmt 协议 + `new_session.agentId` + 注入分支（实例段/soul CAS 工具） | `subagent-definitions.ts`、`capabilities.ts`、`modes.ts`、`protocol.ts`、`handlers/{sessions,subagents}.ts`、新 `agents/` 模块 | 建实例→开对话→soul 外部编辑下轮生效→agent 经 CAS 改 soul（并发冲突返回预期文案）；非绑定会话字节级不变 |
| **P2** | 习惯绑 agent：`ScheduledTask.agentId/lastOutcome`、`<habit_run>` 模板、QUIET 判定、结果回投 transcript、`while_you_were_away` | `automation/{index,runtime,runner,tools}.ts`、transcript 块类型 | 一个 every-5-minutes habit：quiet 不刷屏、posted 投进会话、下次运行提示词带上次战绩；补跑与锁不回归 |
| **P3** | 设置页与侧栏 UI；archive/主题文件可视化 | `apps/desktop/app/*` | 视觉验收（visual gate） |
| P4（可选） | 回复媒介规则：reaction 单表情、长报告转 artifact 卡（kova 已有 artifacts，补提示词纪律即可） | `modes.ts` 段文案 | prompt 审读 |

依赖：P1 依赖 P0（实例记忆直接用条目化格式）；P2 依赖 P1（需要 agentId 会话回投目标）；P3 可与 P2 并行。

## 7. 测试策略

- 环境变量开闸：`PI_AGENTS_DIR`（同 `PI_IDENTITY_DIR`/`PI_MEMORY_DIR` 纪律），单测全部走临时目录。
- 条目化解析表驱动：兼容普通行、`find` 多义拒绝、过期搬运幂等（重复运行结果一致）、并发 append 队列串行（复用 `subagent/memory.ts:26-30` 的队列模式）。
- habit 判定：QUIET 的三种输入（纯标记/絮叨后标记/标记后又有正文）各自断言。
- 回归红线：未绑定会话与关闭记忆的会话，系统提示词快照逐字节不变（对齐现有缓存纪律测试）。

## 8. 风险与对策

1. **热替换风暴**：记忆写频繁 × 多实例多会话 → hash 门控（4.1）把重建收敛到"该实例 ∧ 内容真变"。
2. **habit 无人监督跑全工具**：每次运行独立会话 + 沿用 `toolPolicyProfile`；提示词纪律"只建议敢无人值守的习惯，说明会改动（push/评论/关闭）而非只查看"（Mono `<habits_rules>`）；连败自动停用兜底。
3. **agent 自我污染人格**：soul 只有前台长驻会话可改 + CAS + 用户在设置页随时看得到全文并覆写（覆写 = 版本号变化，agent 侧 CAS 自动失效）。
4. **条目化迁移**：旧 MEMORY.md 无条目格式的行按普通文本兼容，不做一次性改写；agent 后续自然把新事实按条目格式追加。
5. **两个记忆面并存**（实例 MEMORY.md vs workspace 记忆）：注入时明确标注来源头（`agent/<id>/MEMORY.md` vs `workspace/.kova/memory`），`<memory_rules>` 写清"关于'我'的事实进实例，关于'这个项目'的进 workspace"。

## 9. 附录：Mono 参考点位速查

| 主题 | 位置 |
|---|---|
| 实例目录合同与防篡改理由 | `monocode-main/src-tauri/src/mono.rs:1-15`、`resolve_file` :88 |
| 注入块全量写法（identity/soul/memory/habits/delegation） | `monocode-main/src/features/monos/model/monoFiles.ts:313-360` |
| 记忆动作语义 | `monocode-main/src-tauri/src/control_cli.rs:107-111,225-240` |
| 预算截断反哺提示 | `monocode-main/src/features/monos/model/monoFiles.ts:48,195` |
| habit_run 模板 / QUIET 判定 / while_you_were_away | `monocode-main/src/features/monos/model/monoHabits.ts:353-402` |
| 三态结果回填 | 同上 `:33-58`（Habit 类型） |
| 记忆写权 CAS | `mono.rs` `save` :272 + `monoFiles.ts <soul>` 块 |
