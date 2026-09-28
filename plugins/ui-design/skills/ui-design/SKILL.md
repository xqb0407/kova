---
name: ui-design
description: 用「UI 设计」面板创作/修改 UI 设计稿：独立文档格式 *.uidesign.json（Figma 式图层树：页面 → 画板 frame → 子节点），画板/图层树/属性检视（填充/渐变/描边/圆角/阴影/文字）+ 吸附对齐 + PNG/SVG 导出；插件自带 `ui-design` MCP 工具（增删改节点/对齐/堆叠排版/成组/页面管理），结构化编辑优先走 MCP。当用户想做 App 页面、移动端/桌面界面稿、原型、落地页视觉稿、组件库画板，或提到"设计稿/UI/界面/figma 式"并期望在工作区可视化编辑时使用。旧「无限画布」的 kind:"ui" 档由 slide-canvas 面板的「让 AI 迁移」转成本格式。
---

# UI 设计：Figma 式设计引擎（*.uidesign.json）

设计稿是工作区里一个**普通 JSON 文件**（约定名 `<名称>.uidesign.json`）。两条控制路径：

1. **MCP 工具（结构化编辑优先）**：插件自带 `ui-design` MCP server，直接对文档做增删改 /
   对齐分布 / 堆叠排版 / 成组 / 页面管理——和面板共用同一套文档模型与几何，改完即落盘、
   面板约半秒内自动刷新（见下节）。
2. **直接读写文件**：用 write / edit / read 整档读写（骨架起草、批量创意内容最顺手）。
   面板按 `*.uidesign.json` 认领文件：**你 write 一份合法骨架落盘，宿主就自动开板并绑定它**，
   之后每次落盘约半秒后重渲染——用户全程看着画面长出来。

两种方式可混用；切换前先读到最新状态（用户在面板里也可能正在改）。

**模型**：文档 = 页面（pages）→ 图层树（nodes）。三个容器语义：
- **frame（画板）**：一块设备尺寸的画布（390×844 等），子节点**局部坐标**（原点 = 画板左上角），
  默认超框裁切（`clip:false` 可关）。一个界面稿 = 若干画板横排。
- **group（组）**：纯组织节点，自身 x/y/w/h 由子节点并集派生（写进去也会被重算），子坐标相对组包围盒。
- 其余是叶子：rect / ellipse / triangle / diamond / pentagon / hexagon / star / line / arrow / text / image。

坐标一律是**父容器局部坐标**；rotation 绕自身盒中心；所有数值允许小数（面板按 0.01 舍入）。

## 控制面：MCP 工具（结构化编辑优先）

插件启用即自带 `ui-design` MCP server（无需用户配置；设置 → MCP 可见「ui-design」条目）。
agent 统一经 `mcp` 网关调用：

1. `mcp({ action: "search", query: "design" })` → 拿全名（`ui-design__add_nodes` 等）
2. `mcp({ action: "describe", tool: "ui-design__add_nodes" })` → 看参数 schema
3. `mcp({ action: "call", tool: "ui-design__add_nodes", args: "{ … }" })` → 执行（args 为 JSON 字符串）

| 工具 | 用途 |
|---|---|
| `list_docs` | 列工作区里的设计档（找目标档先跑它） |
| `read_doc` | 图层树摘要（id/盒/填充/文字）/ 单节点完整 JSON；**编辑前先读拿最新 id** |
| `create_doc` | 按设备预设建档（多画板可一次建，自动横排） |
| `add_nodes` | 批量加节点；`parent` 给画板/组 id 即画板内局部坐标；x/y 省略自动落位 |
| `update_nodes` | 按 id 批量改：x/y 绝对值或 dx/dy 位移、name/尺寸/旋转/透明度/圆角/填充/描边/文字… |
| `delete_nodes` | 按 id 删（含子树） |
| `group_nodes` / `ungroup_nodes` | 成组 / 拆组（子节点坐标自动换算） |
| `align_nodes` | 对齐 / 等距分布（left/hcenter/right/top/vcenter/bottom/hdist/vdist；可指定画板为参照） |
| `stack_nodes` | 行 / 列堆叠排版（列表、导航栏、卡片流；gap + 交叉轴对齐） |
| `reorder_nodes` | z 序：front/back/forward/backward |
| `edit_pages` | 页面：add/rename/activate/remove |

