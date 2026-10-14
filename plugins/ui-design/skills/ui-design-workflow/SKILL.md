---
name: ui-design-workflow
description: UI 设计稿的三段式生产流程（骨架 → 内容 → 精修）：先用 create_doc 的 template 铺出只有分区与栅格的页面骨架，再用 run_design_script 批量铺重复结构（列表行/卡片网格/表格），最后用 lint_doc 清掉可验证的设计问题并配 screenshot_doc 看图迭代。画 App 页面、移动端/桌面界面稿、原型、落地页、仪表盘等多屏设计稿时加载——它管的是"怎么把稿子做对"，ui-design 技能管的是"字段和工具怎么用"，两者配合使用。
---

# 三段式设计稿工作流（骨架 → 内容 → 精修）

> 配套：`ui-design` 技能给字段与工具口径；`ios-design-guidelines` / `material-design-guidelines` /
> `mobile-design-tokens` 给具体数值（字号、间距、圆角、色板直接照抄，别凭感觉）。
> 下面所有例子假设已经 `read_doc` 拿到过画板 id。

**为什么要分段**：一把梭（先想清楚整屏再一次性铺完）失败率最高的两个原因是——结构没定就塞内容，
改结构时整屏返工；重复内容手写十几遍近似 JSON，层级和坐标极易错。分段把这两件事各自隔离解决。

## 第一段：骨架（只定结构，不填内容）

```js
create_doc({ path: "设置.uidesign.json", preset: "ios-390", template: "settings" })
```

`template` 直接铺出**命名分区**的画板（分区本身是空 frame）。可用：
`blank` / `login` / `list` / `detail` / `settings` / `dashboard` / `empty`。
dashboard 配 `preset: "desktop-1440"`。

没有匹配模板时，用 `create_doc` 的 `frames` 建画板，再用 `add_nodes` 手摆分区：

```js
create_doc({ path: "首页.uidesign.json", preset: "ios-390" })
add_nodes({ path: "首页.uidesign.json", parent: "<画板id>", nodes: [
  { type: "frame", name: "顶栏", x: 0, y: 0, w: 390, h: 88, layout: { mode: "h", gap: 12, padding: [16,16,16,16], cross: "center" } },
  { type: "frame", name: "内容", x: 0, y: 88, w: 390, h: 756, layout: { mode: "v", gap: 16, padding: [16,16,16,16], cross: "stretch" } },
]})
```

**这一段的停手条件**：分区齐了、栅格关系正确了。**分区里不要放真实内容**——放了就得返工。

> 骨架尽量用 `layout`（自动布局）而不是手算坐标：后面内容一变，重排引擎（`apply_layout`）
> 会自己把子项排对，不会因为你少算了一个间距就整屏错位。

## 第二段：内容（重复结构交给脚本）

只要是**结构重复**的东西——列表行、卡片网格、导航项、表格行、指标块——一律用 `run_design_script`，
不要手写 N 段 JSON：

```js
run_design_script({ path: "设置.uidesign.json", script: `
  const rows = ["账号与安全", "通知", "隐私与权限", "存储", "电池"];
  for (let i = 0; i < rows.length; i++) {
    const row = I("<分组一id>", { type: "frame", name: rows[i], y: i * 56, w: 390, h: 56 });
    I(row, { type: "text", text: rows[i], x: 16, y: 18, w: 300, h: 20, size: 15 });
    I(row, { type: "icon", icon: "chevron-right", x: 356, y: 18, w: 20, h: 20, color: "#8e8e93" });
  }
` })
```

脚本里只有三个记录器，**不直接改文档**，执行完由工具统一落盘一次：

| 记录器 | 作用 |
|---|---|
| `I(parentId, spec)` | 建节点，`spec` 与 `add_nodes` 的节点规格完全同构；返回新 id，可继续当 parent |
| `U(nodeId, patch)` | 改字段，与 `update_nodes` 一致 |
| `log(...)` | 把中间量收进返回值，方便回读 |

