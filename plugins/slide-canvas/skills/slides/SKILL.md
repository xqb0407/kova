---
name: slides
description: 用「无限画布 · 幻灯片」面板创作/修改画布文档：文档自带类型（白板 / 幻灯片，建档时选定、进入后不再切换）。白板是无限画布（只呈现 objects），幻灯片是逐页编辑（frames，可放映、可导出 .pptx）。UI 设计稿已拆分为独立的「UI 设计」面板（*.uidesign.json，见 ui-design skill），本面板不再新建 UI 档。当用户想要演示文稿（PPT、slides、deck、路演、汇报页）、画布式涂鸦/示意板、或想在工作区里可视化继续编辑某个 .canvas.json 时使用。画布支持九种元素：text / shape（矩形/椭圆/菱形/三角/梯形/五边形/六边形/星形 + 直线/单双箭头；同容器元素可用 groupId 组合，整组选中/移动）、image / mermaid / draw / svg（内嵌 SVG 源码——用户说"生成/插入 SVG、放个矢量插画/图标"就用它，源码直接进档）、embed（内嵌网页——用户说"放个视频/网页/B站/YouTube/Figma/地图"就用它，贴 URL 即嵌入）、table（表格——数据表/参数表，双击进入单元格编辑）、chart（数据图表：柱/折/饼/环，双击弹出数据表单）。覆盖：文档 schema v2（meta.kind / objects / frames）、生成→唤起面板→迭代的工作流、v1 迁移、排版规范与导出限制。
---

# Slides：白板画布 + 幻灯片 PPT（一个文档，两个模式）

画布文档就是工作区里一个**普通的 JSON 文件**（约定名 `<名称>.canvas.json`），
你用现有工具（write / edit / read）直接读写它；用户在右侧「无限画布 · 幻灯片」
面板里实时看到渲染结果、可以手动继续编辑，也能一键放映 / 导出 `.pptx`。

**模型**：文档类型由 `meta.kind` 决定（`"board"` 白板 / `"deck"` 幻灯片），
**在建档时选定，进入编辑器后没有切换**；老文档缺 `kind` 时按内容回退（纯页框→幻灯片，否则白板）。
用户在面板首页用「新建白板 / 新建幻灯片」建档；你也可以直接 `write` 一份带
`meta.kind` 的文件（见下）。
⚠️ 旧档里的 `"kind":"ui"` 仍能打开（徽标「UI 设计（旧）」），但**不要再新建或续写 ui 档**——
UI 设计稿请引导用户去「UI 设计」面板（独立格式 `*.uidesign.json`，规范见 ui-design skill）。

- **白板**（无限画布）：**只呈现 `objects`**——画布级元素，绝对坐标直接落在无限空间
  （涂鸦、示意图、便签…），可框选/拖动/钢笔手绘；**不进 .pptx**。
  ⚠️ 白板文档里 **frames 既不渲染也不可点**（页框是"页"的语义，只在幻灯片里出现）——
  想在白板上放"容器/卡片"，用 `shape` 圆角矩形。
  ❌ **已知翻车形态**：把 390×844 的"手机画板"写成 `frames:[{type:"slide",…}]`
  再把元素塞进 `frame.elements`——白板模式一个字都不渲染，看起来像"坏了"。
  ✅ **UI 设计稿请去「UI 设计」面板**：独立格式 `*.uidesign.json`（frame 节点 + 子节点树），
  字段与出稿规范见 ui-design skill；用户手上有旧 `"kind":"ui"` 档时，引导其在面板顶部点「让 AI 迁移」。
- **幻灯片**：只呈现 `frames`——PowerPoint 式一次编辑一页（左侧缩略图栏 + 翻页），
  框内元素用**局部坐标**。**放映/导出只认 `type:"slide"` 的页框，数组序 = 页序。**
  新建幻灯片档自带一张空白页。

## 工作流（按此顺序）

