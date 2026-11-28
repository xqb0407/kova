---
name: Kova（扣瓦）
description: 本地优先的桌面 AI 工作台——安静、精确、可预期的工程感界面
colors:
  paper: "oklch(1 0 0)"
  ink: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  graphite-muted: "oklch(0.97 0 0)"
  pencil: "oklch(0.556 0 0)"
  hairline: "oklch(0.922 0 0)"
  primary-mono: "oklch(0.205 0 0)"
  focus-blue: "oklch(0.55 0.19 262)"
  danger: "oklch(0.577 0.245 27.325)"
  selected: "oklch(0.97 0 0)"
typography:
  body-chat:
    fontFamily: "Geist Variable, ui-sans-serif, PingFang SC, Noto Sans SC, Microsoft YaHei UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "24px"
    letterSpacing: "0em"
  body-ui:
    fontFamily: "Geist Variable, ui-sans-serif, PingFang SC, Noto Sans SC, Microsoft YaHei UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  title:
    fontFamily: "Geist Variable, ui-sans-serif, PingFang SC, Noto Sans SC, Microsoft YaHei UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  compact:
    fontFamily: "Geist Variable, ui-sans-serif, PingFang SC, Noto Sans SC, Microsoft YaHei UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  meta:
    fontFamily: "Geist Variable, ui-sans-serif, PingFang SC, Noto Sans SC, Microsoft YaHei UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  mono-meta:
    fontFamily: "Cascadia Mono, Menlo, JetBrains Mono, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  sm-nested: "6px"
  md-control: "8px"
  lg-panel: "10px"
  xl-popover: "14px"
  "2xl-dialog": "18px"
  capsule: "9999px"
spacing:
  "2xs": "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  "2xl": "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary-mono}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md-control}"
    height: "32px"
    padding: "0 12px"
  button-outline:
    backgroundColor: "{colors.graphite-muted}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md-control}"
    height: "32px"
    padding: "0 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md-control}"
    height: "32px"
    padding: "0 12px"
  button-destructive:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md-control}"
    height: "32px"
    padding: "0 12px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md-control}"
    height: "36px"
    padding: "0 12px"
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md-control}"
    height: "32px"
    padding: "0 10px"
  segmented-capsule:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.capsule}"
    height: "28px"
    padding: "2px"
  panel-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg-panel}"
    padding: "16px"
---

# Design System: Kova（扣瓦）

## Overview

**Creative North Star: "安静工坊"**

Kova 的界面不是演示页，而是一张长期使用的工作台。设计的目标是让用户在长时间停留后依然信任它：结构清晰、密度可控、反馈确定。整窗由图标栏、侧栏、主区、右侧 Agent 面板、终端坞组成；同一时间只允许一个区域成为视觉焦点，其余区域退后。界面语言中文优先，技术名词（Git、MCP、token、JSON）保留原文。

组件层面的手感是**硬朗工程感**：低对比、小圆角、精确的 4px 网格、清晰的分区细线，而不是圆润大卡与柔和光晕。动效默认静止，只在解释状态变化或保持连续性时出现。

**工作方式：** 每次界面改动先明确任务（谁、在什么场景、要完成什么、失败会怎样），再决定信息层级与构图，最后才选组件与颜色。空态、加载、错误、禁用、只读五种状态必须都想清楚。改动后按「审查顺序」自查：第一眼可见性 → 构图 → 排版 → 状态 → 克制 → 主题与缩放 → 信任与可达。

**Key Characteristics:**
- 平面 + 色阶分层，细线（`--hairline`）建立结构，阴影只给浮层
- 中性色为主，强调色仅用于主操作、选中态与焦点环
- 4px 网格 + 小圆角工程感；胶囊只用于角标、开关轨道、分段控件
- 中文正文最小 12px；11px 仅限纯 Latin/数字/等宽元信息
- 动效克制：只动 `transform`/`opacity`/颜色，可中断、可降级

## Colors

以 OKLCH 中性灰为骨架，浅/深两套由 `html.dark` 切换；强调色由用户在设置里选择，运行时写入 `--primary/--ring`。

### Primary
- **单色主色 `primary-mono`**（oklch(0.205 0 0)）：默认强调色即前景色，用于主操作按钮、当前选中、聚焦环的默认档。
- **可配强调色 `focus-blue` 等**（oklch(0.55 0.19 262) 蓝 / 紫 292° 等预设）：`lib/theme/palette.ts` 运行时写入 `--primary/--ring`；**不要再造第二套主题分支**。

