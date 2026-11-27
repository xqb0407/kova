---
name: kova-desktop-design
description: "Kova Desktop 界面设计与实现规范。创建、修改或审查 apps/desktop 的任何界面时使用，覆盖设计原则、构图、字体、颜色、组件、动效、无障碍与提交前检查。"
---

# 像 Kova 一样设计桌面界面

把每一次界面改动当成产品判断，而不是样式拼装：先明确用户此刻要完成什么，再决定信息层级，最后才选组件和颜色。交付的必须是能用的界面，不是设计说明、评分或过程日记。

## 产品与品牌语境

Kova 是本地优先的桌面 AI 工作台：会话、工作区、技能与插件、自动化、终端都在同一个窗口里。用户会长时间停留，界面必须安静、精确、可预期，像一件顺手的工具，而不是一个演示页。

品牌气质：克制、直接、可信、技术感。用清晰的结构和稳定的排版建立信任，不用装饰、渐变、发光或夸张动效制造存在感。

界面语言是中文优先：技术名词（Git、MCP、token、JSON）保留原文，其余文案写中文。

## 使用优先级

当要求冲突时，按此顺序保护：

1. 不破坏用户数据、正确性、可恢复性与现有功能。
2. 保留现有框架、目录结构、组件约定与构建方式，不引入并行设计系统。
3. 让用户当前的任务、状态和下一步操作一眼可见。
4. 维持全应用一致性：字体、颜色、间距、圆角、动效来自同一套 token。
5. 选择适合当前信息的构图，不套固定模板。
6. 最后才精修细节，且不得削弱层级。

## 与项目集成

- 本文只适用于 `apps/desktop`。`plugins/**`、`apps/sidecar/**` 有自己的界面约定，不套用本文。
- 设计变量唯一来源是 `apps/desktop/app/styles/globals.css`；基础组件在 `apps/desktop/components/ui/`。新增 token 必须同时写入 `:root`、`.dark` 与 `@theme inline`。
- 优先组合现有组件（Button、Input、Dialog、Tabs、DropdownMenu、Tooltip、Toast 等），不要为一次性需求再造一套控件。
- `app/dev-preview/**` 是开发期查看页，不属于产品界面，也不作为规范依据。
- 不引入第三方 UI 库、图标集、图表库或动效库；确需新增依赖时先征得同意。

## 四个阶段

### 1. 明确任务

改动前先回答：谁在什么场景下、要完成什么、失败时会发生什么。

- 这是主路径还是边角场景？主路径优先。
- 信息是常驻、按需展开，还是只在悬停时出现？
- 操作是否可逆？不可逆操作必须二次确认。
- 是否已有同类界面？先复用，再考虑新建。
- 空态、加载、错误、禁用、只读五种状态是否都想清楚？

不要为了「看起来更丰富」增加区块。删掉一个不承载信息的容器，永远比加一个更好。

### 2. 选择构图

先确定信息层级，再选布局：

- 主内容 + 辅助面板：主区独占视觉重量，辅助面板退后。
- 列表 + 详情：列表负责扫描，详情负责操作；不要让两边都像主界面。
- 表单：标签、控件、说明三段式；说明紧贴控件，不堆在页尾。
- 设置页：左侧导航 + 右侧分组；分组用标题分隔，不靠卡片套卡片。
- 对话：消息是主体，工具调用和状态是附属；附属信息不能比正文更抢眼。

构图检查：

- 第一屏能否看出「这是什么、我现在能做什么」。
- 同一层级的东西是否用同一种排版；不同层级是否有明显差异。
- 是否存在为了填满宽度而拉长的空区块。
- 缩小到 1280×800 时是否仍然成立。

### 3. 执行视觉系统

只使用本文「视觉系统」中的角色和 token。不要临时发明字号、颜色或圆角。

### 4. 私有审查循环

按「审查顺序」自查，修掉最高影响的问题，再看一遍。不要把审查过程输出给用户，除非用户要求。

## 视觉系统

### 画布与层级

- 窗口由侧栏、主区、右侧面板、终端坞组成；同一时间只允许一个区域成为视觉焦点。
- 主区内容默认上限 `--chat-width: 60rem`；整页内容上限 `--page-width: 80rem`。
- 面板之间用细线或留白分隔，不同时使用粗边框、阴影和底色三种手段。
- 层级靠排版、间距、底色区分；阴影只用于浮层（Popover、Dialog、Toast），不用于静态卡片。

### 颜色

