# 工作模式 / 编码模式（Work / Code Mode）实施计划

> 需求基线（已确认）：
> 1. **入口**：设置 → 通用新增「工作模式」section（M1）；主界面快捷切换放 M2。
> 2. **控制 A · 提示词**：work 模式向系统提示词注入「非工程协作」附加段；code 模式保持现状（字节级不变）。事实源在 sidecar，仿 personalization 链路（kv + 活动会话热替换广播）。
> 3. **控制 B · git 管理**：work 模式隐藏 git 相关 UI（Git 页签 / header 分支 tag / composer 分支胶囊 / 检查点卡）；「审查」页签保留。
> 4. **控制 C · 消息渲染**：work 模式下消息列表工具行收敛为轻量摘要（不渲染行内输出展开，保留开面板动作）；code 模式现状不变。
> 5. 与已有的 agent/plan 会话模式（mode-picker 的权限维度）**正交**，互不影响。
>
> 对标基线（调研结论，2026-09）：
> - **TraeWork**（字节，TRAE SOLO 独立产品）：Work / Code / Design 三模式，界面左上角切换，应用级全局模式。官方定位——Work「面向非开发用户（产品/数据/运营），处理文档、数据、演示稿」；Code「聚焦编码、调试、代码库管理和 **Git 工作流**」。工具面板页签按模式不同：Work 无终端页签、用「任务摘要+参考信息」（成果视角）；Code 有终端页签、用「上下文+压缩」（过程视角）。
> - **Cascade（Windsurf/Devin）**：Code/Plan/Ask 是阶段·权限流派，与我们已有的 agent/plan 同构——证明两个维度正交可并存。
> - **Roo Code**：「模式 = roleDefinition 提示词 + 工具组白名单 + 文件限制」的最小抽象，跨会话持久。
> - 另查：扣子（空间 vs 扣子编程）同款二分做成两条产品线；腾讯 CodeBuddy 是 Chat/Craft 开发内分层，无人群二分；未找到名为 "WorkBuddy" 的产品。
> - **共识**：Work/Code 属「人群/任务域」二分，每个模式切三类东西——系统提示词、能力面（UI/工具显隐）、信息呈现（成果视角 vs 过程视角）；git 归 Code 模式。

---

## 进度（实施时回填）

- **M1：完成**（2026-09-20）。sidecar：`app-mode.ts`（kv `pi.app_mode` + workModePromptBlock）+ `composeModeSystemPrompt` 注入（个性化段之后）+ `get_app_mode`/`set_app_mode` 协议（set 时逐 running 会话重排系统提示词，set_personalization 同款）+ 启动闸门内 `initAppMode()`；AGENT_MODE_PROMPT 顺手导出供测试。前端：`lib/app-mode.ts` 镜像 store（localStorage `app.mode` 播种 → get_app_mode 水合 → 失败置 degraded 保留播种值）+ 设置→通用「工作模式」section（Select 两档，degraded 时 desc 标注）+ git 四处隐藏（tab-registry 过滤 git 页签 / header 分支 tag / composer 分支胶囊 / checkpoint-card 的 MessageCheckpoint+CheckpointTail 组件内收口）+ ToolRow compact（work 档不渲染 output/preview/expandedContent，保留开面板动作，ToolFallback 及全部专属行经单点覆盖）。验证：sidecar `tsc` 0 错、`bun test` 706/706（app-mode.test 6 条：kv 往返/损坏回落/字节级插入位置）；desktop `tsc` 0 错、`bun test` 135/135（app-mode.test 7 条：播种/水合覆盖/失败降级/非法响应/set 成败）；`next build` 通过。M3 的 GUI 走查与渲染截图视觉验收待做。
- **追加（主界面常驻切换，2026-09-20，反馈"太隐蔽"后从 M2 提前）**：新增 `agent-thread/app-mode-switch.tsx`（胶囊按钮 + 两选项下拉，形态对齐 mode-picker：图标/说明/当前勾选），挂 header「更多」按钮左侧（`!pageMode` 常驻，空会话也显示——应用级开关不随会话走）；设置 → 通用 section 保留，同一事实源。tsc 0 错、next build 通过。

---

| | work（工作） | code（编码，默认=现状） |
|---|---|---|
| 人群 | 产品/运营/数据/研究等非工程用户 | 开发工程师 |
| 系统提示词 | 核心段 + WORK_MODE_PROMPT 附加段（见下） | 核心段原样（字节级不变） |
| git UI | 隐藏：Git 页签、header 分支 tag、composer 分支胶囊、检查点卡 | 全部保留 |
| 消息工具行 | 轻量摘要（无行内输出展开），保留「开面板」 | 现状（可展开输出/diff 统计/面板直达） |
| agent/plan 会话模式、审批级别 | 不受影响，照常可用 | 同左 |