**纪律**：
- 挪位置、改颜色、对齐、排版这类结构化改动**优先用 MCP**（校验 + 几何计算 + 原子落盘，比手改 JSON 稳）。
- **每次 MCP 调用会走用户审批**：把一屏的多个节点合并进单次 `add_nodes` / `update_nodes` 调用。
- 骨架起草、一次性铺大量内容仍可用 `write`（不弹审批、自动开板）。
- 面板导出（PNG/SVG）由用户在文件菜单操作，MCP 不提供导出。
- 插件未装/未启用时 MCP 不可用——退回下面的直接读写流程，schema 完全相同。

## 工作流（按此顺序）

1. **骨架先落盘**：`create_doc`（MCP）或 `write` 一份完整合法 JSON——`meta` + 页面 + 全部画板
   frame（含画板名与底色）。⚠️ 骨架必须第一步就落盘、且是**完整有效**的 JSON（面板容错解析，
   坏节点会被丢弃、坏文件整份不可用）；`write` 路径会自动开板，`create_doc` 路径可补一次
   `open_plugin_panel(plugin="ui-design", panel="design", path=…)`。
2. **逐画板填充**：优先 `add_nodes`（parent=画板 id）；节点多、样式重复时也可整档 `edit`。
   落盘一次上屏一次；**已有节点的 `id` 必须保持稳定**（选择、撤销、增量编辑都按 id diff）。
3. **迭代**：用户说"把主按钮改成绿色"→ `read_doc` 找 id → `update_nodes` 只改它
   （或 read + edit 落盘）。

## Schema 字段全表

```jsonc
{
  "version": 1,
  "meta": { "name": "健身 App", "kind": "uidesign" },   // kind 恒为 "uidesign"
  "activePage": "p1",
  "pages": [
    { "id": "p1", "name": "首页", "nodes": [ /* 顶层节点：通常是画板 */ ] }
  ]
}
```

**所有节点共有**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一，自己起短名（"nav"、"btn-cta"）；缺省自动补，但**迭代靠它定位，务必写** |
| `name` | string | 图层树显示名 |
| `type` | string | frame/group/rect/ellipse/triangle/diamond/pentagon/hexagon/star/line/arrow/text/image |
| `x` `y` | number | 父容器局部坐标（页面级 = 画布绝对坐标） |
| `w` `h` | number | 盒尺寸（1–20000） |
| `rotation` | number | 度，绕盒中心；缺省 0 |
| `opacity` | number | 0..1，缺省 1 |
| `visible` / `locked` | boolean | 缺省 true / false |
| `radius` | number \| [tl,tr,br,bl] | 圆角（rect/frame/image 生效），0..4096 |
| `effects` | Effect[] | 见下 |
| `onTap` | `{ "to": "画板id" }` | 原型交互：单击跳转（见「交互原型」节）；缺省无 |

**Effect**：
- `{ "type": "drop-shadow", "color": "#00000022", "x": 0, "y": 4, "blur": 12 }`
- `{ "type": "inner-shadow", ... 同上 }`
- `{ "type": "layer-blur", "blur": 8 }`

**Fill**（`fills: Fill[]`，数组序 = 叠放序，第一个在最下）：
- 纯色：`{ "type": "solid", "color": "#0d99ff", "opacity": 1 }`（color 支持 #rgb/#rrggbb/#rrggbbaa）
- 线性渐变：`{ "type": "linear", "angle": 180, "stops": [{ "at": 0, "color": "#ff7a59" }, { "at": 1, "color": "#7a5cff" }] }`
  （angle 顺时针度数，0 = 自上而下；stops 2–8 个）