只用语义 token，组件内禁止十六进制、`rgb()`、`oklch()` 字面量。

| 用途 | 类名 |
|---|---|
| 页面底色 | `bg-background` |
| 正文 | `text-foreground` |
| 次要文字 | `text-muted-foreground` |
| 卡片 / 弹层 | `bg-card` / `bg-popover` |
| 悬停 / 按下 / 选中 | `bg-hover` / `bg-active` / `bg-selected` |
| 边框 / 输入框 | `border-border` / `border-input` |
| 焦点环 | `ring-ring` / `outline-ring` |
| 危险 | `text-destructive` / `bg-destructive/10` |
| 代码块 | `bg-code-surface` |
| 输入卡 | `bg-[var(--composer-bg)]` |

规则：

- 设计以中性色为主。强调色只用于主操作、当前选中和焦点环，不用于装饰。
- 承载信息的文字必须是满色：禁止 `text-muted-foreground/40|50|60`。装饰性图标、分隔符可以淡化。
- 状态不能只靠颜色表达，必须同时有文字或图标。
- 强调色由 `lib/theme/palette.ts` 在运行时写入 `--primary/--ring`；不要再造第二套主题分支。
- 深浅色由 `html.dark` 控制（`lib/ui-prefs.ts`）。令牌已覆盖的场景不要手写 `dark:` 配色。
- 窗口材质（`html[data-window-effect]`）会覆盖 `--selected` 等变量；只要用 token 就会自动适配。

### 字体与节奏

界面字体 `--app-font-sans`（Geist Variable + 苹方 / 思源黑体 / 雅黑回退）；代码字体 `--app-font-mono`。中文回退含 400/500/600/700 真实字面，禁止 `font-light` / `font-thin`。

| 角色 | 用法 | 字号 / 行高 |
|---|---|---|
| 页面/分组标题 | 设置区块、面板标题，`font-semibold` | 16 / 24 |
| 行标题 | 设置项、列表主字段，`font-medium` | 14 / 20 |
| 正文（对话） | 消息、Markdown | 15 / 24 |
| 正文（界面） | 表单、说明段落 | 14 / 20 |
| 紧凑 UI / 提示 | 设置页说明、密集行、`Button sm` | 13 / 20 |
| 元信息 | 角标、时间戳、状态点 | 12 / 16 |
| 等宽元信息 | 路径、快捷键、纯数字 | 11 / 16 |

规则：

- 中文正文最小 12px；11px 只允许纯 Latin/数字/等宽文本；禁止 9px、10px。
- 设置页字段说明固定 13px/20px，不要用 12px。12px 只留给角标和时间戳。
- 行高用无单位比例（`leading-5`、`leading-relaxed`），禁止 `leading-[18px]` 这类固定像素行高。
- 数字类内容用 `tabular-nums`（计数、耗时、金额、文件大小、行号）。
- 大写英文标签用 `uppercase tracking-[0.05em]`，仅在少数技术元信息出现。
- 同一屏字重不超过 3 种；标题 600，正文 400/500。
- 段落说明用 `leading-relaxed`；不要用「小号灰字」硬塞密度，先改写文案。
- 长文本截断用 `line-clamp-2`，并提供 `title` 或详情入口回看全文。
- 正文行宽控制在约 60–75 字符（中文 35–40 字）。

### 间距、尺寸与圆角

- 4px 网格。面板 `p-3` / `p-4`，对话框 `p-6`。
- 控件高度：紧凑图标 24、工具栏次按钮 28、默认按钮/图标按钮 32、输入框 36、大按钮 36。
- 主要操作与图标按钮不小于 32px；28px 只允许工具栏次要控件，且与相邻控件间距 ≥8px。
- 基础圆角 `--radius: 0.625rem`（10px）：`rounded-lg` 10、`rounded-xl` 14、`rounded-2xl` 18。
- 同心圆角：内层圆角 = 外层圆角 − 内边距。
- 胶囊只用于角标、开关轨道、分段控件；不要同一类控件混用不同圆角。

### 细线与边框

- 禁止 `border-[0.5px]`、`border-b-[0.5]`。
- 下边框统一用自定义 `border-b`（读 `--hairline`：2x 屏 0.5px，1x 屏 1px）。
- 其他方向用 `border-[length:var(--hairline)]`。
- 全边框用 `border` 且显式给颜色（`border-border`）。
- 不要用边框修补弱层级；先调整间距和排版。

### 组件

**Button**