1. **创作（分段写盘，别攒成一次大 write）**：面板会轮询绑定文件并在每次落盘后约半秒重渲染，
   所以要让用户**边生成边看到画面长出来**：
   - 第一步先 `write` 一份**骨架**落盘：`meta`（含 `kind`，必填）+ 全部页框（deck）
     + 各页标题文本，页内正文先留空；路径如 `roadmap-q3.canvas.json`
     （根目录或任意子目录均可；扩展名必须是 `.canvas.json`，面板按 `*.canvas.json` 认领文件）。
   - **骨架一落盘宿主就自动开板并绑定该文件**（`write`/`edit` 命中认领声明即唤起，无需你调
     任何工具）——所以骨架必须第一步就写、且是合法完整的 JSON，之后的 edit 才会逐次上屏。
   - 然后**一页（或一画板）一次 `edit`** 把正文补进去：每次 edit 都基于当前文件做一次
     完整、合法的替换，落盘一次上屏一次。⚠️ 每次落盘的 JSON 必须完整有效
     （edit 是原地替换，天然满足；别手工拼接出半截括号的中间态——无效 JSON 面板会报错）。
2. **面板唤起（通常自动，工具是兜底）**：首次 `write`/`edit` 该 `.canvas.json` 时宿主会
   **自动打开面板并绑定文件**（同一文件每轮只自动开一次，避免反复抢焦点）。需要**换绑**到
   别的画布文档、或用户说"面板没出来"时，再显式调用 `open_plugin_panel`，参数
   `plugin: "slide-canvas", panel: "canvas", path: "roadmap-q3.canvas.json"`（幂等，重复调用只是聚焦）。
   若报插件未安装/未启用，提示用户：主区「已装插件」页把该插件的开关打开（停用后其面板不会
   出现在「＋」菜单）；目录市场**拷贝装**的插件读的是物化到 cache 的拷贝，改源码要在市场页
   点一次「安装/更新」才进 app；**链接装（开发模式）**则读源码目录本身，重建后面板会自动热重载。
   面板没有绑定的文件时，它会先显示「全部画布」首页（历史卡片 + 新建入口）。
3. **迭代前必须先 `read`**：面板会把用户的手动编辑防抖写回同一个文件——
   你上次写的内容可能已被改动（页也可能被增删重排了）。永远基于最新文件内容做
   `edit`/`write`，你写盘后面板会自动刷新（若用户有未保存编辑，面板会弹冲突框由用户选择，不用你处理）。
4. 元素/页框 `id` 保持稳定：新增才生成新 id，改动既有内容不要换 id，
   否则用户画布上的选中态/撤销历史会错乱。

## 文档 Schema（version 2）

解析是**容错**的：未知字段忽略、坏元素丢弃（面板不白屏）；但请按下述规格写，
保证导出 .pptx 的还原度。

```jsonc
{
  "version": 2,
  "meta": {
    "name": "演示文稿",
    "pagePreset": "16:9",   // "16:9" | "4:3" | "A4L"（新页框默认尺寸）
    "kind": "deck"          // "board" 白板 | "deck" 幻灯片；缺省按内容回退（旧档的 "ui" 只读不写）
  },
  "objects": [ /* 画布级元素：x/y 是画布绝对坐标，可负 */ ],
  "frames": [
    {
      "id": "s1",              // 可省略（自动补齐）；全文档内唯一
      "x": 80, "y": 80,        // 保留字段：幻灯片模式逐页编辑不消费页框坐标——可省略/保持原值，别为"摆放"改它
      "w": 1280, "h": 720,     // 省略取预设；范围 100–8000
      "type": "slide",         // 目前唯一合法值：slide（导出/放映对象）
      "name": "封面",           // 可选：缩略图栏页名，缺省显示页码
      "background": "#ffffff", // #rgb/#rrggbb 或 CSS 渐变串（导出降级为首个色值）
      "elements": [ /* 页内局部坐标，原点 = 页框左上角 */ ]
    }
  ]
}
```

- 白板坐标系：无限大、可负值，objects 之间互不要求对齐；页框 `x/y` 仅是存档字段，
  幻灯片模式一页铺一屏、不看坐标，摆放无意义（白板类型下页框根本不显示）。
- 预设对应尺寸：`16:9` → 1280×720，`4:3` → 1024×768，`A4L` → 1123×794。
- **v1 迁移**：老文档（`"version":1, "slides":[…]`）面板打开时自动转成 v2
  （slides→frames，objects=[]）并写回，且按内容亲和**自动进入幻灯片模式**。**新写一律用 v2**；不要混写两套字段。

