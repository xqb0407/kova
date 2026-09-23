---
name: slides
description: 用「无限画布 · 幻灯片」面板创作/修改画布文档：真·无限画布（白板元素自由摆放）+ PPT 页框（可放映、可导出 .pptx）。当用户想要演示文稿（PPT、slides、deck、路演、汇报页）、画布式涂鸦/示意板、或想在工作区里可视化继续编辑某个 .canvas.json 时使用。覆盖：文档 schema v2（objects 画布级元素 / frames 页框 / text/shape/image/mermaid/draw 元素）、生成→唤起面板→迭代的工作流、v1 迁移、排版规范与导出限制。
---

# Slides：无限画布 + PPT 页框

画布文档就是工作区里一个**普通的 JSON 文件**（约定名 `<名称>.canvas.json`），
你用现有工具（write / edit / read）直接读写它；用户在右侧「无限画布 · 幻灯片」
面板里实时看到渲染结果、可以手动继续编辑，也能一键放映 / 导出 `.pptx`。

**模型**：文档是一片无限画布，上面有两种东西——
- `objects`：**画布级元素**，绝对坐标直接落在无限空间（白板涂鸦、示意图、便签…），不进 .pptx；
- `frames`：**页框**（PPT 页），有位置和尺寸的可拖拽容器，框内元素用**局部坐标**，
  拖动页框内容自动跟随。**放映/导出只认 `type:"slide"` 的页框，数组序 = 页序。**
纯 PPT、纯白板、或"一页白板 + 两页正式"的混合文档都是合法形态。

## 工作流（按此顺序）

1. **创作**：把整份文档用 `write` 写到工作区，路径如 `roadmap-q3.canvas.json`
   （根目录或任意子目录均可；扩展名必须是 `.canvas.json`，面板按 `*.canvas.json` 认领文件）。
2. **唤起面板**：调用 `open_plugin_panel`，参数
   `plugin: "slide-canvas", panel: "canvas", path: "roadmap-q3.canvas.json"`。
   若报插件未安装，提示用户：设置 → 插件市场 → 安装 slide-canvas。
3. **迭代前必须先 `read`**：面板会把用户的手动编辑防抖写回同一个文件——
   你上次写的内容可能已被改动（页框也可能被用户拖走了）。永远基于最新文件内容做
   `edit`/`write`，你写盘后面板会自动刷新（若用户有未保存编辑，面板会弹冲突框由用户选择，不用你处理）。
4. 元素/页框 `id` 保持稳定：新增才生成新 id，改动既有内容不要换 id，
   否则用户画布上的选中态/撤销历史会错乱。

## 文档 Schema（version 2）

解析是**容错**的：未知字段忽略、坏元素丢弃（面板不白屏）；但请按下述规格写，
保证导出 .pptx 的还原度。

```jsonc
{
  "version": 2,
  "meta": { "name": "演示文稿", "pagePreset": "16:9" }, // "16:9" | "4:3" | "A4L"（新页框默认尺寸）
  "objects": [ /* 画布级元素：x/y 是画布绝对坐标，可负 */ ],
  "frames": [
    {
      "id": "s1",              // 可省略（自动补齐）；全文档内唯一
      "x": 80, "y": 80,        // 画布绝对坐标（用户可拖动页框左上角标签移动）
      "w": 1280, "h": 720,     // 省略取预设；范围 100–8000
      "type": "slide",         // 目前唯一合法值：slide（导出/放映对象）
      "name": "封面",           // 可选：画布角标/缩略图名，缺省显示页码
      "background": "#ffffff", // #rgb/#rrggbb 或 CSS 渐变串（导出降级为首个色值）
      "elements": [ /* 页内局部坐标，原点 = 页框左上角 */ ]
    }
  ]
}
```

- 画布坐标系：无限大、可负值；页框/元素互不要求对齐。多个页框若想整齐，按网格摆放
  （面板的「一键整理」即：从 (80,80) 起、间距 56、约 1.6:1 行列比）。
- 预设对应尺寸：`16:9` → 1280×720，`4:3` → 1024×768，`A4L` → 1123×794。
- **v1 迁移**：老文档（`"version":1, "slides":[…]`）面板打开时自动转成 v2
  （slides→等距网格摆放的 frames，objects=[]）并写回。**新写一律用 v2**；不要混写两套字段。