### Neutral
- **纸白 `paper`**（oklch(1 0 0)）：浅色页面/卡片底色。
- **墨黑 `ink`**（oklch(0.145 0 0)）：正文与深色模式的底色基准。
- **石墨底 `graphite-muted`**（oklch(0.97 0 0)）：侧栏、工具栏、次级面板底色（浅色）。
- **铅笔灰 `pencil`**（oklch(0.556 0 0)）：次要文字；承载信息的文字禁止再叠加透明度。
- **发丝线 `hairline`**（oklch(0.922 0 0)）：边框与分隔线；深色模式为 `oklch(1 0 0 / 10%)`。

### Named Rules
**The Muted Text Rule.** 承载信息的文字必须是满色 `text-muted-foreground`；禁止 `text-muted-foreground/40|50|60`。只有装饰性图标、分隔符可以淡化。

**The One Accent Rule.** 强调色只用于主操作、当前选中和焦点环；一屏只有一个主按钮，强调色面积不超过 10%。

## Typography

**Body Font:** Geist Variable + 苹方 / 思源黑体 / 雅黑回退（`--app-font-sans`）
**Label/Mono Font:** Cascadia Mono / Menlo / JetBrains Mono（`--app-font-mono`）

**Character:** 无展示字体的系统感。层级靠字号、字重与留白表达，不靠装饰性字体；中文回退含 400/500/600/700 真实字面，**禁止 `font-light` / `font-thin`**。

### Hierarchy
- **Title**（600, 16/24）：页面与分组标题、面板标题。
- **Body（对话）**（400, 15/24）：消息与 Markdown 正文，行宽约 60–75 字符。
- **Body（界面）**（400, 14/20）：表单、说明段落、列表主字段（行标题可用 500）。
- **Compact**（400, 13/20）：设置页字段说明、密集行、`Button sm`。
- **Meta**（400, 12/16）：角标、时间戳、状态点；中文正文的最小字号。
- **Mono Meta**（400, 11/16）：路径、快捷键、纯数字；仅限 Latin/数字/等宽。

### Named Rules
**The Three-Weight Rule.** 同一屏字重不超过 3 种：标题 600，正文 400/500；数字类内容一律 `tabular-nums`。

**The No-Pixel-Leading Rule.** 行高用无单位比例（`leading-5`、`leading-relaxed`），禁止 `leading-[18px]` 这类固定像素行高。

## Layout

- 4px 网格。面板 `p-3`/`p-4`，对话框 `p-6`。
- 主区内容默认上限 `--chat-width: 60rem`；整页内容上限 `--page-width: 80rem`。
- 窗口分区：图标栏（窄图标条）→ 二级侧栏（可折叠、可拖宽）→ 主区（中间列）→ Agent 面板（右列，可折叠）→ 终端坞（下缘）。
- 面板之间用**一种**手段分隔：细线或留白；不同时使用粗边框、阴影和底色三种手段。
- 控件高度：紧凑图标 24、工具栏次按钮 28、默认按钮/图标按钮 32、输入框 36、大按钮 36。主要操作不小于 32px。
- 响应式：`md` 768 以下图标栏与二级侧栏退化为抽屉；`1024` 以下双栏页改为纵向堆叠；1280×800 与 150% 缩放是必须验证的基准尺寸。

## Elevation & Depth

**平面 + 色阶分层**：表面默认齐平。层级由底色（background / muted / card）与 `--hairline` 细线建立，而不是阴影。阴影只用于浮层（Popover、Dialog、Toast）与列间分隔（右列面板左缘一档极淡投影），静态卡片不带投影。

### Shadow Vocabulary
- **面板列分隔**（`-6px 0 14px -6px rgba(0,0,0,0.04)`，深色 `0.20`）：聊天列与 Agent 面板之间、侧栏与主区之间；只表现「压在上层」的一侧。
- **浮层**（组件库默认 `shadow-lg` 档）：Dialog / Popover / Dropdown / Toast；出现即消失，不留驻。

### Named Rules
**The Flat-By-Default Rule.** 静态表面无阴影；阴影是状态与层级的信号，不是装饰。

## Shapes

- 基础圆角 `--radius: 0.625rem`（10px）：`rounded-sm` 6 / `rounded-md` 8 / `rounded-lg` 10 / `rounded-xl` 14 / `rounded-2xl` 18。
- 控件用 `rounded-md`（8px），面板/卡片用 `rounded-lg`（10px），浮层用 `rounded-xl`（14px），对话框 `rounded-2xl`（18px）。
- 同心圆角：内层圆角 = 外层圆角 − 内边距。
- 胶囊（`rounded-full`）只用于角标、开关轨道、分段控件；不要同类控件混用不同圆角。
- 细线：下边框统一用自定义 `border-b`（读 `--hairline`：2x 屏 0.5px，1x 屏 1px）；其他方向用 `border-[length:var(--hairline)]`；**禁止 `border-[0.5px]`**。