- 径向渐变：`{ "type": "radial", "center": { "x": 0.5, "y": 0.5 }, "stops": [...] }`
- `visible: false` = 隐藏但保留

**Stroke**（`strokes: Stroke[]`）：`{ "color": "#e6e6e6", "width": 1, "align": "inside" | "center" | "outside", "style": "solid" | "dashed" | "dotted", "visible": true }`

**各类型专属**：
- `frame`：`children: DesignNode[]`、`fills`（画板底色）、`strokes?`、`clip?`（缺省 true）、`preset?`（设备预设键，仅记录）
- `group`：`children`
- `text`：`runs: [{ "text", "size"?, "weight"?, "color"?, "italic"?, "underline"?, "font"? }]`（多 run = 混排样式，自动换行按盒宽）、`align?: left|center|right`、`vAlign?: top|middle|bottom`、`lineHeight?`（倍数，缺省 1.4）、`letterSpacing?`（px）
- `line` / `arrow`：`strokes`（必填至少一条）、`dir?: 0|1|2|3`——端点在盒内的走向：**0=↘ 1=↗ 2=↖ 3=↙**（缺省 0）。画"从 A 到 B 的箭头"：盒取两点包围盒，dir 按 B 相对 A 的象限选
- `image`：`src`（workspace 相对路径，通常 `<档名>-assets/xxx.png`）、`fit?: cover|contain|stretch`（缺省 cover）、`strokes?`

设备预设（画板常用尺寸）：`ios-375` 375×812、`ios-390` 390×844、`android-360` 360×800、
`tablet-768` 768×1024、`desktop-1440` 1440×900、`watch-168` 168×184。

## 交互原型（onTap：让稿子能点）

任何节点可加 `"onTap": { "to": "<顶层画板id>" }`——**单击该节点跳转到目标画板那一屏**。
面板「预览原型」（P 键 / 文件菜单）与「导出 HTML 原型」共用这套数据。

- `to` 指向**页面级的顶层 frame** 的 id（跨页可跳；指向普通节点/嵌套 frame/已删 id = 死链，
  预览里红圈提示、HTML 导出里自动丢弃）。
- 热点 = 节点自身盒子（含组内嵌套偏移自动累加）；节点或其祖先 `visible:false` 则整支不响应。
- 跳转挂在**按钮整块**（含文字的容器矩形）上，别只挂文字；返回箭头/底部 tab 各挂各的。
- 出多屏流程稿时**主动接好线**：首页卡→详情、详情返回→首页、tab 互跳、CTA→下一步，
  让用户按 P 就能顺着点完整个流程。

```jsonc
// 首页的主按钮跳到详情页（详情页 = 同档另一个顶层画板）
{ "id": "btn-cta", "name": "主按钮", "type": "rect", "x": 24, "y": 740, "w": 342, "h": 48, "radius": 24,
  "fills": [{ "type": "solid", "color": "#0d99ff" }],
  "onTap": { "to": "page-detail" } }
```

## 常见组件 JSON 范例

**顶部导航栏**（画板 390 宽，栏高 48，标题居中）：
```jsonc
{ "id": "nav", "name": "导航栏", "type": "rect", "x": 0, "y": 44, "w": 390, "h": 48, "fills": [{ "type": "solid", "color": "#ffffff" }] },
{ "id": "nav-title", "name": "标题", "type": "text", "x": 0, "y": 44, "w": 390, "h": 48, "align": "center", "vAlign": "middle",
  "runs": [{ "text": "今日训练", "size": 16, "weight": 600, "color": "#111111" }] },
{ "id": "nav-back", "name": "返回", "type": "arrow", "x": 12, "y": 58, "w": 20, "h": 20, "dir": 2, "strokes": [{ "color": "#111111", "width": 2 }] }
```