- 变体：`default`（一屏最多一个主操作）、`outline`、`secondary`、`ghost`、`destructive`、`link`。
- 尺寸：`default` 32 / `sm` 28 / `xs` 24 / `lg` 36 / `icon` 32 / `icon-sm` 28 / `icon-xs` 24 / `icon-lg` 36。
- 图标按钮必须有中文 `aria-label` + Tooltip + 可见 `focus-visible`。
- 异步操作：`disabled` + 保持宽度 + `Loader2Icon animate-spin` + `aria-busy`。
- 破坏性操作用 `AlertDialog` 二次确认，按钮写明对象与后果（「删除 3 个任务」）。

**表单**

- 必须 `Field` + `Label`，禁止只靠 placeholder 当标签。
- `Input` 高 36，占位符用满色 `text-muted-foreground`。
- 错误用 `aria-invalid` + 紧邻控件的错误文案；不能只靠红边。
- 提交按钮与输入框同高，或使用 `Button lg`。

**弹层**

- `Dialog`：`rounded-2xl`、`p-6`、默认 `max-w-sm`；长内容用大尺寸变体，不要在 Dialog 里再套 Dialog。
- `AlertDialog` 只做确认；标题一句话，正文说明后果。
- `Popover` / `DropdownMenu`：`rounded-xl`，条目高 32，组标题用 `DropdownMenuLabel`。
- `Tooltip` 只补充信息，不能承载唯一操作路径。

**状态**

- 成功/失败用 `toast`，文案包含结果对象与下一步。
- 加载用 `Skeleton` 或行内 `Loader2Icon`；超过 1s 的操作必须有进行中态。
- 空态 = 一句说明 + 一个主操作；错误态 = 原因 + 重试。
- 只读、禁用、无权限状态必须有明确视觉和文案。

**导航与容器**

- Tabs / 分段控件由父容器测量后统一驱动指示器，子项不各自做背景动画。
- 侧栏、面板、终端坞的尺寸变化只在容器层过渡。
- 滚动条使用全局细滚动条样式，不自造外观。

### 动效

默认为静止。动效只用于解释状态变化、保持连续性或确认操作。

| 类型 | 时长 |
|---|---|
| 微反馈（hover / press / 颜色） | 100–150ms |
| 小组件（下拉、开关、展开） | 200ms |
| 面板、Tab 指示器 | 300–500ms |
| 复杂编排 | 子步骤拆分，单步不超过 500ms |

缓动统一来自 `lib/motion/ease.ts`：

- `EASE_OUT` `cubic-bezier(0.16, 1, 0.3, 1)`：进入、展开、位移。
- `EASE_IN_OUT` `cubic-bezier(0.77, 0, 0.175, 1)`：往返、循环。
- `EASE_DRAWER` `cubic-bezier(0.32, 0.72, 0, 1)`：抽屉、侧栏。
- 弹簧：`SPRING_PRESS` 500/30、`SPRING_SWAP` 460/30、`SPRING_PANEL` 420/40、`SPRING_LAYOUT` 360/32、`SPRING_MOUSE` 200/15、`SPRING_GLIDE` 700/50。

规则：

- 只动 `transform`、`opacity`、颜色。**禁止 `transition-all`**，必须写明属性列表。
- 禁止动画 `width/height/top/left/margin/padding`；唯一例外是已测量的 Tabs / 分段 / cron 指示器（见「已知例外」）。
- 过渡必须可中断；不要用长 keyframes 阻塞输入。
- 可点击元素必须有 hover、active、focus-visible 三态。
- 悬停才出现的操作必须同时支持 `group-focus-within:opacity-100` 或 `focus-visible:opacity-100`。
- 不要给正文按钮加 `scale` 按压，避免文字发虚；用颜色/透明度变化。
- 阻塞输入的动效必须提供取消路径。
- CSS 动效带 `motion-safe:` 或 `prefers-reduced-motion` 降级；framer 组件用 `useReducedMotion()`。

### 无障碍与键盘

- 焦点必须可见；禁止 `outline-none` 后不给替代。
- 键盘顺序 = 视觉顺序；弹层焦点进入/返回由基础组件处理，不要绕过。
- 自定义可点击容器：优先改成 `<button type="button">`；否则补 `role="button"` + `tabIndex={0}` + `onKeyDown`（Enter/Space），且内部不得嵌套可交互元素。
- 图标按钮、纯图标链接必须有中文 `aria-label`。
- 状态变化用 `aria-live` / `role="status"`；加载按钮用 `aria-busy`。
- 错误用 `aria-invalid` + `aria-describedby`。
- 满足 WCAG AA；文本对比度不低于 4.5:1，非文本不低于 3:1。