### 所有元素共有的字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | string | `text` / `shape` / `image` / `mermaid` / `draw` / `embed` / `svg` / `table` / `chart` |
| `id` | string? | 省略则自动生成；保持稳定的键 |
| `x` `y` `w` `h` | number | 像素；坐标语义随容器（objects=画布绝对，frame 内=页框局部）；`w`/`h` 最小 1 |
| `opacity` | 0–1? | 缺省 1 |
| `rotation` | number? | 角度（顺时针），缺省 0 |
| `groupId` | string? | 编辑组：同容器内同组 id 的元素一起选中/移动/删除（一层不嵌套，导出无感知） |

### text —— 文本

```jsonc
{
  "kind": "text", "id": "t1", "x": 128, "y": 230, "w": 1024, "h": 144,
  "runs": [
    { "text": "季度路线图", "bold": true, "size": 64, "color": "#111827" },
    { "text": " · Q3", "size": 40, "color": "#0a84ff" }
  ],
  "align": "center",   // left | center | right，缺省 left
  "vAlign": "middle"   // top | middle | bottom，缺省 top
}
```

- run 字段：`text`（必填）、`bold`、`italic`、`underline`、`size`（1–400，画板像素，
  缺省 24）、`color`（#hex）、`font`（字体族名，见白名单）。
- 便捷写法：`"text": "纯文本"` 等价于单 run。换行直接放 `\n`（渲染 pre-wrap）。
- 一个文本框内多 run 是同一框内的行内混排；不同段落/样式请拆成多个 text 元素。

### shape —— 矩形/椭圆/多边形/直线/箭头

```jsonc
{
  "kind": "shape", "id": "r1", "shape": "rect",
  "x": 80, "y": 560, "w": 240, "h": 8,
  "fill": "#0a84ff",          // #hex 或 "none"；线类（line/arrow/double-arrow）无 fill
  "stroke": "#1d1d1f",        // #hex 或 "none"，缺省 none
  "strokeWidth": 2,           // 0–40
  "radius": 12                // 仅 rect：圆角像素
}
```

`shape` 取 `rect | ellipse | diamond | triangle | trapezoid | pentagon | hexagon | star | line | arrow | double-arrow`。
线类从 `(x,y)` 画到 `(x+w, y+h)`（w/h 用正值摆方向，导出仅按端点直线）；`arrow` 尾点单箭头、
`double-arrow` 两端箭头。多边形（diamond/triangle/trapezoid/pentagon/hexagon/star）按 bbox 内切
绘制，几何与 PowerPoint 预设形状对齐（star 内半径 0.382）。
线类通用 `curve` 弧度（[-1,1]，缺省/0＝直线）：以弦二次贝塞尔弯曲，正值沿行进方向逆时针拱
（水平弦向上拱），负值反向；箭头头沿切线。编辑器属性面板有滑杆可调。
（历史兼容：旧文档的 `curve-arrow` 载入时自动迁移为 `arrow` + `curve`，新档不要再写。）
线类可选 `pts` 折点数组（多点折线/折形箭头）：`"pts": [[x1,y1],[x2,y2],…]`，**相对包围盒
左上角**的局部坐标（一位小数，3–200 点）。≥3 点时线身走折线、`curve` 与 `dir` 对角语义被
忽略；包围盒应为全折点的并集（编辑器会按并集自动 rebase，写档时大致给对即可）。首/末点即
端点，仍可与 `startBind`/`endBind` 共存——绑定重算只换首末点，中间折点原样保留。
编辑器画布上选中折线后可拖顶点、拖段中点插入折点、Alt 点内部顶点删除。
线类可选**连线绑定**：`"startBind": "元素id"` / `"endBind": "元素id"`，端点吸附到**同一容器内**
（同一 objects 或同一 frame 的 elements）的该元素边缘。写档时端点几何可随意给，编辑器会自动重算
并随被绑元素移动跟随——给两元素连 `arrow` 就两端各绑一个，比手算坐标稳。

### image —— 图片

```jsonc
{ "kind": "image", "id": "i1", "src": "report.assets/diagram.png",
  "x": 640, "y": 120, "w": 480, "h": 320, "fit": "contain", "radius": 8 }
```

- `src` **必填**：工作区根相对路径（不是 URL、不是绝对路径）。
- `fit`：`cover | contain | stretch`，缺省 `cover`。
- 你把图生成/下载后放到 `<文档名>-assets/` 目录（用户在画布里拖入/粘贴图片时
  面板也自动落到该目录，命名如 `my-deck.assets/`）。面板按路径经宿主读取，
  文件缺失时显示占位框、导出不中断。

