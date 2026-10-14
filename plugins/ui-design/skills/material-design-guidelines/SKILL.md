---
name: material-design-guidelines
description: Android (Material Design 3 / Material You) 设计稿绘制规范：Roboto 字体 type scale、4dp 网格与间距、圆角体系与色调面板（tonal palette）角色取色、elevation/FAB/底部导航/卡片/按钮组件尺寸、状态层透明度。画 Android/跨平台移动端界面稿前加载。
---

# Material Design 3 规范速查（面向画稿直接取值）

单位 dp（画稿按 px 1:1 用）。基线手机：360×800（状态栏 24dp、手势条区 24dp）。

## 字体阶梯（Type Scale，Roboto）

| 角色 | 字号/行高 | 字重 | 用途 |
|---|---|---|---|
| Display Large | 57/64 | 400 | 极少用，超大数字 |
| Display Medium | 45/52 | 400 | — |
| Headline Large | 32/40 | 400 | 页面大标题 |
| Headline Medium | 28/36 | 400 | — |
| Headline Small | 24/32 | 400 | — |
| Title Large | 22/28 | 400 | 卡片/页面主标题 |
| Title Medium | 16/24 | 500 | 区块标题 |
| Title Small | 14/20 | 500 | 列表主文字 |
| Body Large | 16/24 | 400 | 正文 |
| Body Medium | 14/20 | 400 | 次正文 |
| Body Small | 12/16 | 400 | 辅助 |
| Label Large | 14/20 | 500 | 按钮文字 |
| Label Medium | 12/16 | 500 | 小标签 |
| Label Small | 11/16 | 500 | 错误提示 |

## 布局与间距

- 4dp 网格：所有尺寸落在 4 的倍数上。常用间距 4 / 8 / 12 / 16 / 24 / 32。
- 页边距：默认 16dp（列表/表单），宽松卡片页 24dp。
- 触控目标：**最小 48×48dp**，相邻 ≥ 8dp。

## 圆角体系（Shape Scale）

| 档位 | 值 | 典型组件 |
|---|---|---|
| Extra Small | 4dp | Snackbar、提示 |
| Small | 8dp | Chip、文本按钮容器 |
| Medium | 12dp | 卡片、FAB 中号 |
| Large | 16dp | 底部弹层顶部、FAB |
| Extra Large | 28dp | 对话框、导航抽屉右缘 |
| Full（胶囊） | 高/2 | 按钮、Chip、搜索栏 |

## 颜色角色（一套种子色生成 tonal palette；画稿直接取近似值）

浅色主题基线（以紫色系种子为例）：

| 角色 | 近似值 | 用途 |
|---|---|---|
| primary | #6750A4 | 主按钮底、活跃导航图标、链接 |
| on-primary | #FFFFFF | primary 上的文字 |
| primary-container | #EADDFF | 选中 Chip/导航药丸底 |
| on-primary-container | #21005D | 上面文字 |
| secondary-container | #E8DEF8 | 次级容器底 |
| surface | #FEF7FF | 页面底 |
| surface-container | #F3EDF7 | 顶栏底、卡片变体 |
| surface-container-high | #ECE6F0 | 抬升卡片、导航条底 |
| on-surface | #1D1B20 | 主文字 |
| on-surface-variant | #49454F | 次文字/图标 |
| outline | #79747E | 描边（1dp） |
| outline-variant | #CAC4D0 | 分隔线 |
| error | #B3261E | 错误 |

深色主题：surface #141218、on-surface #E6E1E5、primary #D0BCFF、
on-primary #381E72、primary-container #4F378B、on-primary-container #EADDFF。

规则：**不用纯黑纯白**（on-surface #1D1B20 / surface #FEF7FF）；一个界面 primary 只
承担"可操作/选中"语义；容器色（*-container）配其 on- 前缀文字保证对比。

## Elevation（用表面色 + 阴影双通道表达）

| 级别 | 阴影 (y/blur/spread, #000) | 典型 |
|---|---|---|
| 0 | 无，surface 本色 | 列表页卡片(filled) |
| 1 | 0/2/0/0 @5%, 0/2/2/0 @3% | 顶栏、Card 默认 |
| 3 | 0/4/8/0 @8%, 0/2/4/-1 @5% | 拖拽中的卡片 |
| 6 | 0/6/12/2 @10%, 0/4/4/0 @10% | FAB |
| 8 | 0/8/16/3 @12%, 0/4/6/1 @7% | 对话框、菜单 |

## 高频组件取值

- **Top App Bar**：小 56dp（标题 Title Large 左 16）；中 112dp（可滚时收起）；图标钮 48 热区、符号 24。
- **Navigation Bar（底部）**：高 80dp，3-5 项；活跃项药丸指示 64×32 secondary-container + Label Medium；图标 24。
- **Navigation Drawer**：宽 360dp、右侧圆角 28；条目高 56、圆角 28 选中态 secondary-container。
- **FAB**：常规 56dp 圆角 16（图标 24）；小 40；大 96 圆角 28（图标 32，可带文字）；extended = 高 56、水平内边距 16、Label Large。
- **Button**：Filled（primary 底白字、高 40、胶囊、左右 24）；Filled Tonal（secondary-container）；Outlined（1dp outline 描边透明底）；Text（仅 primary 文字）。禁用 = on-surface @12% 底 + @38% 字。
- **Card**：Filled 无描边 surface-container-low + 圆角 12；Outlined 1dp outline-variant；内容内边距 16。
- **List**：单行 56dp、双行 72dp、三行 88dp；左图标/缩略 24-40；分隔线 inset 16。
- **Chip**：高 32、圆角 8（有图标时 12）、文字 Label Medium、左内边距 16/选中 12。
- **TextField**：高 56、圆角 4 顶部 + 下划线 1dp（聚焦 2dp primary）或 Outlined 全边框 1dp（聚焦 2dp）。
- **对话框**：宽 min(312, 屏宽-48?) 取 280-560、圆角 28、标题 Headline Small、按钮区右上对齐胶囊文字按钮。
- **状态层**（交互反馈用叠加色）：hover @8%、focus @10%、press @10-12%（on-X 色）。
- **图标**：Material Symbols 线性 24dp、线宽 1.5-2；状态图标成对（outline 未选 / 填充已选）。
