# slide-canvas 重设计：真·无限画布（PPT 只是画布上的一种页框）

## 问题定性

现在的模型是「PPT 编辑器」：`CanvasDoc = { slides: [{elements}] }`，一切元素必须活在某页里，页的位置由系统网格自动排布。你要的是 **Figma/Excalidraw 式无限画布**：空白处随便画、随便放，**PPT 页只是画布上可自由拖动的「页框(frame)」，是画布的一个功能而非全部**。

## 新文档模型（version 2）

```jsonc
{
  "version": 2,
  "meta": { "name": "…", "pagePreset": "16:9" },
  "objects": [ /* 画布级元素：绝对坐标，直接落在无限空间 */ ],
  "frames": [
    { "id": "s1", "x": 80, "y": 80, "w": 1280, "h": 720,   // 位置入档，自由摆放
      "type": "slide", "name": "第 1 页", "background": "#fff",
      "elements": [ /* 仍是页内局部坐标 */ ] }
  ]
}
```

- **层级容器（Figma 式）而非扁平坐标**：frame 内元素保持局部坐标 → 拖动页框内容自动跟随、导出/放映/缩略图逻辑几乎原样保留（frames 就是今天的 slides + x/y）。
- 新增元素 kind `draw`（钢笔手绘）：`{ kind:"draw", x,y,w,h, points:[[x,y]…], stroke, strokeWidth, opacity?, rotation? }`，points 相对包围盒。
- **v1 容错迁移**：`parseDoc` 见 `slides` 数组 → 转 frames（x/y 用现有 gridLayout 落位后持久化）、objects=[]。写回一律 v2。宿主只透传 JSON 字符串（已核实零解析），桥协议/面板认领不动。
- 绘制序：frames 按数组序 → 画布级 objects 在其上（objects 数组序）。导出/放映只认 `type:"slide"` 的 frames（数组序=页序）；objects 不进 pptx。

## 实施分期（每期可独立验证）

**第 1 期 · 模型与状态层（纯逻辑）**
- doc.ts：`DrawEl`、`Frame`、`CanvasDoc v2`、`parseDoc` 双版本容错 + 迁移、`serializeDoc`、`blankDoc/blankFrame/titleFrame` 改造。
- state.ts：`sel = { containerId: "root"|frameId, elIds }`；updateEl/setElements/deleteSelected/duplicate/nudge/align/distribute/z 序/copy/paste 全部容器化；新增 `addFrame/moveFrame/tidyLayout/insertDraw`；undo/commit 机制不变（整档快照）。
- 新单测：v1→v2 迁移、draw 包围盒、canvas↔local 换算往返、tidyLayout 幂等。

**第 2 期 · 画布层（CanvasStage/render）**
- 画板位置改读 `frame.x/y`（不再每帧算网格）；objects 层渲染在 viewport 内绝对坐标。
- 命中序：objects → 页内元素 → 页框 → 空白；几何统一换算到画布空间再比较（顺带修掉上轮发现的真 bug：marquee 用画布坐标 rect 对比页内局部 boxOf，细元素会漏选）。
- 页框移动：每个 frame 左上角一个名称标签（页码/名字），**拖标签=整框移动**（wrapper transform 实时预览，pointerup 提交）；框内空白拖拽仍是框选、单击仍是聚焦页——现有交互语义不变。
- 选中浮条/手柄/旋转/吸附对 objects 与 frame 内元素一致工作。

**第 3 期 · 钢笔工具**
- 左工具栏加「钢笔」模式（P 快捷键）；按下后 pointerdown 起笔采样点（画布空间，实时 SVG 预览），抬起提交 `draw`：落点在页框内→进该页 elements，否则→进 objects。Esc 取消。
- render.tsx：draw 用平滑二次曲线 SVG 渲染；resize 提交时按 w/h 重采样 points。
- export.ts：draw → SVG 转 PNG 贴图（复用 mermaid 的 svgToPng 路径），pptx 还原。

**第 4 期 · 外壳与契约**
- 工具栏：插入文本/形状/图片/mermaid 在**无聚焦页时落视口中心成为画布级元素**；新增「插入页框」按钮；SlidesRail 加「一键整理」（tidyLayout 网格归位）；右键菜单补「整理布局/新增页框」。
- Inspector：元素面板对 objects 同样工作；页面板编辑聚焦 frame。
- **SKILL.md 重写为 v2**：objects/frames/draw schema、迁移说明、示例更新（含一份「白板 + 两页」混合示例）、排版规范保留。
- E2E 宿主 serve.mts：保留 v1 DECK（验证迁移后导出仍是 2 页 pptx）+ 增补 v2 混合文档用例。

**第 5 期 · 验收**
- geometry/doc 单测全绿；`pnpm typecheck`；`pnpm build`（<8MB）；E2E 冒烟（握手/迁移/导出 pptx 结构校验）；截图新状态（画布级元素+手绘线/页框自由摆放/整理前后/深浅色）交 visual-judge；sidecar 767 + desktop 214 回归。

## 不动的东西

桥协议与宿主代码、面板认领 glob（`*.canvas.json`）、放映全屏交互、导出坐标换算（px/96）。

## 风险

- sel 形态 `slideId→containerId` 波及面广——第 1 期先把 state 层收敛，UI 层第 2 期统一改。
- 手绘点集过大：采样限距 + 2000 点封顶，超出自动抽稀。
- objects 与 frames 的选中/吸附规则复杂度：吸附候选只含同容器 + 页框边缘，避免全画布两两比较。