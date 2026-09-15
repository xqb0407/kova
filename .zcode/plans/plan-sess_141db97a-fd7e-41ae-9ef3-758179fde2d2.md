# 自动化页功能补齐（对照参考图，功能优先）

## 现状结论
- 编辑、立即运行、运行历史、删除的**代码链路都已存在且已验证**（`components/automations/automations-view.tsx:207-247` 的 ⋯ 菜单 → `lib/automations.ts` → sidecar `automation_*` 命令），但全部折叠在「⋯ 更多操作」里，界面上没有可见入口，等于"没做"。
- 没有全局运行记录视图、没有搜索/筛选、没有批量管理——这三项按你确认的范围本次一起做。
- 不做：保持电脑唤醒开关、闲时任务、视觉精修（后续再调 UI）。

## 1. 卡片操作直接可见（automations-view.tsx · TaskCard）
- 卡片头部操作区改为直排图标按钮：**▶ 立即运行 / ✎ 编辑 / 🕘 历史**（展开-收起），⋯ 菜单只留「删除任务」。
- 全部复用现有 handler：run-now 保留"暂停任务先自动启用再触发"逻辑；运行中 ▶ 禁用并转 spinner（复用 `useAutomationRunning`）。
- 每个按钮带 aria-label + title 提示。

## 2. 全局运行记录页
- 页面顶部加 tab：**「定时任务 | 运行记录」**（参考图 2 形态，tab 用最简单的按钮组，样式后调）。
- 运行记录 tab：把所有任务的 `runHistory` 扁平化 → 按时间倒序 → 按天分组；每行显示任务名、状态图标（成功/失败/运行中/排队/暂停）、时刻、相对时间，点击跳回那次执行的实际会话（复用 `useAutomationSessionForRun` + 现有 `openSession`）。
- 聚合/分组/过滤逻辑抽成纯函数放 `lib/automation-history.ts`，配单测（时区无关，沿用 automation-format.test.ts 的本地 Date 构造写法）。

## 3. 搜索 / 筛选
- 任务 tab 工具栏加搜索框（按名称+指令文本，不区分大小写）+ 筛选下拉（全部/启用/已暂停/最近失败）。
- 运行记录 tab 的搜索框按任务名/状态过滤（参考图 2 的"搜索定时任务/记录"）。

## 4. 批量管理
- 工具栏「批量管理」按钮切换多选模式：卡片出现勾选框、支持全选、显示已选计数。
- 底部操作条：批量启用 / 批量暂停 / 批量删除（删除前显示数量确认）。
- 实现上循环调用现有 `setAutomationEnabled` / `deleteAutomation`（每次应答都带全量清单，镜像 store 自然收敛），完成后自动退出批量模式。

## 5. 验证与收尾
- `bunx tsc --noEmit` 0 错误 + `bun test` 全绿（含新增纯函数测试）。
- 不再用 computer-use；页面经 next dev HMR 热更，你手动点验编辑/立即运行/历史/记录/搜索/批量。
- 更新 `plans/automation-scheduled-tasks-plan.md` 进度块（记录"操作从 ⋯ 菜单提升为直排按钮"与新增视图）。