### 所有元素共有的字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | string | `text` / `shape` / `image` / `mermaid` / `draw` |
| `id` | string? | 省略则自动生成；保持稳定的键 |
| `x` `y` `w` `h` | number | 像素；坐标语义随容器（objects=画布绝对，frame 内=页框局部）；`w`/`h` 最小 1 |
| `opacity` | 0–1? | 缺省 1 |
| `rotation` | number? | 角度（顺时针），缺省 0 |

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

### shape —— 矩形/椭圆/直线/箭头

```jsonc
{
  "kind": "shape", "id": "r1", "shape": "rect",
  "x": 80, "y": 560, "w": 240, "h": 8,
  "fill": "#0a84ff",          // #hex 或 "none"；line/arrow 无 fill
  "stroke": "#1d1d1f",        // #hex 或 "none"，缺省 none
  "strokeWidth": 2,           // 0–40
  "radius": 12                // 仅 rect：圆角像素
}
```

`shape` 取 `rect | ellipse | line | arrow`；线/箭头从 `(x,y)` 画到 `(x+w, y+h)`
（w/h 用正值摆方向，导出仅按端点直线）。

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
- 渲染失败时画布原样显示错误文本（用户可双击改代码），请保证代码可解析：
  换行用 `\n`，中文节点文本用 `[方括号]`/`(圆括号)` 包裹。
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
- 画布级或页内皆可放。导出 .pptx 转 2× PNG 透明贴图。
- 想表达手绘感批注（圈重点、箭头旁手写）可以写 draw；但正式图示优先 shape+text/mermaid。

## 排版规范（写给面板里"好看"的经验值，按 1280×720 计）

- 安全边距 64–80px；标题区 top 80–200；正文起始 y ≥ 200。
- 字号阶梯：大标题 56–72，页标题 40–48，小节 28–36，正文 20–26，注/页脚 14–18。
- 正文行宽 ≤ 880px（约 40 个汉字一行），长段落拆多个文本框或换成要点。
- 配色对：深底（#111318）配 #f5f5f7 文字；浅底（#ffffff）配 #1d1d1f 文字；
  强调色一个就够（#0a84ff / #bf5af2 / #ff9f0a）。
- 字体白名单（跨平台 + .pptx 保真）：`PingFang SC`、`Microsoft YaHei`、
  `Noto Sans SC`、`Arial`、`Georgia`、`Courier New`；不设 `font` 即走系统默认栈。
- 元素叠放序 = 数组序（后写在上）；objects 层整体盖在所有页框之上。
  背景色块/装饰条放各页 elements 数组前面。
- 页框之外的画布是用户的自由区：不要把正文放画布绝对坐标上除非用户要白板。

## 放映与导出（用户在面板操作，向用户说明用）

- 放映：工具栏 ▶ 或 ⌘⇧F / F5，全屏；方向键/空格/点击翻页，Esc 退出。
  **只放 `type:"slide"` 的页框（数组序=页序），objects 不上屏。**
- 导出：工具栏 ↓ 生成 `<文档名>.pptx`（写到工作区、右下角提示位置）。
  **只导页框；objects（画布级元素/白板涂鸦）有意不入档。** 有损近似要在答复里
  如实说明：渐变背景→纯色、字体按白名单替换、mermaid/手绘→位图、透明度近似、
  旋转支持任意角但重排无保证。
- 页框摆放自由是特性：放映/导出与位置无关；用户可随时「一键整理」网格归位。
- 「问 AI」按钮：用户选中元素点它，会把元素 JSON 预填到对话输入框——
  收到这类请求时按上文工作流第 3 步（先 read 再改），并注意元素属于哪个容器
  （画布级 objects 还是第 N 页 frame）。

## 示例（白板 + 两页混合：涂鸦在画布上，正式内容在页框里）

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

解析容错提醒：`kind` 未知的元素会被整块丢弃（`kind` 必须五选一）；元素/页框的
`id` 可以省略，面板会自动补齐并写回；页框 `w/h` 会被夹到 100–8000。
