---
name: ios-design-guidelines
description: iOS (Human Interface Guidelines) 设计稿绘制规范：SF Pro 字号阶梯、44pt 触控、16pt 边距与 8pt 间距、导航/标签栏/列表/弹层等组件尺寸、系统色板与深浅双主题。画 iPhone/iPad 界面稿（*.uidesign.json 或 HTML 原型）前加载，按本规范取值而非凭感觉。
---

# iOS 设计规范速查（HIG 浓缩，面向画稿直接取值）

单位一律 pt（逻辑点）。目标设备基线：iPhone 390×844（状态栏含灵动岛区按 54pt 留，
home 指示条区 34pt）。

## 字号阶梯（SF Pro，Regular 设备 UI Text Styles）

| 角色 | 字号/行高 | 字重 |
|---|---|---|
| Large Title | 34/41 | Bold |
| Title 1 | 28/34 | Bold |
| Title 2 | 22/28 | Bold |
| Title 3 | 20/25 | Semibold |
| Headline | 17/22 | Semibold |
| Body | 17/22 | Regular |
| Callout | 16/21 | Regular |
| Subhead | 15/20 | Regular |
| Footnote | 13/18 | Regular |
| Caption 1 | 12/16 | Regular |
| Caption 2 | 11/13 | Regular |

规则：页面主标题用 Large Title（滚动时收进导航栏变 Inline，17 Semibold）；
正文一律 Body；辅助说明 Footnote/Caption 1；同一屏不超过 3 个层级混用。

## 布局与间距

- 页边距（左右 gutter）：**16pt**（默认）；宽屏设备 20pt。
- 间距系统：8pt 基准格，常用 8 / 12 / 16 / 20 / 24 / 32；分区间距 ≥ 上下文中元素间距。
- 触控目标：**最小 44×44pt**（视觉可更小，热区补足）；相邻目标间隔 ≥ 8pt（推荐 12pt）。
- 安全区：内容不得顶进状态栏/home 指示条；贴底操作按钮距安全区底 ≥ 8-20pt。
- 系统栏：导航栏高 44pt；标签栏高 49pt（不含指示条 34）；工具栏 44pt；列表行高默认 44pt。

## 圆角与描边

- 卡片/容器：连续圆角 10-16pt（Inset Grouped 列表卡 10pt）。
- 按钮：8-14pt（大按钮 14）；输入框 10pt；头像用正圆或 12pt 圆角方。
- 分隔线：0.5pt（画稿用 1px），Inset Grouped 左缩进 = 图标/内容起点（常用 16 + 元素宽 + 间距）。

## 颜色（浅色模式 → 深色模式）

| 语义 | Light | Dark |
|---|---|---|
| 窗口背景 systemBackground | #FFFFFF | #000000 |
| 分组背景 secondarySystemGrouped | #F2F2F7 | #1C1C1E |
| 卡片/控件填充 | #FFFFFF | #2C2C2E |
| 主文本 label | #000000 (87%+，画稿可用 #000) | #FFFFFF |
| 次文本 secondaryLabel | #3C3C43 @ 60% | #EBEBF5 @ 60% |
| 三级/占位 tertiaryLabel | #3C3C43 @ 30% | #EBEBF5 @ 30% |
| 强调蓝 tint | #007AFF | #0A84FF |
| 绿/红/橙 | #34C759 / #FF3B30 / #FF9500 | #30D158 / #FF453A / #FF9F0A |
| 分隔线 opaqueSeparator | #C6C6C8 | #38383A |

规则：一个界面 1 个 tint 色贯穿操作元素；红只用于破坏性/错误；文字层级优先用
label 透明度分级而非自调灰色。

## 高频组件取值

- **导航栏**：标题 17 Semibold 居中；左返回（chevron + 17 Regular，文字可省）；右操作图标 ≤ 3 个，22×22 符号框。
- **标签栏**：3-5 项；图标 28×28 视觉区、符号 24pt；文字 10pt Medium；选中 tint 色、未选中灰。
- **列表（Inset Grouped）**：卡片左右 16pt、圆角 10pt；行高 44+；左缩进 16 + 图标 29×29 + 间距；副标题 Caption 1 灰色。
- **按钮**：主按钮 = tint 底白字、高 50pt（可 44）、圆角 14、17 Semibold；次按钮灰底 #767680 @ 20%；文字按钮 tint 色。
- **输入框**：高 44-50、圆角 10、占位 tertiaryLabel、左侧放大镜/图标可选。
- **Segmented Control**：高 32、圆角 8、选中段白底 + 阴影。
- **开关/复选**：Switch 51×31（on=tint）；勾选 22×22 tint 圆角方块。
- **弹层**：Alert 宽 270、圆角 14、标题 17 Semibold + 正文 13；Sheet 顶部圆角 10、grabber 36×5 灰、Medium detent ≈ 屏高 50-65%。
- **图标**：SF Symbols 风格——线性、圆头端点、字重匹配相邻文字；工具栏符号 22、列表图标 29。

## 排版与内容

- 文本左右不要贴边（≥16pt）；行宽 ≤ 40-45 字符为佳。
- 触控优先拇指区：主操作放屏幕下半部；导航/标签栏置底。
- 真实文案：用具体产品词，禁止 Lorem ipsum；数字用真实格式（¥1,286.50、9:41 AM）。
- 状态呈现：空态（插画+一句解释+一个操作）、加载（骨架屏用 #F2F2F7 系灰块）、错误（红 + 重试操作）各画一块画板。