## 拒绝生成式设计反射

以下模式一律拒绝：

- 渐变文字、发光、光斑、条纹、噪点、玻璃拟态、装饰性阴影。
- 给每段内容套卡片，卡片里再套卡片。
- 用边框、色块、图标补齐本来就弱的层级。
- 装饰性图标、超大图标、混用多种图标风格。
- 12px 以下的说明文字、低透明度灰字、任意字号、同类控件字号不一致。
- 一屏多个主按钮、多个强调色。
- 自动播放的跑马灯、打字光标、循环脉冲状态灯、入场逐段揭示。
- 为了动画牺牲可读性：模糊、位移超过 8px、超过 500ms 的阻塞过渡。
- 装饰性图表、无意义的统计卡片、用插画代替空态说明。
- 英文 `aria-label`、只靠 placeholder 的表单、只靠颜色的状态。
- 在 `plugins/**` 或 `sidecar/**` 里套用本规范。

## 审查顺序

1. **第一眼**：这是什么页面、当前状态是什么、下一步能做什么，是否 3 秒内可见。
2. **构图**：主内容是否明确，是否存在意外空白或等权重的区块。
3. **排版**：字号角色是否一致，行高是否舒适，中文是否出现 12px 以下说明。
4. **状态**：空、加载、错误、禁用、只读是否齐全。
5. **克制**：删掉任何一个不承载信息的容器、图标、边框后，是否仍然成立；成立就删。
6. **主题与缩放**：浅色/深色层级是否等价；1280×800 与 150% 缩放下是否溢出。
7. **信任与可达**：语义元素、焦点、标签、快捷键、确认流程是否正确。

## 设计 API

颜色与尺寸 token：`background`、`foreground`、`card`、`popover`、`primary`、`secondary`、`muted`、`muted-foreground`、`accent`、`destructive`、`border`、`input`、`ring`、`hover`、`active`、`selected`、`code-surface`、`composer-bg`；`--radius`、`--hairline`、`--chat-width`、`--page-width`、`--chat-font-size`。

排版工具类：`text-2xs`（12/16）、`text-3xs`（11/16）；其余用 `text-base`、`text-sm`、`text-md leading-5`。

基础组件：`components/ui/button.tsx`、`input.tsx`、`dialog.tsx`、`alert-dialog.tsx`、`dropdown-menu.tsx`、`tabs.tsx`、`tooltip.tsx`、`toast.tsx`、`switch.tsx`、`select.tsx`、`field.tsx`、`label.tsx`。样式组合统一用 `cn()`，变体用 `cva`。

## 已知例外

| 例外 | 位置 | 原因 |
|---|---|---|
| 指示器动画 `left/top/width/height` | `ui/tabs.tsx`、`custom-ui/segmented.tsx`、`custom-ui/cron-editor.tsx` | 已测量的 500ms 指示器，改 transform 会压扁圆角 |
| `font-variation-settings` 写字重 | `ui/ask-user-questions.tsx` | 选中态字重平滑过渡 + 隐形副本预留宽度 |
| 输入框 16px、对话正文 15px | `ui/input.tsx`、composer | 历史遗留；新增输入不得引入第三种字号 |
| 暗色输入框仅靠填充表达边界 | `--input` 15% 白 | 对比度约 1.7:1，待统一提升 |
| 自动化运行记录行 `div onClick` | `automations/automations-view.tsx` | 键盘不可达，待改语义按钮（技术债） |

## 提交前检查清单

- [ ] 没有新增 `transition-all`、没有 9/10px 文本、没有 `leading-[Npx]`。
- [ ] 文字只用 `text-foreground` / `text-muted-foreground`，承载信息不压透明度。
- [ ] 图标按钮有中文 `aria-label` + Tooltip；主要控件 ≥32px。
- [ ] hover 才出现的操作在键盘聚焦时也可见。
- [ ] 新交互可用 Tab 到达、Enter/Space 触发、焦点可见。
- [ ] 动效有 `motion-safe` / reduced-motion 降级，时长 100–500ms。
- [ ] 圆角同心；细线用 `border-b` / `var(--hairline)`。
- [ ] 空、加载、错误、禁用、只读状态齐全；异步操作有 `aria-busy`。
- [ ] 文案中文、含结果对象；数字用 `tabular-nums`。
- [ ] 1280×800 与 150% 缩放无溢出。
- [ ] `bun run typecheck` 通过。