**WORK_MODE_PROMPT 起步文案**（sidecar 侧英文，与 SYSTEM_PROMPT_CORE 同风格；M1 落地后可迭代）：

```
You are operating in Work mode. The user is generally a non-engineer (product, operations, data, research). Optimize for finished deliverables - documents, spreadsheets, presentations, research summaries, and web artifacts - rather than code.
Where these instructions conflict with coding-specific defaults above, this mode's instructions take precedence.
Reply in plain language: avoid code jargon unless asked, and explain technical trade-offs simply.
Prefer producing complete artifacts (files, HTML reports) over chat-only answers. If a task touches code files, keep changes minimal and explain them in non-technical terms.
```

## 架构总览

```
┌────────────────────────── sidecar (Bun) ──────────────────────────┐
│ app-mode.ts (新)      APP_MODE_KV_KEY="pi.app_mode"；initAppMode()  │
│                        启动 kvGet 水合模块级 current；getAppMode/    │
│                        applyAppMode；workModePromptBlock()          │
│ modes.ts             composeModeSystemPrompt 增插 workModePrompt-   │
│                        Block()（personalization 段之后）             │
│ protocol.ts          get_app_mode / set_app_mode 两个 case；set 时  │
│                        仿 set_personalization 广播热替换活动会话      │
│ hostdb.ts            kv 通用（pi.app_mode 键），无 schema 改动       │
└───────────────────────────────────────────────────────────────────┘
                        ▲ piRequest（pi-bridge）
┌────────────────────────── desktop 前端 ───────────────────────────┐
│ lib/app-mode.ts (新)  useSyncExternalStore 镜像 store：             │
│                        localStorage "app.mode" 播种 → get_app_mode  │
│                        水合 → set_app_mode 写真值（pi-session-mode   │
│                        的"播种+拉真值"同款纪律）                     │
│ general-settings.tsx 「工作模式」section（Select 两档）              │
│ tab-registry.tsx     useVisiblePanelTabTypes：work 时滤掉 "git"     │
│ header.tsx           work 时隐藏分支 tag                            │
│ composer.tsx         work 时隐藏分支胶囊（含 checkout 入口）          │
│ assistant-message.tsx work 时不渲染 <MessageCheckpoint/>            │
│ tool-row.aui.tsx     ToolRow 内部消费 compact：output/preview 不渲染 │
└───────────────────────────────────────────────────────────────────┘
```

**单一事实源**：sidecar kv（`pi.app_mode`）是提示词与全局事实源；前端 store 只是响应式镜像（含 localStorage 缓存做断链播种）。这样桌面/远程网页多端读到同一份模式，UI 隐藏与提示词不会各说各话（对比：ui-prefs 的主题类偏好是有意 per-client 的，工作模式不是）。

## 里程碑

### M1 · sidecar：协议 + 提示词块（先做，前端可独立验收 UI 行为）

- `apps/sidecar/pi-agent/src/app-mode.ts`（新）：
  - `export type AppMode = "work" | "code"`；`APP_MODE_KV_KEY = "pi.app_mode"`
  - `initAppMode()`：`initPersonalization` 同款——启动 `kvGet` 反序列化，非法值回落 `"code"`；模块级 `current` + `getAppMode()`
  - `applyAppMode(mode)`：写 kv + 更新 current（返回生效值）
  - `workModePromptBlock()`：`current === "work"` 返回 WORK_MODE_PROMPT，否则空串（保持 code 模式字节级不变的既有纪律）
- `apps/sidecar/pi-agent/src/modes.ts`：`composeModeSystemPrompt` 数组中 `personalizationPromptBlock()` 之后插入 `workModePromptBlock()`（`.filter(Boolean)` 已有，空串自然剔除）；顶部注释同步更新组装顺序说明
- `apps/sidecar/pi-agent/src/protocol.ts`：
  - 新 case `get_app_mode` → `{ id, type: "app_mode", mode }`
  - 新 case `set_app_mode` → `applyAppMode(msg.mode)` 后，**逐 running 会话重排 systemPrompt**（protocol.ts:1670 set_personalization 同款循环，`composeModeSystemPrompt(run.mode, run.cwd, run.agent.state.model)`），再应答
  - 文件头部协议注释清单（:67 附近）补两行
- `apps/sidecar/pi-agent/src/index.ts`：启动序列挂 `initAppMode()`（挨着 `initPersonalization`）
- 测试（`app-mode.test.ts` + `modes.test.ts` 增补）：kv 往返、非法值回落、compose 含/不含 work 段（含「code 模式输出与旧版字节级一致」断言）、protocol 两个 case 的分发与广播副作用

### M1 · 前端：store + 设置页 + git 隐藏 + 工具行收敛