脚本可 `return`，结果出现在返回值的 `result` 里。约束：硬超时默认 5 秒（死循环会被强制中断），
单次最多 2000 个操作，`require`/`process`/`fetch` 不可用（只做纯计算）。

**图标别瞎写**：`icon` 字段必须是 lucide 规范名，先 `list_icons({ query: "chevron" })` 搜。
写错名字会渲染成占位方块，而且 `lint_doc` 会报 `unknown-icon`。

**别手搓能现成的**：按钮/标签/占位符/表格/状态栏/标签栏/流程图/图表这些，
`insert_stencil` 一次就能落到位（`list_stencils` 查 id）——手摆的十个有九个栅格是歪的。
按钮上的一行字直接写进形状的 `text`（形状内嵌标签），不要另起 text 节点再对齐进去。

**这一段的停手条件**：每块分区都有内容了，文案是真实文案（不是「标题 1」「项目 A」）。

## 第三段：精修（lint 清问题 + 截图看构图）

```js
lint_doc({ path: "设置.uidesign.json" })                 // 全档体检
lint_doc({ path: "设置.uidesign.json", ids: ["<画板id>"] }) // 只看某块
```

`lint_doc` 返回带 `nodeId` / `code` / `message` / `suggestion` 的问题清单，**只报不修**。
按 `suggestion` 改完再跑，直到 `counts.error` 和 `counts.warning` 都是 0。

**`nodeId` 可以直接喂给 `update_nodes`**（实例内部节点形如 `实例id/内部id`，也支持）。
改文字节点颜色只需给 `{ id, color }`，不必重述文案。

12 条规则里，这几条最值得先看：

| code | 含义 | 典型改法 |
|---|---|---|
| `text-contrast` | 文字对比度不足（WCAG AA） | 文字色往背景的反方向推，或调整背景明度 |
| `slop-three-card-row` | 三张等大等距卡片——AI 味最重的套路 | 改成 2+1、拉开某张尺寸、让一张成为主视觉 |
| `slop-rounded-card-wall` | 满屏「大圆角+阴影」卡片 | 去圆角或去阴影，或改用分隔线/留白 |
| `slop-purple-glow` | 紫渐变叠大范围模糊阴影 | 换品牌色或中性色，收紧阴影模糊半径 |
| `tap-target-small` | 触控区 < 44×44 | 放大节点或用内边距撑开热区 |
| `overflow-clipped` | 内容被画板裁掉了 | 挪回画板内、缩小，或给画板 `clip:false` |

然后**看一眼**：

```js
screenshot_doc({ path: "设置.uidesign.json" })   // 图像直接上屏
```

lint 查得到「有毛病」，查不出「难看」。构图是否舒服、留白是否呼吸、层次是否清楚——
这些只能看图。**lint 干净 + 截图满意**，这一稿才算做完。

## 收尾

```js
export_doc({ path: "设置.uidesign.json" })   // 落盘整个工程包目录
```

用户要成品时再导出；只要一张预览图走 `screenshot_doc` 的 `saveTo`。

## 几条硬纪律

- **重复结构永远用 `run_design_script`**。手写 N 段近似 JSON 是返工和坐标错的���要来源。
- **结构用 layout 表达，不要手算坐标**。改了 gap/padding 让引擎重排，比逐个挪节点可靠。
- **不要为了"看起来完整"而跳过 `lint_doc`**。它 12 条规则几毫秒跑完，是唯一能量化的质量判据。
- **改完稿一定 `screenshot_doc` 看一眼**再交付。lint 全绿 ≠ 好看。
- **`lint_doc` 和 `screenshot_doc` 要配套用**：前者管"有毛病"，后者管"不好看"。
- **每段之间可以给用户看**：骨架铺完先确认结构，往往比填完内容再推翻省事得多。