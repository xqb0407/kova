---
name: canvas
description: 用「无限画布」面板创作/修改画布文档：Excalidraw 式无限空间，文本/形状/图片/Mermaid/表格/图表/网页嵌入自由摆放，整画布导出 SVG。文档是独立的 *.canvas.json（纯 objects，无页面/页框概念）。UI 设计稿请用独立的「UI 设计」面板（*.uidesign.json，见 ui-design skill）；演示文稿请用「幻灯片」面板（office 插件，*.deck.canvas.json）——本面板不再承担这两类工作。当用户想要画布式涂鸦/示意板/头脑风暴/流程草图、或想在工作区里可视化继续编辑某个 .canvas.json（非 .deck 前缀）时使用。画布支持九种元素：text / shape（矩形/椭圆/菱形/三角/梯形/五边形/六边形/星形 + 直线/单双箭头（可折线 pts）；同组 groupId 的元素一起选中/移动）、image / mermaid / draw / svg（内嵌 SVG 源码——用户说"生成/插入 SVG、放个矢量插画/图标"就用它，源码直接进档）、embed（内嵌网页——用户说"放个视频/网页/B站/YouTube/Figma/地图"就用它，贴 URL 即嵌入）、table（表格——数据表/参数表，双击进入单元格编辑）、chart（数据图表：柱/折/饼/环，双击弹出数据表单）。覆盖：文档 schema v3（meta / objects）、生成→唤起面板→迭代的工作流、旧档（v1/v2）自动迁移说明。
---

# Canvas：无限画布

画布文档就是工作区里一个**普通的 JSON 文件**（约定名 `<名称>.canvas.json`），
你用现有工具（write / edit / read）直接读写它；用户在「无限画布」面板里实时看到
渲染结果、可以手动继续编辑，也能一键导出整画布 SVG。

**模型**：纯无限画布——文档只有 `objects` 一层，元素用**画布绝对坐标**直接落在
无限空间（可负值）。**没有页面、没有页框、没有放映**；要"容器/卡片"的视觉效果，
用 `shape` 圆角矩形自己拼。

## 工作流（按此顺序）

1. **创作（分段写盘，别攒成一次大 write）**：面板会在每次落盘后约半秒重渲染，
   所以要让用户**边生成边看到画面长出来**：
   - 第一步先 `write` 一份**骨架**落盘：`meta` + 各元素的占位（标题文本等），
     路径如 `brainstorm-q3.canvas.json`（根目录或任意子目录均可；扩展名必须是
     `.canvas.json`，面板按 `*.canvas.json` 认领文件，`.deck.canvas.json` 除外——那是幻灯片档）。
   - **骨架一落盘宿主就自动开板并绑定该文件**（`write`/`edit` 命中认领声明即唤起，无需你调
     任何工具）——所以骨架必须第一步就写、且是合法完整的 JSON，之后的 edit 才会逐次上屏。
   - 然后**一批一次 `edit`** 把内容补进去：每次 edit 都基于当前文件做一次完整、合法的替换，
     落盘一次上屏一次。⚠️ 每次落盘的 JSON 必须完整有效（edit 是原地替换，天然满足）。
2. **面板唤起（通常自动，工具是兜底）**：首次 `write`/`edit` 该 `.canvas.json` 时宿主会
   **自动打开面板并绑定文件**（同一文件每轮只自动开一次）。需要**换绑**到别的画布文档、
   或用户说"面板没出来"时，再显式调用 `open_plugin_panel`，参数
   `plugin: "canvas", panel: "canvas", path: "brainstorm-q3.canvas.json"`（幂等，重复调用只是聚焦）。
   若报插件未安装/未启用，提示用户：主区「已装插件」页把该插件的开关打开。
   面板没有绑定的文件时，它会先显示「全部画布」首页（历史卡片 + 新建入口）。
3. **迭代前必须先 `read`**：面板会把用户的手动编辑防抖写回同一个文件——
   你上次写的内容可能已被改动（元素可能被增删挪位了）。永远基于最新文件内容做
   `edit`/`write`，你写盘后面板会自动刷新（若用户有未保存编辑，面板会弹冲突框由用户选择，不用你处理）。
4. 元素 `id` 保持稳定：新增才生成新 id，改动既有内容不要换 id，
   否则用户画布上的选中态/撤销历史会错乱。
5. **坐标与排版**：无限画布没有"页面尺寸"，构图靠自己摆——相关内容聚簇摆放
   （簇间距 ≥ 80px），连线用 `arrow`（两端压在元素上会自动吸附绑定，移动元素连线跟随）；
   文本宽度给足（一个中文字符 ≈ 字号 px），避免溢出换行超出 `h`。