- `apps/desktop/lib/pi-bridge.ts`：补 `get_app_mode`/`set_app_mode` 请求与 `app_mode` 响应类型
- `apps/desktop/lib/app-mode.ts`（新）：
  - `useAppMode(): AppMode`（useSyncExternalStore）、`setAppMode(mode): Promise<void>`
  - 初始化：localStorage `"app.mode"` 播种 → `piRequest get_app_mode` 水合（与播种值不同则以 sidecar 为准并回写缓存）；请求失败（含旧版 sidecar 未知类型）静默保留播种值，并置 `hybrid=false` 标记供设置页提示
  - `setAppMode`：先发 `set_app_mode`，成功后更新本地 store + 写 localStorage 缓存；失败回弹旧值并 console.error
- `apps/desktop/components/settings/components/general-settings.tsx`：新增「工作模式」section（放在「提醒」之前，模式是全局行为开关应置顶）：SettingRow + Select 两档「编码（默认）/工作」，desc 说明两档差异；旧 sidecar 混合态时 desc 附「当前 sidecar 版本不支持，仅影响界面」
- `apps/desktop/components/agent-thread/agent-panel/tab-registry.tsx`：`useVisiblePanelTabTypes` 过滤条件加 `if (t === "git") return appMode === "code" && !!status`
- `apps/desktop/components/agent-thread/header.tsx`：分支 tag 渲染条件加 `appMode === "code"`
- `apps/desktop/components/agent-thread/composer.tsx`：分支胶囊（GitBranchPill 及其 checkout/打开 git 页签逻辑）`appMode === "code"` 才渲染
- `apps/desktop/components/agent-thread/assistant-message.tsx`：`<MessageCheckpoint />` 渲染条件加 `appMode === "code"`（数据链路不动，仅隐藏）
- `apps/desktop/components/assistant-ui/elements/tool-row.aui.tsx`：`ToolRow` 组件内部 `const compact = useAppMode() === "work"`；compact 时忽略 `output` / `preview`（行只剩摘要 + 开面板悬浮按钮/整行动作），`stats` 保留（±N 很小且是成果信息）；`expandedContent` 路径同样跳过。ToolFallback/各专属行都经 ToolRow 输出，单点收口即可全覆盖
- 测试：`lib/app-mode` 播种/水合/失败容错单测；root `tsc` + `bun test` 全绿；`next build` 通过

### M2 · 体验补齐（M1 验收后）

- 主界面快捷切换：`header.tsx`「更多」按钮左侧加 Briefcase/Code 两态小切换（DropdownMenu 复用 mode-picker 形态），与设置页同一 store
- 「已执行 N 步」聚合行（可选增强）：work 模式下连续工具分组（group-tool-*）折叠成单行汇总，点击展开明细
- 性能优化（可选）：work 模式下跳过 git status 轮询与 src-tauri 影子仓库检查点快照（当前先保留快照——中途切回 code 模式时卡片不缺档）
- 终端页签是否随 work 隐藏（对齐 TraeWork）：待定，见开放问题
- work 模式工具集收窄评估（如 bash/edit 白名单化）：本期明确不做，仅提示词软约束，视 M1 使用反馈再立项

### M3 · 验收

- 手工走查矩阵：work/code × 桌面/远程网页 × {新会话、运行中会话切模式、刷新后恢复、旧 sidecar}；检查提示词生效（让 agent 自述模式）、git UI 显隐、工具行形态、检查点卡
- 渲染截图视觉验收（visual-judge）

## 兼容与风险

| 风险 | 处理 |
|---|---|
| 旧版 sidecar 不认识 `*_app_mode` | piRequest 失败容错：前端 UI 照常切换，提示词维持默认 code；设置页 desc 标注「需升级 sidecar」。响应类型校验仿 pi-session-mode（非法值忽略） |
| 双事实源竞态（多客户端同时 set） | sidecar last-write-wins；启动 get 水合收敛；set 应答即真值回写 |
| 运行中会话切模式 | 广播热替换下一轮请求生效（set_personalization 同语义）；本轮已发出的上下文不回溯，符合预期 |
| work 模式下 agent 仍会跑 bash/edit | M1 仅提示词软约束（WORK_MODE_PROMPT 已含最小改动+通俗解释要求）；工具集硬收窄列入 M2 评估 |
| 历史消息在切到 work 后变摘要行 | 预期行为（store 驱动，全列表一致），不做按消息冻结 |

## 开放问题（不阻塞 M1）

1. 终端页签是否随 work 隐藏（TraeWork 藏了；我们终端是桌面端页签，用户手动用命令的场景仍在）——M2 定。
2. 「审查」页签 work 下是否强制走工具流水派生视图（当前决定：不动，GitReview 对文档类 diff 同样可用）。
3. WORK_MODE_PROMPT 文案与 work 模式下产物偏好（是否主动推荐生成 HTML 报告等）——用两轮后按反馈迭代。