### mermaid —— 流程图/时序图等

```jsonc
{
  "kind": "mermaid", "id": "m1", "x": 320, "y": 160, "w": 640, "h": 400,
  "code": "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[跳过]\n  C --> E[结束]\n  D --> E",
  "theme": "follow"    // default | dark | neutral | follow（缺省 follow：跟随应用主题）
}
```

- `code` 必填：mermaid 源码，支持全部图类型（flowchart/graph、sequenceDiagram、
  pie、stateDiagram、gantt、classDiagram 等）。
- 渲染失败时画布显示「第 N 行：<源码行>」（用户可双击改代码），请保证代码可解析：
  换行用 `\n`，中文节点文本用 `[方括号]`/`(圆括号)` 包裹。
- **`style` 只认 subgraph/节点的 id，不认标题**——这是最常见的翻车点：
  `subgraph AI 层` 的 id 是 `AI`、`层` 是标题，所以 `style AI 层 fill:#111` 会报
  "Parse error"（第 N 行就是它）；要么写 `style AI fill:#111`，要么声明成
  `subgraph AIL[AI 层]` 再 `style AIL fill:#111`。节点同理：`A[设备层]` 用 `style A`。
- 导出 .pptx 时 mermaid 转 2× PNG 位图贴图（矢量信息丢失，属预期）。

### draw —— 钢笔手绘笔迹（用户在面板里用 P 键画；agent 也可代笔）

```jsonc
{
  "kind": "draw", "id": "d1", "x": 140, "y": 90, "w": 260, "h": 120,
  "points": [[0, 0], [26, 41], [63, 78], [110, 96], [168, 84], [222, 52], [260, 12]],
  "stroke": "#1d1d1f",   // #hex 或 "none"，缺省 #1d1d1f
  "strokeWidth": 3,      // 0.5–40，缺省 2（缩放笔迹时线宽不变）
  "opacity": 1
}
```

- `points` 必填（≥2 个 `[x,y]`）：相对**自然点盒**的折线采样点，首个点约在 (0,0)，
  最大跨度即包围盒；渲染/导出按 `viewBox=点盒 → 拉伸填满 w×h`，所以用户拉伸手柄后
  点集不变、笔迹整体拉伸。手写时用「先给点列、取点集包围盒作 x/y/w/h」最自然。
- 点集封顶 2000（超出解析时截断）；面板采样自带限距抽稀。少于 2 点的元素会被丢弃。
- 画布级或页内皆可放（用户在白板模式画的落 objects；在幻灯片模式画的落当前页，
  出页的一笔会被丢弃并提示）。导出 .pptx 转 2× PNG 透明贴图。
- 想表达手绘感批注（圈重点、箭头旁手写）可以写 draw；但正式图示优先 shape+text/mermaid。

### svg —— 内嵌 SVG 源码（生成矢量插画/图示的首选）

```jsonc
{
  "kind": "svg", "id": "sv1", "x": 480, "y": 200, "w": 480, "h": 360,
  "code": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 240 180\"><rect width=\"240\" height=\"180\" rx=\"16\" fill=\"#166534\"/><circle cx=\"120\" cy=\"90\" r=\"44\" fill=\"#f4f692\"/></svg>"
}
```

- `code` **必填**：完整 `<svg …>…</svg>` 源码（JSON 字符串内的引号记得转义）。
  **这就是"生成 SVG 插上画布"的正路**——源码直接进档，无需写资产文件；
  导出 SVG/HTML 保留矢量，导出 .pptx 转 2× PNG 贴图。
- 根标签请带 `viewBox`（宽高交给元素 `w/h` 约束、等比 contain 适配）。
- 经 `<img>` 沙箱渲染：**脚本不执行**（安全语义），含 `foreignObject`（HTML 排版进 SVG）
  的源码在桌面端（WKWebView）可能显示失败并给出错误提示——正式内容请用纯 SVG 图元
  （rect/circle/path/text…），需要 HTML 排版就用 text/shape 元素组合。
- 文字放 SVG 里用 `<text>` 可以，但导出 .pptx 时会被一并位图化；正式 PPT 页的标题正文
  仍优先 text 元素，svg 只承载图形/插画。
