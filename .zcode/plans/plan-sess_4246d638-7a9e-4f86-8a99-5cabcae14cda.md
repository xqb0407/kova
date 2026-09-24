# 计划：@leafer-in/editor 全套接管 slide-canvas 交互（leafer 轨），验证后同步 office

## 背景与已核实事实
- `@leafer-in/editor@2.2.11` 与现有 `leafer-ui@2.2.11` 版本精确对齐；pnpm 布局下与 leafer-ui 共享同一份 `@leafer-ui/draw`/`core` 实例（无“双内核”风险），它自带的 peer `@leafer-in/resize` 会一并装。安装用 exact 版本钉死。
- 现 Leafer 轨：`new Leafer({ view, hittable: false })` 纯显示画布（pointer-events 关），命中/拖拽/overlay 全在 CanvasStage 的 DOM 侧手写。
- 插件能力（读源码确认）：`Editor`（可 `registerEditTool` 按形状定制外置把手、`registerInnerEditor` 内置编辑）、`EditorEvent.SELECT/MOVE/SCALE/ROTATE/GROUP/UNGROUP`（无 *_END，拖动结束 = core `DragEvent.END/MoveEvent.END`，官方 TransformTool 同款口径）、config：selector/editBox/hover/select/multipleSelect/boxSelect/moveable/resizeable/rotateable/skewable/手柄样式/dragBounds 限幅/animate。编辑器挂 `app.sky`（屏幕空间：画布缩放时把手不放大）。

## 架构：doc 仍是唯一数据源
```
doc(JSON) ─(scene.ts 纯函数)→ leafer 节点(patch by key, node.tag=elId)
   ↑ END 时回写                          │ 拖动中 editor 直接改节点(不回写)
DeckStore.commit → syncBoundArrows → patch 收敛（幂等）
```
- 编辑器全权处理：点选 / Shift 多选 / 框选 / 拖动 / 8 向缩放 / 旋转 / 组内编辑；deck 页内 `dragBounds` 限制不出页。
- 提交时序：操作过程零提交；`DragEvent.END/MoveEvent.END` 时把节点最终几何（世界坐标）反变换回 **frame-local doc 坐标**（新增纯函数模块 `editorLedger.ts` 做快照→patch，含旋转语义换算 CSS 顺时针↔leafer angle），一次 commit（多选=一个撤销步）→ 现有 undo/重做、syncBoundArrows 自动跟随全部原样生效。
- 键盘全部留在 stage 层（editor `keyEvent:false`）：删除/⌘Z/⌘D/方向键 nudge/⌘A 走现有 store 动作，再反向 `editor.set()` 同步选中。

## 保留的自研语义（不走默认把手）
1. **两点线/箭头**：`registerEditTool` 自定义线工具 = 首末两个端点把手，端点拖拽保留现有“重锚/解绑”绑定逻辑（unbindPatch），Shift 方向吸附照旧；隐藏默认 8 向把手。
2. **折线（pts≥3）**：自定义 PointsEditTool = 顶点圆点 + 段中点◇插入 + Alt 删点 + 15° 吸附——把本轮 DOM 版 node 数学（rotVec/rebasePoly/scalePolyPts）原样移植到把手事件里。
3. **就地编辑**：text/table/chart/mermaid/svg/embed 双击 → 仍开现有 DOM 编辑器（editor `openInner:false`，由 SELECT+双击自行路由，位置用 world→screen 换算）；embed 激活层的指针遮罩机制保留。
4. DOM overlay 的选择框/旋转柄等通用件**退场**，样式统一交给 editor config（描边色对齐 --accent、pointSize/hideOnSmall）。

## 分阶段（每阶段收尾都跑 tsc + bun test + build）
- **P0 底座**：装依赖（exact 2.2.11）；交互三态开关 `dom | leafer | leafer-editor`（localStorage `slide-canvas.interact`，灰度期默认仍走老 leafer 轨，不破坏现状）；LeaferStage：`hittable:true`、canvas 指针开、创建 Editor 挂 sky、节点带 `tag=elId`、新增 `onEditorCommit(patches)` 回调 prop；wheel/空格平移留在 stage 容器层不回归。
- **P1 基础变换打通**：select/move/scale/rotate/多选/框选/组 → editorLedger 回写 → commit/undo → 绑定箭头跟随；`editorLedger.ts` 纯函数单测（移动/缩放/旋转换算/翻转/多选批/frame-local/折线）。手工冒烟 + 现有 168 测试不回退。
- **P2 定制工具**：线端点工具 + 折线 PointsEditTool（移植 node 数学与交互细节：死区、中点插入、Alt 删除、3→2 点塌缩回 bbox+dir）。
- **P3 就地编辑与边角**：双击路由 DOM 编辑器；Inspector/右键菜单与 editor 选中集双向同步；nudge/对齐按钮走既有动作后回灌 editor 选择框刷新。
- **P4 灰度默认开 + 同步 office**：自测与冒烟全过后把 leafer-editor 设为 leafer 轨默认；随后把同一套改动应用到 office（deck-only，改动面更小）并验证（office 测试同样 168 基线）。

## 测试与验收
- 单测：editorLedger（doc↔node 几何换算全表）、既有 polyline/bind/export 测试不动；`tsc -p ui/tsconfig.json`、`bun test ui/test`、`npm run build`。
- 冒烟清单：①拖动/缩放/旋转即跟手且松手一次成历史步（⌘Z 一步回退）；②移动被绑定箭头的目标 → 箭头重锚跟随；③框选+成组+组内编辑；④端点拖拽保持绑定语义；⑤折线顶点/中点/Alt 删点与 DOM 版手感一致；⑥双击文本/表格进入原位编辑；⑦deck 页内拖动不出页框（dragBounds）；⑧undo/redo/加载文档后把手状态不残留。

## 风险与对策
- **编辑器 live 改节点 vs doc→patch 双写抖动**：END 才回写 + 提交后 patch 幂等收敛（doc 值来自节点终值，天然无回弹）；若仍有瞬时错位，拖动期间对受影响节点抑制 scene patch（已有 key-diff 结构可局部跳过）。
- **旋转/翻转语义不一致**：换算集中在 editorLedger 一个纯函数层，用现有 bakePolyRotation/resizeRotated 的测试基线校验（CSS 顺时针 vs leafer angle）。
- **版本漂移**：editor 与 leafer-ui 精确钉 2.2.11；升级需成对验证（写入注释）。
- **bundle 体积**：editor+resize 约 +百 KB 级，对 6.5MB 单文件面板影响可忽略。
- **双引擎分叉成本**：P4 向 office 同步是复制粘贴级（结构同源），成本已计入。

## 不做的事
- 不换掉 DOM 渲染轨（dom 模式保留为兜底）；不动导出/放映链路；不引入 editor 的内置文字 InnerEditor（继续用我们体验更好的 DOM 文本编辑）。