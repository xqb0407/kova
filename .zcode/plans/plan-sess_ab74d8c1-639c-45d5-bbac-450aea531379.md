# ui-design：补齐撤销/重做可靠性 + 导入能力

## 侦查结论（为什么"感觉没有撤销"、导入为零）

- 撤销机制已存在（state.ts commit/undo/redo、⌘Z/⌘⇧Z/⌘Y、工具栏按钮），但有两个真实缺陷：
  1. **快照污染 bug**：`mutatePage`（state.ts:321）把当前文档的活节点数组直接传进回调，`setLayout`/`reflow`/`booleanSelected` 及其依赖的 `reflowWithin`（layout.ts 直接 `c.x =`）都是就地变异 → commit 里 `serializeDoc(docRef.current)` 的"改前"快照已含改后值，这类操作撤销无效。
  2. **MCP/外部写盘清空历史**：onDocOpen external 分支 `applyDoc(..., {freshReset:true})`（state.ts:276）——agent 每落一次盘用户撤销栈全没。
- 导入完全没有：`insertImageFile`（state.ts:862）已实现但零 UI 入口；FileMenu 只有导出；SVG/设计档 JSON 无导入；MCP 无 import 工具。

## 一、撤销/重做修复（ui/src/state.ts）

1. mutatePage 的 fn 改收 `structuredClone(p.nodes)`——就地变异方自然被修好，不可变方零影响。
2. 新增 `applyExternalWrite(parsed)`（bridge external 分支改调它，store 暴露供探针用）：
   - 首次载入仍 freshReset（避免撤销退到空白档）；序列化相同→return；本地脏→维持冲突框；
   - 本地干净→当前态入 past、future 清空、应用外部态且 **markDirty=false、不再回写盘**；此后 ⌘Z 一步回退 agent 改动（undo 自带 sendSoon，最后写者赢）。
3. undo/redo 后按新文档修剪选择集（含 `/` 视图 id；activePage 变了清空）。
4. HISTORY_MAX 50→100。
5. App.tsx 暴露 `window.__designStore`（同 DesignStage.tsx:159 `__designLeafer` 风格，探针依赖）。

## 二、导入

1. **ui/src/merge.ts**：`mergeImportedDoc(target, incoming)` 纯函数——页/节点/组件 id 全 uid 重发，实例 `componentId` 与 `overrides` 的 key（主档原始 id）同步重映射（含嵌套实例链）。
2. **ui/src/svg-import.ts**：纯 TS 不依赖 DOMParser（bun 可测）——最小 XML tokenizer + `svgToNodes()`：svg/g/rect/circle/ellipse/line/polyline/polygon/path/text；translate/scale/rotate/matrix 任意仿射烘焙进几何（带旋转的矩形退化为 vector；path 相对命令先转绝对再变换，弧 A 端点变换+rx/ry 近似）；fill/stroke 色经 doc.ts 解析器、opacity 合成 alpha；text 基线近似 -0.8em；渐变/蒙版/滤镜/image 不支持→纯色兜底+warnings；产出单个 `frame("SVG 导入")`。
3. **store.importFiles(files, at?)**：按扩展分流（图片→insertImageFile 并改按真实像素≤1024 等比；.svg→svgToNodes；.json→parse+merge），每文件一步 commit=一步撤销。
4. **UI 挂点**：FileMenu 三项「导入图片…/导入 SVG…/导入设计档…」+ 隐藏 file input；DesignStage 根 div onDragOver/onDrop → importFiles 落在光标世界坐标；App 编辑器根兜底 preventDefault 防浏览器导航。
5. **MCP 平权**：新工具 `import_doc {path, from, pageNames?}`（读两档→merge→saveDoc，返回导入页/组件/节点计数），进 TOOL_DEFS。
6. 新纯函数放 ui/src 即被 mcp 复用（mcp/tools.ts:45 已直接 import ui/src/doc）。

## 三、测试与验证

1. ui/test/undo-import.test.ts：SVG 解析/映射/变换烘焙数值、merge 的 id+overrides+嵌套实例重映射。
2. mcp/test/import.test.ts：import_doc 端到端（tmp 档、页子集、覆盖读回一致、坏 JSON 报错）。
3. 探针 scripts/verify-undo-import.mjs（playwright，模式同 verify-components.mjs）：
   - setLayout→undo 字段与几何都回退、redo 重放（钉死快照污染 bug）；
   - 真实键盘 ⌘Z/⌘⇧Z 对方向键 nudge 生效；
   - applyExternalWrite→单步撤销回旧档；
   - importFiles：SVG File→画布出节点且一步全撤；JSON merge→新页+实例覆盖仍解析（读 scene 键）；截图 out-undo-import.png。
4. 三道闸门：`bun test ui/test mcp/test`、`tsc --noEmit -p ui/tsconfig.json`、`pnpm build`。
5. SKILL.md：工具表加 import_doc；新增「导入」小节；控制面纪律补"外部写盘已可撤销，⌘Z 会覆盖 agent 改动"。

## 已知边界（报告明示）

- 外部写可撤销仅限本地干净时；脏了仍走冲突框。撤销步无名称标签（"Undo Move"级不在本档）。SVG 子集限制见上。不碰并行会话的 paint.test.ts；scene.ts 若需改动仅限拖放挂点所需最小面。

执行顺序：撤销修复→纯函数+单测→store/UI→MCP+测试→探针→闸门→SKILL.md+中文报告。