- **动画 SVG 可以放**：SMIL（`<animate>`/`<animateTransform>`/`<animateMotion>`）和
  CSS keyframes 动画在画布上正常播放；导出 SVG/HTML 保留动画，导出 .pptx 是静态帧
  （位图没有动画，向用户说明即可）。脚本依然不执行——想做交互动画请用 embed 嵌网页。

### embed —— 内嵌网页（tldraw 式 URL embed）

```jsonc
{ "kind": "embed", "id": "em1", "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "x": 400, "y": 160, "w": 640, "h": 400, "title": "产品演示视频" }
```

- `url` **必填**：http(s) 绝对地址。用户在画布上直接粘贴链接也会生成 embed（贴 URL 即嵌入）。
- 白名单 provider 自动转嵌入地址：YouTube / B站(BV) / Vimeo / Google 地图(带 q 参数) /
  Spotify / CodePen / CodeSandbox / Figma/FigJam / Excalidraw 分享页；其他 URL 原样内嵌
  （被站点 X-Frame-Options 拒绝时 iframe 里显示拒绝页，角标可看到 URL）。
- 交互模型：画布上单击选中、**双击进入网页交互**（播放视频等），Esc 或点画布空白处退出。
- ⚠️ 沙箱限制：桌面端面板本身是沙箱不透明源，嵌入页**无 Cookie/登录态**——
  需登录才能看的内容（如 bilibili 登录限定、Figma 私有文件）会显示登录墙，这是预期行为；
  公开内容（YouTube 公开视频、公开 Figma 文件等）正常。
- 导出 .pptx：圆角占位框 + provider 名 + 可点击原文链接（放映时可点开）；
  导出 SVG：链接卡片；导出 HTML：真活 `<iframe>` 可直接交互。选 `w/h` 尽量贴近
  内容比例（视频 16:9，如 640×360、640×400）。

### table —— 表格（双击编辑内容）

```jsonc
{
  "kind": "table", "id": "tb1", "x": 80, "y": 160, "w": 560, "h": 240,
  "rows": [
    ["指标", "Q2", "Q3"],
    ["营收", "120 万", "156 万"],
    ["毛利", "48%", "52%"]
  ],
  "colWidths": [2, 1, 1],  // 可选：列宽权重（与列数对齐），缺省均分
  "header": true,          // 可选：首行表头样式（加粗+底色），缺省 true
  "size": 18,              // 可选：字号 px，缺省 18（8–96）
  "fill": "#ffffff",       // 可选：单元格底色，缺省 #ffffff
  "headerFill": "#eef0f2", // 可选：表头底色，缺省 #eef0f2
  "stroke": "#d4d4d8",     // 可选：网格线色，缺省 #d4d4d8
  "color": "#1d1d1f"       // 可选：文字色，缺省 #1d1d1f
}
```

- `rows` 必填：二维字符串数组，行数即行数、列数取各行最大（上限 100 行 × 30 列，单元格 500 字符）。
- 画布上**双击进入单元格编辑**：点任意格原位输入，Enter 下移 / Tab 右移，可加删行列。
- 导出 .pptx 用原生表格（可编辑文本，非位图）；SVG/HTML 矢量保真。

### chart —— 数据图表（柱/折/饼/环，双击编辑数据）

```jsonc
{
  "kind": "chart", "id": "ch1", "x": 640, "y": 160, "w": 560, "h": 420,
  "chart": "bar",          // bar | line | pie | doughnut，缺省 bar
  "labels": ["一月", "二月", "三月", "四月"],
  "series": [
    { "name": "系列 A", "data": [12, 19, 8, 15] },
    { "name": "系列 B", "data": [6, 10, 14, 7] }
  ],
  "colors": ["#166534", "#f4f692"], // 可选：系列色（饼/环=扇区色），缺省内置色板按序循环
  "showLegend": true,      // 可选：底部图例，缺省 false
  "size": 12               // 可选：标签字号 px，缺省 12（6–48）
}
```

- `labels`（≤50 个类目）与 `series`（≤10 个系列、每个 ≤200 点）必填；
  **pie/doughnut 只取 series[0]**，labels 即扇区名。
- 画布上**双击弹出数据表单**：每行 = 类目 + 各系列数值，可增删类目与系列。
- 值轴自动取整刻度上限；饼/环自带百分比标注、0 值类目自动剔除；导出 .pptx 用原生图表
  （用户在 PowerPoint 里还能继续改数据），画布/SVG/HTML 为矢量绘制。