## Components

### Buttons
- **Shape:** 8px 圆角（`rounded-md`），高 32（`sm` 28 / `xs` 24 / `lg` 36）。
- **Primary:** 单色/强调色底 + 反色文字；一屏最多一个主操作。
- **Hover / Focus:** 颜色加深一档（`hover:bg-primary/80`），不做位移/缩放；`focus-visible` 必须有可见环。
- **Outline / Ghost / Secondary:** 用底色档位区分（outline = `bg-muted/70`，ghost = 透明 + hover `bg-muted`），不靠描边叠层级。
- **Destructive:** `bg-destructive/10` + 危险色文字；不可逆操作走 `AlertDialog` 二次确认，按钮写明对象与后果。

### Inputs / Fields
- **Style:** 高 36，`rounded-md`，`border-input`，底色 `background`；占位符满色 `text-muted-foreground`。
- **Focus:** 容器描边 + 环（`focus-within:ring-2 ring-ring/20`）；**禁止 `outline-none` 后不给替代**。
- **Error / Disabled:** `aria-invalid` + 紧邻控件的错误文案，不能只靠红边；禁用态降透明度并保留文字对比。

### Navigation
- 左侧图标栏：选中态用 `bg-selected` + 前景增强，悬停只加深一档。
- 二级侧栏：行高 32，分组标题与条目同一条左缘；列表滚动使用全局细滚动条。
- Tabs / 分段控件由父容器测量后统一驱动指示器，子项不各自做背景动画；胶囊选中指示器 500ms `EASE_OUT`。

### Motion
- 微反馈（hover/press/颜色）100–150ms；小组件（下拉、开关、展开）200ms；面板与指示器 300–500ms。
- 缓动统一来自 `lib/motion/ease.ts`：`EASE_OUT` `cubic-bezier(0.16,1,0.3,1)`、`EASE_IN_OUT` `cubic-bezier(0.77,0,0.175,1)`、`EASE_DRAWER` `cubic-bezier(0.32,0.72,0,1)`；弹簧 `SPRING_LAYOUT` 360/32 等。
- 只动 `transform`/`opacity`/颜色；**禁止 `transition-all`**。CSS 动效带 `motion-safe:` 或 `prefers-reduced-motion` 降级；framer 组件受全局 `MotionConfig reducedMotion="user"` 约束。

### States
- 空态 = 一句说明 + 一个主操作；错误态 = 原因 + 重试；加载超过 1s 必须有进行中态（`Skeleton` 或行内 spinner + `aria-busy`）。
- 成功/失败用 toast，文案包含结果对象与下一步；状态不能只靠颜色表达。

## Do's and Don'ts

### Do:
- **Do** 只用语义 token（`bg-background`、`text-foreground`、`bg-selected`、`ring-ring` 等）；组件内禁止十六进制、`rgb()`、`oklch()` 字面量。
- **Do** 用 `bg-hover` / `bg-active` / `bg-selected` 表达悬停/按下/选中，深浅色走 token 自动适配，不手写 `dark:` 配色。
- **Do** 给图标按钮补中文 `aria-label` + Tooltip + 可见 `focus-visible`；异步按钮 `disabled` + `Loader2Icon animate-spin` + `aria-busy`。
- **Do** 数字列用 `tabular-nums`；长文本 `line-clamp-2` 并提供回看入口。
- **Do** 用 4px 网格与一组圆角体系；同心圆角遵循「内层 = 外层 − 内边距」。

### Don't:
- **Don't** 用渐变、发光、光斑、条纹、噪点、装饰性阴影；**禁止玻璃拟态**（窗口材质是用户设置，不是设计手段）。
- **Don't** 用大面积强调色：主色面积 ≤10%，一屏只有一个主按钮、一个强调色。
- **Don't** 用 16px 及以上的大圆角卡片承载密度信息；卡片不套卡片。
- **Don't** 把说明文字压到 12px 以下，或用低透明度灰字硬塞密度；先改写文案。
- **Don't** 用边框/色块/图标修补本来就弱的层级；先调间距与排版。
- **Don't** 动画 `width/height/top/left/margin/padding`（已测量的 Tabs/分段指示器除外）；不要给正文按钮加缩放按压。
- **Don't** 在 `plugins/**` 或 `apps/sidecar/**` 套用本规范；它们是独立界面域。
- **Don't** 使用只靠 placeholder 的表单、只靠颜色的状态、英文 `aria-label`。