## 文档 Schema（version 3）

解析是**容错**的：未知字段忽略、坏元素丢弃（面板不白屏）；按下述规格写保证渲染/导出还原度。

```jsonc
{
  "version": 3,
  "meta": { "name": "头脑风暴" }   // kind 字段已废弃；旧档的 "ui" 只读（迁移提示用）
  "objects": [ /* 全部元素：x/y 是画布绝对坐标，可负 */ ]
}
```

- **旧档自动迁移**：`"version":2` 带 `frames`（或 `"version":1` 带 `slides`）的文档
  打开时自动拍平成 objects——页框内元素平移为绝对坐标、非白页框背景补一块同尺寸矩形，
  并写回 v3。**你不需要手写迁移**；引用旧档里的元素时，先 `read` 拿拍平后的最新内容。
- ⚠️ 旧 `"kind":"ui"` 档（旧「UI 设计」）仍能打开（徽标「UI 设计（旧）」），但**不要再续写**——
  UI 设计稿请引导用户去「UI 设计」面板（独立格式 `*.uidesign.json`，规范见 ui-design skill）。

### 所有元素共有的字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | string | `text` / `shape` / `image` / `mermaid` / `draw` / `embed` / `svg` / `table` / `chart` |
| `id` | string? | 省略则自动生成；保持稳定的键 |
| `x` `y` `w` `h` | number | 像素，画布绝对坐标；`w`/`h` 最小 1 |
| `opacity` | 0–1? | 缺省 1 |
| `rotation` | number? | 角度（顺时针），缺省 0 |
| `groupId` | string? | 编辑组：同组 id 的元素一起选中/移动/删除（一层不嵌套） |
| `locked` | boolean? | 锁定：用户在画布上不可拖动/删除（仅 UI 守卫；agent 写档不受限，慎用） |

### text —— 文本

```jsonc
{
  "kind": "text", "id": "t1", "x": 128, "y": 230, "w": 480, "h": 72,
  "runs": [
    { "text": "季度主题", "bold": true, "size": 40, "color": "#111827" },
    { "text": " · 备注", "size": 24, "color": "#6b7280" }
  ],
  "align": "left",     // left | center | right，缺省 left
  "vAlign": "top"      // top | middle | bottom，缺省 top
}
```

- run 字段：`text`（必填）、`bold`、`italic`、`underline`、`size`（1–400，缺省 24）、
  `color`（#hex）、`font`（字体族名，见白名单）。
- 便捷写法：`"runs": ["纯文本"]` 或 `"text": "纯文本"` 等价于单 run。换行直接放 `\n`。
- 一个文本框内多 run 是行内混排；不同段落/样式请拆成多个 text 元素。

### shape —— 矩形/椭圆/多边形/直线/箭头

```jsonc
{
  "kind": "shape", "id": "r1", "shape": "rect",
  "x": 80, "y": 560, "w": 240, "h": 120,
  "fill": "#0a84ff",          // #hex 或 "none"；线类（line/arrow/double-arrow）无 fill
  "stroke": "#1d1d1f",        // #hex 或 "none"，缺省 none
  "strokeWidth": 2,           // 0–40
  "radius": 12,               // 仅 rect：圆角像素
  "strokeStyle": "dashed"     // solid | dashed | dotted，缺省 solid
}
```

`shape` 取 `rect | ellipse | diamond | triangle | trapezoid | pentagon | hexagon | star | line | arrow | double-arrow`。
线类从 `(x,y)` 画到 `(x+w, y+h)`（用正/负 w/h 摆方向）；`arrow` 尾点单箭头、`double-arrow` 两端箭头。
多边形按 bbox 内切绘制（star 内半径 0.382）。
线类通用 `curve` 弧度（[-1,1]，缺省＝直线）：以弦二次贝塞尔弯曲，正值沿行进方向逆时针拱。
线类高级：`pts`（[[x,y],…] 相对 bbox 左上角，≥3 点成折线，curve 失效）；
`startBind`/`endBind`（吸附同容器元素 id——写档时可以不写，编辑器移动被绑元素时自动重算）；
**`route: "orth"`（正交走线，架构图首选）**——两端横平竖直：绑定端路径由同步自动重算
（按相对方位选边、锚在边中点附近），自由端首次同步生成一次 L 形折线后可手动编辑。
直行时自动收缩为两点线（不写 pts）。写档建议：连线一律带 `startBind`/`endBind` + `route:"orth"`，
坐标随便填一个大致位置即可（同步会重算）。
`label`（线上标签）：渲染在路径中点上方、颜色随线身（如 `"label": "调用"`，≤80 字符）。
（历史兼容：旧文档的 `curve-arrow` 载入时自动迁移为 `arrow` + `curve`，新档不要再写。）

