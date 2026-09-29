---
name: ui-design
description: 用「UI 设计」面板创作/修改 UI 设计稿：独立文档格式 *.uidesign.json（Figma 式图层树：页面 → 画板 frame → 子节点），画板/图层树/属性检视（填充/渐变/描边/圆角/阴影/文字）+ 吸附对齐 + PNG/SVG 导出；插件自带 `ui-design` MCP 工具（增删改节点/对齐/堆叠排版/成组/页面管理/画布截图自检/export_doc 导出工程包=静态文件目录包+路径清单），结构化编辑优先走 MCP。当用户想做 App 页面、移动端/桌面界面稿、原型、落地页视觉稿、组件库画板，或提到"设计稿/UI/界面/figma 式"并期望在工作区可视化编辑时使用。旧「无限画布」的 kind:"ui" 档由 canvas 面板的「让 AI 迁移」转成本格式。
---

# UI 设计：Figma 式设计引擎（*.uidesign.json）

> **开工前**：按目标平台先 `use_skill` 加载对应规范技能再动笔——iOS 用
> `ios-design-guidelines`、Android/Material 用 `material-design-guidelines`、
> 跨平台通用或拿不准取值用 `mobile-design-tokens`（字号/间距/触控/圆角/色板直接照抄其数值）。

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
- **instance（组件实例）**：指向文档级组件库 `components`（主档）的引用，渲染 = 主档展开 + 覆盖；见「组件与实例」节。
- 其余是叶子：rect / ellipse / triangle / diamond / pentagon / hexagon / star / line / arrow / text / image / icon / vector。

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
| `screenshot_doc` | **把画布内容渲染成 PNG 以图像返回**（非屏幕截图，截的是文档）。缺省截当前页全部可见顶层节点，`ids` 可只截某画板；改稿后自检构图/配色/文字排布；给 `saveTo` 时同时把 PNG 落盘到工作区路径并回报 |
| `boolean_nodes` | **布尔运算**：2+ 个同容器同层形状 → 合并为一个 vector。`operation`：union 并集 / subtract 减去（第一个减其余）/ intersect 交集 / exclude 排除（别名 merge/minus/xor）。结果烤平为路径、继承第一个节点的填充描边 |
| `apply_layout` | 对画板重排**自动布局**（按 frame 的 layout 字段与子节点 grow 重算子项位置尺寸，含嵌套与祖先链）。结构改动后 add/update 已自动重排；手动挪过子项想恢复排布时用它 |
| `list_icons` | 搜索内置 lucide 图标名（icon 节点的 `icon` 字段取值）：query 前缀/子串匹配 + 别名折算（home→house）。要放界面小图标先搜再加节点 |
| `list_components` | 组件库盘点：每个组件的 id/名称/主档节点 id/包围盒/被引用实例数 |
| `create_component` | 把 1+ 个同层节点转成组件：主档进 `components` 表，原位替换为 1:1 实例（返回 componentId/instanceId/masterNodeIds） |
| `edit_component` | 组件操作：`insert` 再插实例 / `patch_master` 改主档（所有实例联动）/ `rename` / `reset_overrides` 清除覆盖 / `detach` 分离为普通图层 / `remove` 删主档（`detach:true` 先把引用烘焙成普通图层，不留占位） |
| `import_doc` | **设计档导入**：把另一份 `*.uidesign.json`（`from`）并入 `path`——页整体追加、id 全量重发、组件表并入且实例 `componentId`/`overrides` 引用同步重映射；`pageNames?` 按页名选入子集（缺省全并）。返回导入的页/组件/节点计数与警告。与面板「导入设计档…/拖放 JSON」同一管线；源文件含未支持坏页只并可用页并警告 |
| `edit_variables` | **共享颜色变量（设计 token）**：`list` 盘点（含每变量被引用次数、坏引用清单）/ `set` 新建或更新（改 value **全稿联动**——所有绑定处的填充/描边/文字/图标颜色实时换）/ `delete` 删除（`detach:true` 先把引用烘焙为当前色值）。绑定 = 颜色字段写 `"var:<变量id>"`（add_nodes/update_nodes 原生支持，链式引用 ≤4 层） |
| `export_doc` | **导出交付产物 = 一个静态文件目录包**（源档副本 + 逐画板 `screens/NN-画板.png` + 外链位图 `assets/` + 可点原型 `index.html` + `manifest.json` 路径清单），落盘工作区并返回全部文件路径。`format` 选 png/svg/html/source/code 子集（code = 每画板一份 CSS 标注，Dev Mode）、`dir` 定目录、`scale`/`maxDim` 控位图尺寸、`background` 画幅底色（缺省透明）。面板「导出工程包」走同一装配器，产物一致 |