**主按钮**（圆角胶囊 + 居中文字）：
```jsonc
{ "id": "btn-cta", "name": "主按钮", "type": "rect", "x": 24, "y": 740, "w": 342, "h": 48, "radius": 24,
  "fills": [{ "type": "solid", "color": "#0d99ff" }] },
{ "id": "btn-cta-label", "name": "按钮文字", "type": "text", "x": 24, "y": 740, "w": 342, "h": 48,
  "align": "center", "vAlign": "middle", "runs": [{ "text": "开始训练", "size": 16, "weight": 600, "color": "#ffffff" }] }
```

**卡片**（白底圆角 + 投影 + 内嵌图文）：
```jsonc
{ "id": "card-1", "name": "课程卡", "type": "rect", "x": 24, "y": 140, "w": 342, "h": 96, "radius": 16,
  "fills": [{ "type": "solid", "color": "#ffffff" }],
  "effects": [{ "type": "drop-shadow", "color": "#00000014", "x": 0, "y": 2, "blur": 8 }] },
{ "id": "card-1-title", "type": "text", "name": "卡片标题", "x": 40, "y": 156, "w": 200, "h": 22,
  "runs": [{ "text": "燃脂 HIIT · 20min", "size": 15, "weight": 600, "color": "#111111" }] },
{ "id": "card-1-sub", "type": "text", "name": "卡片副文", "x": 40, "y": 182, "w": 260, "h": 36,
  "runs": [{ "text": "高强度间歇，无需器械", "size": 13, "color": "#8a8a8e" }] },
{ "id": "card-1-thumb", "type": "rect", "name": "缩略图占位", "x": 288, "y": 156, "w": 64, "h": 64, "radius": 12,
  "fills": [{ "type": "linear", "angle": 135, "stops": [{ "at": 0, "color": "#ff7a59" }, { "at": 1, "color": "#ff3f8e" }] }] }
```

**列表分隔线**：`{ "id": "sep-1", "type": "line", "name": "分隔线", "x": 24, "y": 260, "w": 342, "h": 0.5, "strokes": [{ "color": "#e6e6e6", "width": 1 }] }`

## 出稿设计规范（像样，不是乱摆矩形）

- **8pt 栅格**：边距、间距、尺寸尽量取 8 的倍数（图标/文字盒可用 4 的倍数）；画板左右安全边距 16 或 24。
- **字级阶梯**（移动端）：大标题 24–28 / 标题 17–20 / 正文 14–15 / 辅助 12–13；层级差至少 2px，别满屏同字号。
- **字重**：标题 600–700、正文 400；辅助信息用颜色降阶（#8a8a8e）而不是加字重。
- **色板克制**：一个主色 + 中性灰阶（#111111 / #8a8a8e / #e6e6e6 / #f5f5f5 / #ffffff）；渐变只用在强调面（CTA、封面卡）。
- **对齐**：同列元素左缘对齐；卡片/按钮圆角档位统一（如 8/12/16/胶囊四档取其二）；投影统一一组参数。
- **画板排布**：画板之间水平留 120+ 间距；每块画板左上角放一块小文本标注屏名（如"首页"，size 12，#8a8a8e，画板外 y-24）。
- **文本盒要给足宽高**：text 按盒宽自动换行、按行高占位——宽高给小了会被裁。中文按字断行、英文按词。

## 边界与禁忌

- ❌ 不要写 `*.canvas.json` 来当 UI 稿——那是无限画布/幻灯片面板的格式；UI 设计稿**只认 `*.uidesign.json`**。
- ❌ 未知字段会被忽略、坏节点会被静默丢弃（面板不白屏），所以字段名照本表写、别自创。
- ❌ group 的 x/y/w/h 不要手工"摆位置"——它由子节点并集派生；要移动整组就改子节点坐标。
- ✅ 用户要真实图片：让用户拖图进面板（落 `<档名>-assets/`），或先用其它工具生成图片文件再在 image.src 引用。
- ✅ 迁移旧档：旧「无限画布」的 kind:"ui" 档（objects 平铺 + 圆角矩形画板）→ 读它，把每块圆角矩形画板转成
  `frame`（取矩形 x/y/w/h，radius 可留 0），画板内的 objects 按坐标换算成画板局部系的子节点。