### image —— 图片

```jsonc
{ "kind": "image", "id": "i1", "x": 0, "y": 0, "w": 400, "h": 300,
  "src": "brainstorm-q3-assets/shot-xyz.png",   // workspace 相对路径
  "fit": "cover",           // cover | contain | stretch，缺省 cover
  "radius": 8 }
```

图片本体不放 JSON：先 `attach`/写文件到 `<画布名>-assets/` 目录（宿主资产目录约定），
`src` 引用相对路径。

### mermaid —— 图表

```jsonc
{ "kind": "mermaid", "id": "m1", "x": 0, "y": 0, "w": 640, "h": 400,
  "code": "graph TD\n  A[开始] --> B{判断}", "theme": "default" }
```

`code` 是 mermaid 源码（flowchart/sequence/pie…随主题渲染）；`theme` 缺省 `default`，
可选 `dark | neutral | follow`。

### draw —— 钢笔手绘

```jsonc
{ "kind": "draw", "id": "d1", "x": 0, "y": 0, "w": 100, "h": 50,
  "points": [[0,0],[50,25],[100,0]], "stroke": "#1d1d1f", "strokeWidth": 3 }
```

`points` 相对 bbox 左上角（用户手绘产生；agent 一般不手写）。点数上限 2000（超出抽稀）。

### embed —— 内嵌网页

```jsonc
{ "kind": "embed", "id": "e1", "x": 0, "y": 0, "w": 640, "h": 400,
  "url": "https://www.youtube.com/watch?v=xxx", "title": "可选角标名" }
```

http(s) 绝对地址；白名单 provider（YouTube/B站/Figma/地图…）转成 embed 地址，
其余原样 iframe。沙箱继承自面板（无 Cookie/登录态）。

### svg —— 内嵌 SVG 源码

```jsonc
{ "kind": "svg", "id": "sv1", "x": 0, "y": 0, "w": 240, "h": 180,
  "code": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 240 180\">…</svg>" }
```

完整 `<svg>…</svg>` 源码直接进档（矢量、免资产文件）；viewBox 决定内容缩放，
`w`/`h` 决定摆放尺寸。导出 SVG 时以 data-url 内嵌（跨查看器沙箱化）。

### table —— 表格

```jsonc
{ "kind": "table", "id": "tb1", "x": 0, "y": 0, "w": 480, "h": 220,
  "rows": [["列 A", "列 B", "列 C"], ["", "", ""]],
  "colWidths": [2, 1, 1],       // 可选：列宽权重，缺省均分
  "header": true,               // 缺省 true：首行表头样式
  "size": 18,                   // 字号 px，缺省 18
  "fill": "#ffffff", "headerFill": "#eef0f2", "stroke": "#d4d4d8", "color": "#1d1d1f" }
```

上限 100 行 × 30 列、单元格 500 字符。

### chart —— 数据图表

```jsonc
{ "kind": "chart", "id": "c1", "x": 0, "y": 0, "w": 480, "h": 320,
  "chart": "bar",               // bar | line | pie | doughnut，缺省 bar
  "labels": ["一月", "二月", "三月"],
  "series": [ { "name": "系列 A", "data": [12, 19, 8] } ],
  "colors": ["#166534", "#0a84ff"],  // 可选：系列色循环
  "showLegend": false,          // 缺省 false
  "size": 12 }                  // 标签字号，缺省 12
```

饼/环只取 `series[0]`（data = 扇区值，labels = 扇区名）。

## 排版规范

- **聚簇**：相关元素放一簇，簇间距 ≥ 80px；标题 text 放簇顶。
- **连线**：架构图/流程图一律 `arrow` + `startBind`/`endBind` + `route:"orth"`（正交走线，
  移动元素自动跟随且横平竖直）；需要标注语义就加 `label`。别用长斜线硬连。
- **文本可读性**：正文 size ≥ 18，标签 ≥ 14；深色底（shape fill 深）上的文字用
  `#f5f5f7`，浅色底用 `#111827`。
- **尺寸克制**：单元素 w/h ≤ 2000；整档元素数 ≤ 500（再多拆档）。

## 导出

面板「导出」按钮 = **整画布 SVG**（全部 objects 的内容并集包围盒，单文件 `<名称>.svg`）。
没有 .pptx / 页面导出——需要演示文稿请用「幻灯片」面板（office 插件）。

## 已知边界

- `frames`/`slides` 字段写进新档会被**忽略并清掉**（旧档自动拍平是唯一入口）。
- 旧 `kind:"deck"` 打开即按画布处理，不再有逐页编辑。
- embed 元素是活的 iframe，但导出 SVG 里只有占位框 + 链接。