## 排版规范（写给面板里"好看"的经验值，按 1280×720 计）

- 安全边距 64–80px；标题区 top 80–200；正文起始 y ≥ 200。
- 字号阶梯：大标题 56–72，页标题 40–48，小节 28–36，正文 20–26，注/页脚 14–18。
- 正文行宽 ≤ 880px（约 40 个汉字一行），长段落拆多个文本框或换成要点。
- 配色对：深底（#111318）配 #f5f5f7 文字；浅底（#ffffff）配 #1d1d1f 文字；
  强调色一个就够（#0a84ff / #bf5af2 / #ff9f0a）。
- 字体白名单（跨平台 + .pptx 保真）：`PingFang SC`、`Microsoft YaHei`、
  `Noto Sans SC`、`Arial`、`Georgia`、`Courier New`；不设 `font` 即走系统默认栈。
- 元素叠放序 = 数组序（后写在上）；两模式各画各的，objects 与页内元素不存在相互遮挡。
  背景色块/装饰条放各页 elements 数组前面。
- 正文一律放页框 `elements`；`objects` 是白板模式的自由区（草稿、讨论、示意），
  除非用户要白板内容，别把正式正文写到 `objects`。

## 内置模板库（面板左侧「模板库」按钮，人工插入；落盘后就是普通页框）

面板自带模板库：8 套主题（晴川·白蓝 / 暖阳·奶油橘 / 夜航·深蓝青 / 曜金·墨黑金 / 青苔·苔绿 /
雾蓝·靛蓝 / 绯樱·樱粉 / 墨白·黑白红）× 14 个版式（封面/目录/章节页/三要点/四象限/时间轴/
对比/数据/要点列表/流程/问答/表格/金句/结尾），可插单页或整套 6 页起步（封面→目录→章节→
三要点→数据→结尾）。模板页与手画页无异：`frame.name` 形如「夜航 · 封面」，元素就是普通
text/shape——用户插入后要求改内容/加页，按普通页框处理即可。

- 用户让「换成 XX 主题风格」：模板库是 UI 侧插入，你（agent）不能调它；做法是 read 最新文件后
  按主题 token 改色重排（改背景 + 各元素颜色），别动元素 id。
- 主题 token（写新页想跟模板同风格时照抄）：底色/主字/次字/弱字/强调/副强调/浅强调底/面板/面板交替/线。
  晴川 `#ffffff/#17202a/#5d6b7a/#9aa7b5/#2563eb/#0e7490/#eaf1fe/#f5f7fa/#edf1f6/#e2e8f0`；
  暖阳 `#faf5ee/#2b2118/#7a6a58/#ab9a82/#de5b26/#a16207/#fae8dc/#f3eae0/#efe2d3/#e6d9c8`；
  夜航 `#0b1526/#edf2f7/#9fb0c3/#5d7188/#38bdf8/#a78bfa/#12344b/#132238/#182b47/#223852`；
  曜金 `#141311/#f2ebdd/#a79e8d/#6e675b/#d2a24c/#8c7853/#2e2415/#1e1c18/#262219/#312b21`；
  青苔 `#fbfdfb/#14231c/#55685e/#8fa398/#0e9f6e/#0f766e/#e3f4ec/#f0f7f3/#e6f1ea/#dce8e1`；
  雾蓝 `#f6f8fb/#1e293b/#64748b/#94a3b8/#4f46e5/#0891b2/#e0e7ff/#eef2f7/#e5eaf2/#dbe2ec`；
  绯樱 `#fff7f8/#2a1520/#8c6b76/#b99aa4/#e11d48/#7c3aed/#ffe4e9/#fdf0f2/#fbe4e9/#f4dde3`；
  墨白 `#ffffff/#141414/#57534e/#a8a29e/#d92626/#141414/#fdecec/#f5f5f4/#ebebea/#e5e5e3`。
  圆角：晴川/夜航/雾蓝 12，暖阳/青苔/绯樱 16，曜金 8，墨白 0（直角）；
  夜航/曜金配 mermaid `"dark"`，墨白配 `"neutral"`，其余 `"default"`。

## 放映与导出（幻灯片模式顶栏操作，向用户说明用）

- 放映 ▶ / 导出按钮只在**幻灯片模式**出现（白板模式没有 PPT 概念）。
- 放映：▶ 或 ⌘⇧F / F5，全屏；方向键/空格/点击翻页，Esc 退出。
  **只放 `type:"slide"` 的页框（数组序=页序），objects 不上屏。**