**纪律**：
- 挪位置、改颜色、对齐、排版这类结构化改动**优先用 MCP**（校验 + 几何计算 + 原子落盘，比手改 JSON 稳）。
- **每次 MCP 调用会走用户审批**：把一屏的多个节点合并进单次 `add_nodes` / `update_nodes` 调用。
- 骨架起草也走 MCP（`create_doc` frames 数组一屏一调用）；**只有 MCP 不可用时才退回 `write`
  裸写 JSON**——工具的逐步校验远比"写完一整份再赌它对"可靠。
- **写严格 JSON，但写坏也有兜底**：尾逗号/注释/``` 围栏/单引号/裸键名/中文引号/截断会被
  解析层自动修复（面板提示"已自动修复"，MCP read 正常）；颜色可用色名与 rgb()/rgba()，
  `cornerRadius`/`fontSize` 等别名也认——但别依赖兜底，修正写法。未知 `type` 的节点会被
  跳过并在警告里报出。
- 视觉自检用 `screenshot_doc`（图像直接上屏给你看；`saveTo` 可顺带存单图）；**要交付静态文件
  产物用 `export_doc`**——它不是给你一个文件，而是落盘一整个目录包（源档/逐画板位图/外链
  资产/可点原型/manifest），把返回的路径清单讲给用户即可。用户自己动手则走面板文件菜单
  （PNG/SVG/HTML 原型/导出工程包）。
- **你的写盘现在是一步可撤销历史**：用户本地干净时 MCP 改动直接上屏且 ⌘Z 一步回退你的全部改动
  （用户有未保存本地改动时会弹冲突框、你的写暂不生效）。临近交付别连环写盘——重要节点先跟用户
  确认，防止对方一个撤销把你的成果撤没。
- 插件未装/未启用时 MCP 不可用——退回下面的直接读写流程，schema 完全相同。

## 工作流（按此顺序）

1. **骨架用 MCP 建**：`create_doc` 一次建全部画板（frames 数组，x 省略自动横排）。**不要用
   `write` 手搓 JSON 起稿**——LLM 手写长 JSON 是格式问题的主要来源（字段猜错/尾逗号/截断），
   而工具调用每一步都校验、坏参数当场报错可自纠。`write` 仅当 MCP 不可用时兜底（写坏也有
   修复层兜底，但别依赖）。`create_doc` 后可补 `open_plugin_panel(plugin="ui-design",
   panel="design", path=…)` 开板。
2. **逐画板填充**：优先 `add_nodes`（parent=画板 id）；节点多、样式重复时也可整档 `edit`。
   落盘一次上屏一次；**已有节点的 `id` 必须保持稳定**（选择、撤销、增量编辑都按 id diff）。
3. **迭代**：用户说"把主按钮改成绿色"→ `read_doc` 找 id → `update_nodes` 只改它
   （或 read + edit 落盘）。
4. **视觉自检**：一屏成型后 `screenshot_doc`（可 `ids` 只截某个画板）拿到渲染图，
   核对构图/配色/文字是否溢出或错位——不满意就回到第 3 步调，满意再交付。
   注意：截图里文字折行为近似测量，与面板可能有极轻微差异；位图资产读不到会画灰占位。
5. **交付产物**（用户要"导出/给我成品/静态文件"时）：`export_doc` 落盘工程包目录，回报
   路径清单——`<目录>/index.html` 浏览器直接打开可点原型，`screens/*.png` 逐画板高清图，
   `manifest.json` 是全部静态文件的路径/尺寸/字节清单。单张预览图走 `screenshot_doc` 的
   `saveTo` 即可，别为一张图开一包。

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
| `type` | string | frame/group/rect/ellipse/triangle/diamond/pentagon/hexagon/star/line/arrow/text/image/icon/vector/instance |
| `x` `y` | number | 父容器局部坐标（页面级 = 画布绝对坐标） |
| `w` `h` | number | 盒尺寸（1–20000） |
| `rotation` | number | 度，绕盒中心；缺省 0 |
| `opacity` | number | 0..1，缺省 1 |
| `visible` / `locked` | boolean | 缺省 true / false |
| `radius` | number \| [tl,tr,br,bl] | 圆角（rect/frame/image 生效），0..4096 |
| `effects` | Effect[] | 见下 |
| `onTap` | `{ "to": "画板id" }` | 原型交互：单击跳转（见「交互原型」节）；缺省无 |
| `mask` | boolean | 用作蒙版：自身不绘制，几何裁剪同容器内位于其上方的兄弟（头像/卡片遮罩常用） |
| `grow` | number | 父画板开了自动布局时的弹性权重：0 固定，>0 按权重瓜分主轴剩余空间 |
| `blendMode` | string | 混合模式：multiply/screen/overlay/darken/lighten/color-dodge/color-burn/hard-light/soft-light/difference/exclusion/hue/saturation/color/luminosity（缺省 normal） |
| `flipX` / `flipY` | boolean | 水平/垂直镜像（绕盒中心，画布与导出一致） |

**Effect**：
- `{ "type": "drop-shadow", "color": "#00000022", "x": 0, "y": 4, "blur": 12 }`
- `{ "type": "inner-shadow", ... 同上 }`
- `{ "type": "layer-blur", "blur": 8 }`（iOS 毛玻璃：模糊其**背景**，卡面本体保持清晰。画布/导出侧不渲染该模糊，只保留半透卡面；CSS 代码面板输出 `backdrop-filter`。别指望它糊掉卡片自身）

**Fill**（`fills: Fill[]`，数组序 = 叠放序，第一个在最下）：
- 纯色：`{ "type": "solid", "color": "#0d99ff", "opacity": 1 }`（color 支持 #rgb/#rrggbb/#rrggbbaa）
- 线性渐变：`{ "type": "linear", "angle": 180, "stops": [{ "at": 0, "color": "#ff7a59" }, { "at": 1, "color": "#7a5cff" }] }`
  （angle 顺时针度数，0 = 自上而下；stops 2–8 个）
- 径向渐变：`{ "type": "radial", "center": { "x": 0.5, "y": 0.5 }, "stops": [...] }`
- 图片填充：`{ "type": "image", "src": "<档名>-assets/pic.png", "scaleMode": "fill" | "fit" | "stretch" }`
  （任意 rect/ellipse 可用图片做填充——头像圆、卡片底图首选；`fill`=裁剪铺满 缺省）
- `visible: false` = 隐藏但保留

**Stroke**（`strokes: Stroke[]`）：`{ "color": "#e6e6e6", "width": 1, "align": "inside" | "center" | "outside", "style": "solid" | "dashed" | "dotted", "visible": true }`

**各类型专属**：
- `frame`：`children: DesignNode[]`、`fills`（画板底色）、`strokes?`、`clip?`（缺省 true）、`preset?`（设备预设键，仅记录）、`layout?`（**自动布局**，见下节）
- `group`：`children`
- `text`：`runs: [{ "text", "size"?, "weight"?, "color"?, "italic"?, "underline"?, "font"? }]`（多 run = 混排样式，自动换行按盒宽）、`align?: left|center|right`、`vAlign?: top|middle|bottom`、`lineHeight?`（倍数，缺省 1.4）、`letterSpacing?`（px）
- `line` / `arrow`：`strokes`（必填至少一条）、`dir?: 0|1|2|3`——端点在盒内的走向：**0=↘ 1=↗ 2=↖ 3=↙**（缺省 0）。画"从 A 到 B 的箭头"：盒取两点包围盒，dir 按 B 相对 A 的象限选
- `image`：`src`（workspace 相对路径，通常 `<档名>-assets/xxx.png`）、`fit?: cover|contain|stretch`（缺省 cover）、`strokes?`
- `icon`：**内置 lucide 矢量图标**（界面小图标一律用它，别拿 image/emoji 凑）。`icon`（图标名，
  用 `list_icons` 搜，1848 个；`home`/`shopping-cart`/`user`/`chevron-right`…）、`color?`（描边色，
  缺省 #111111）、`strokeWidth?`（缺省 2，24 栅格单位随盒放大）。画布/导出/截图三端一致渲染，
  未知名画"?"占位（截图文本会提示）
- `vector`：**自由矢量路径**（布尔运算/钢笔的产物）。`path`（节点局部坐标的 SVG d 串）、
  `fills`/`strokes` 照常。`boolean_nodes` 运算后自动生成
- `instance`：**组件实例**——`componentId`（指向 `doc.components` 表）+ `overrides?`
  （`{ "<主档节点id>": { 字段: 值 } }`，只存差异）。见「组件与实例」节

设备预设（画板常用尺寸）：`ios-375` 375×812、`ios-390` 390×844、`android-360` 360×800、
`tablet-768` 768×1024、`desktop-1440` 1440×900、`watch-168` 168×184。

## 自动布局（layout：导航栏/列表/卡片的正解）

画板声明 `layout` 后，子元素由重排引擎接管排布（结果写回 x/y，画布/导出/截图三端一致）：

```jsonc
{
  "id": "nav", "type": "frame", "x": 0, "y": 0, "w": 390, "h": 56,
  "layout": {
    "mode": "h",                    // "h" 横排 | "v" 竖排（必填）
    "gap": 12,                      // 子项间距，缺省 0
    "padding": [12, 16, 12, 16],    // 内边距 [上,右,下,左]；数字 = 四边统一
    "main": "between",              // 主轴：start(缺省)/center/end/between(两端)
    "cross": "center",              // 交叉轴：start(缺省)/center/end/stretch(拉满)
    "wrap": true,                   // 放不下自动折行（行距同 gap；开 wrap 时 hug 主轴失效）
    "hug": "cross"                  // 随内容收缩：main/cross/both（手动改尺寸会被重排覆盖）
  },
  "children": [
    { "id": "logo", "type": "icon", "icon": "menu", "w": 24, "h": 24 },
    { "id": "title", "type": "text", "text": "首页", "w": 200, "h": 24 },
    { "id": "spacer", "type": "rect", "w": 10, "h": 10, "grow": 1 },  // 弹性占位
    { "id": "avatar", "type": "ellipse", "w": 32, "h": 32,
      "fills": [{ "type": "image", "src": "my-assets/face.png" }] }   // 图片填充头像
  ]
}
```

- 子项 `"grow": n`：>0 按权重瓜分主轴剩余空间（导航栏中撑开、列表填满都靠它）；0 = 固定
- **结构化改动（add/update 宽高、增删子项）会自动重排**；手动挪过子项后用 `apply_layout` 恢复
- 不支持 wrap/HUG；给画板固定 w/h，让 grow 去分配内部空间

## 组件与实例（components：主档 + 复用）

组件库是文档顶层的 `components` 表，**不在任何画板上**（主档节点不占页面树，画布不渲染）：

```jsonc
{
  "pages": [{ "id": "p1", "name": "首页", "nodes": [
    { "id": "i1", "name": "主按钮", "type": "instance", "x": 24, "y": 740,
      "w": 342, "h": 48,                 // w/h 省略或 0 = 自动取主档包围盒（推荐写 0 跟随主档）
      "componentId": "cBtn",
      "overrides": {                     // key = 主档内的原始节点 id，只存差异字段
        "lbl": { "runs": [{ "text": "开始训练", "size": 16, "weight": 600, "color": "#ffffff" }] }
      } } ] }],
  "components": [
    { "id": "cBtn", "name": "主按钮",
      "nodes": [ /* 普通子树（frame/rect/text…），id 稳定，寻址全靠它 */ ] }
  ]
}
```

- **实例 = 主档展开 + 覆盖**：`overrides` 按主档原始 id 记 diff（整体替换该字段）；
  `id`/`type`/`children` 不接受覆盖（写入被静默剥离）。文字改内容可走速记 `{ "text": "新文案" }`。
- **`/` 寻址（视图 id）**：实例渲染时内部节点 id 重编为 `"<实例id>/<主档id>"`（如 `i1/lbl`）。
  `read_doc` 默认树已自动展开实例，直接抄这些 id；`update_nodes` 传 `/` id 即**写覆盖**
  （字段值是显示坐标口径，工具自动换算回主档坐标存档）。`delete_nodes` 拒绝 `/` id（先 detach）。
- **缩放联动**：实例 w/h 相对主档包围盒的倍率即渲染缩放（几何/字号/圆角/描边宽同比放大）；
  覆盖里写的尺寸同样是显示口径、存回时除以倍率。改实例 w/h 就能整体放大缩小组件。
- **嵌套实例**：主档里可以再放别的实例，视图递归展开（≤6 层），`/` 链式寻址（`i9/a2/b1`）。
- **坏引用**：`componentId` 指向已删组件 → 画布画虚线占位框标「组件缺失」，不崩档；
  删主档前用 `edit_component remove detach:true` 把引用烘焙成普通图层即可避免。
- **交互语义（Figma 式）**：画布上**单击任意内部图形选中的是整个实例**，实例整体可拖/缩/旋；
  内部节点不能画布直拖——编辑内部走图层树点选 + Inspector（属性改动自动落到覆盖），
  或 MCP `/` id。面板侧：右键「创建组件 / 分离实例 / 重置覆盖」，Inspector 有主档信息块。

MCP 闭环：`list_components` 盘点 → `create_component`（同层节点转主档 + 原位实例）→
`update_nodes id="i1/lbl"` 改覆盖 → `edit_component insert` 加实例 / `patch_master` 改主档
（**所有实例联动更新**，返回 instancesAffected）/ `detach` 分离 / `remove` 删除。

## 导入（图片 / SVG / 设计档）

面板与 MCP 共用同一管线（`svg-import.ts` / `merge.ts` 纯函数），**每个文件 = 一个 commit = 一步可撤销**：

- **面板入口**：文件菜单「导入图片… / 导入 SVG… / 导入设计档…」（均可多选），或把文件直接
  **拖放到画布**——落在光标处的世界坐标；图片按真实像素落（边长封顶 1024 等比缩），SVG 包成
  一个 frame，设计档 JSON 走页并入。
- **MCP 入口**：`import_doc` 并设计档（id 重发 + 组件/实例引用重映射，见上表）；SVG/图片没有
  专用 MCP 工具，让用户拖进画布或走文件菜单。
- **SVG 支持是有限子集**：rect/circle/ellipse/line/polyline/polygon/path/text + g/a/switch
  容器；transform 全烘焙进几何（带旋转的矩形退化为 vector 路径）、path 相对命令转绝对、
  opacity/fill-opacity 合成进颜色的 alpha。**渐变/蒙版/滤镜/内嵌位图/use 不支持**——跳过并
  给警告；文字基线按 -0.8em 近似（可能 1–3px 偏差）。要精确还原先在矢量编辑器里展开为路径。
- **设计档并入规则**：所有 id 重新分配（永不冲突）、`activePage` 保持当前页、目标档内容零改动；
  坏 JSON / 无可用页 → 整体报错不落盘。

## 共享颜色变量（var: 引用：改一处全稿换色）

档级 `variables` 表（`{id, name, value, desc?}`）+ 任意颜色字段写 `"var:<id>"` 引用——
填充/描边/渐变色标/文字 run/图标/阴影色都认（画布/导出/CSS 三端渲染期解析，改 value 实时联动，
撤销一步回退）。语义色/品牌色/灰阶 token 一律走它，别在每个节点手抄 hex。

- **建表**：`edit_variables set {name, value}` → 返回 id；同名报错（面板侧自动加序号）。
  value 可再写 `var:<另一id>` 链式引用（≤4 层，循环/坏引用渲染为警示粉 #e8506e 并在解析警告里报）。
- **绑定**：`update_nodes`/`add_nodes` 把 `fill`/`stroke`/`color`（图标）/`runs[].color` 写成
  `"var:<id>"` 即可，无专用绑定工具；`edit_variables list` 的 usage 即引用计数（改前先看影响面）。
- **换肤**：`set {id, value}` 一发全稿换色——这是变量的全部意义；逐节点 update 是反模式。
- **删除**：默认引用处变警示粉（红=待修信号）；要保留外观用 `detach:true` 烘焙当前色值再删。
- 面板侧：左侧栏「变量」页签管理（增改删/引用数）；Inspector 填充/描边/文字/图标行的链接钮
  绑定或「存为变量并绑定」；`import_doc` 并档时变量 id 重发、引用自动改写、重名自动序号。

## 钢笔绘制（面板工具，产物 = vector 节点）

工具栏「钢笔」（暂无快捷键，P 被原型预览占用）：点击落直角锚、按住拖出平滑曲线柄（镜像）、
Enter/双击收笔、Esc 取消、Backspace 撤上一锚。
**回路闭合（PS 式）**：≥3 锚后游标悬进首锚 8px 内 → 出现闭合原型（锚点+游标围成的填充面实时预览、
靶标圈、光标变为带圈）；此时点下即闭合成形。
收笔 = 单次 addNode `vector` 节点（盒局部坐标 `path`），一步撤销；语义分两种——
**闭合=形状**（默认灰填充 #d9d9d9、无描边，同 Figma 新形状）/ **开放=线稿**（2px 深描边、无填充）。
MCP 侧照常可读写它（`update_nodes` 改 `path`/颜色/填充，或直接布尔）。
锚点编辑浮层（选中后拖锚/拖柄、线上加点、删锚）为下一档；在此之前需要改形请用
`update_nodes` 直接改 `path`，或删除重画。

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
- ❌ 别绕过组件系统直接 `edit` 整档去改 `overrides` 里的主档坐标口径——用 `update_nodes "实例id/内部id"`
  （视图口径，工具负责换算）；也别试图删实例内部节点，先 detach 成普通图层再删。
- ✅ 用户要真实图片：让用户拖图进面板（落 `<档名>-assets/`），或先用其它工具生成图片文件再在 image.src 引用。
- ✅ 迁移旧档：旧「无限画布」的 kind:"ui" 档（objects 平铺 + 圆角矩形画板）→ 读它，把每块圆角矩形画板转成
  `frame`（取矩形 x/y/w/h，radius 可留 0），画板内的 objects 按坐标换算成画板局部系的子节点。