- 导出：↓ 生成 `<文档名>.pptx`（写到工作区、右下角提示位置）。
  **只导页框；objects（白板内容）有意不入档。** 有损近似要在答复里
  如实说明：渐变背景→纯色、字体按白名单替换、mermaid/手绘→位图、透明度近似、
  旋转支持任意角但重排无保证；svg 元素→2× 位图；embed→占位框+可点击原文链接。
  「导出 SVG / 导出 HTML」保留 svg 元素矢量；HTML 导出里 embed 是真活 iframe。
- 「问 AI」按钮：用户选中元素点它，会把元素 JSON 预填到对话输入框——
  收到这类请求时按上文工作流第 3 步（先 read 再改），并注意元素属于哪个容器
  （白板 objects 还是第 N 页 frame）。

## 示例（混合文档：涂鸦在白板模式，正式内容在幻灯片模式的两页里；页框 `x/y` 仅存档可省略）

```json
{
  "version": 2,
  "meta": { "name": "示例", "pagePreset": "16:9" },
  "objects": [
    { "kind": "text", "id": "n0", "x": -360, "y": 120, "w": 320, "h": 60,
      "runs": [{ "text": "讨论区：先聊清楚再上页 →", "size": 22, "color": "#ff9f0a" }] },
    { "kind": "draw", "id": "n1", "x": -20, "y": 240, "w": 180, "h": 60,
      "points": [[0, 30], [30, 6], [80, 2], [140, 10], [180, 30], [140, 52], [70, 58], [20, 48], [0, 30]],
      "stroke": "#ff9f0a", "strokeWidth": 3 },
    { "kind": "shape", "id": "n2", "shape": "arrow", "x": 170, "y": 260, "w": 160, "h": 40,
      "stroke": "#ff9f0a", "strokeWidth": 3 }
  ],
  "frames": [
    {
      "id": "s1", "x": 360, "y": 80, "w": 1280, "h": 720, "type": "slide", "name": "封面",
      "background": "#111318",
      "elements": [
        { "kind": "shape", "id": "d1", "shape": "rect", "x": 560, "y": 470, "w": 160, "h": 6,
          "fill": "#0a84ff" },
        { "kind": "text", "id": "t1", "x": 128, "y": 250, "w": 1024, "h": 140,
          "runs": [{ "text": "示例演示", "bold": true, "size": 72, "color": "#f5f5f7" }],
          "align": "center", "vAlign": "middle" },
        { "kind": "text", "id": "t2", "x": 240, "y": 520, "w": 800, "h": 48,
          "runs": [{ "text": "slide-canvas 无限画布生成", "size": 24, "color": "#8e8e93" }],
          "align": "center" }
      ]
    },
    {
      "id": "s2", "x": 1696, "y": 80, "w": 1280, "h": 720, "type": "slide", "background": "#ffffff",
      "elements": [
        { "kind": "text", "id": "t3", "x": 80, "y": 64, "w": 800, "h": 72,
          "runs": [{ "text": "三个要点", "bold": true, "size": 44, "color": "#1d1d1f" }] },
        { "kind": "shape", "id": "b1", "shape": "rect", "x": 80, "y": 180, "w": 12, "h": 64,
          "fill": "#0a84ff", "radius": 6 },
        { "kind": "text", "id": "t4", "x": 120, "y": 180, "w": 1000, "h": 64,
          "runs": [
            { "text": "文档即 JSON ", "bold": true, "size": 26, "color": "#1d1d1f" },
            { "text": "—— agent 与用户共同编辑同一文件，互不锁死。", "size": 26, "color": "#3a3a3c" }
          ], "vAlign": "middle" },
        { "kind": "mermaid", "id": "m1", "x": 240, "y": 320, "w": 800, "h": 340,
          "code": "graph LR\n  A[开发] --> B[评审]\n  B --> C[合并]\n  C --> D[发布]" }
      ]
    }
  ]
}
```

解析容错提醒：`kind` 未知的元素会被整块丢弃（`kind` 必须九选一：text/shape/image/mermaid/
draw/embed/svg/table/chart）；元素/页框的 `id` 可以省略，面板会自动补齐并写回；页框 `w/h` 会被夹到 100–8000。
