# slide-canvas 渲染层迁移 LeaferJS（只换渲染 + 双轨开关）

## 已定决策
- 深度：**只换元素渲染层**为 Leafer canvas；选中框/手柄/吸附线/框选/文本编辑保持现有 DOM 实现，交互与命中测试代码（geometry 纯函数路径）不动。
- 回退：`localStorage["slide-canvas.renderer"] = dom|leafer` 双轨开关，像素达标后默认切 leafer，稳定一版再删 DOM 分支。
- 依据：leafer-ui 2.2.11 MIT、2026-09 仍在发版；`@leafer-in/editor` 亦 MIT（P5 之后如需全交互化有路可走）。

## 不动的面（摸底结论）
doc.ts / geometry.ts / state.ts(useDeck) / bridge.ts（桥协议）/ export.ts（doc→pptx 与渲染无关）/ Presentation.tsx 与缩略图（复用 DOM SlideView）/ ui/test 38 例 / App.tsx 全部 chrome。

## 改动文件（均在 plugins/slide-canvas/ui/src）
1. **viewspec.ts（新，纯函数）**：元素 → 渲染无关规格（文本字体栈/字号/行高/对齐/换行参数；shape/draw 的 SVG path d；image fit→裁剪；mermaid 异步 svg）。把 render.tsx 里的计算逻辑（`textRunsStyle`、ShapeElView 路径、DrawElView d、FONT_STACK）抽出；DOM ElView 改为消费 viewspec，视觉零变化。
2. **leafer/scene.ts（新）**：viewspec → leafer 节点树 diff/patch（按元素 id keyed；每 artboard 一个 Group，z 序=数组序，rotation→rotate）。纯映射、可单测。
3. **leafer/LeaferStage.tsx（新）**：挂 Leafer App；world Group 的 transform 与现有 `v.tx/v.ty/v.s` 同步（overlay 定位代码原样可用）；图片/mermaid 资源复用 render.tsx 的 assetCache 与 mermaid 缓存。
4. **CanvasStage.tsx（改）**：仅渲染段（903-1253）按开关分叉：dom=现 JSX；leafer=`<LeaferStage/>`+现有 DOM overlay 层。pointer/hit/wheel/pen/textedit 全部不动。
5. **package.json**：`pnpm add leafer-ui`（保留 pnpm-lock.yaml）。

## 阶段
- **P0** 装依赖 + 构建预算验证（现 6.13MB，leafer 约 +300KB，红线 8MB）
- **P1** viewspec 抽取 + ElView 改消费（回归门=现有截图逐像素一致）
- **P2** LeaferStage 静态渲染（deck 单页 + board 两 surface）
- **P3** 动态 parity：拖拽 liveMap 实时 patch、旋转、图片/mermaid 异步、hover 高亮、切页、空态
- **P4** E2E 像素 diff harness：v2/v1/blank 三档 × dom/leafer 双截图 PIL 对比（AA 容差），全绿后默认 leafer
- **P5（后续单独提交）** 稳定一版后删 DOM 渲染分支

## 风险与对策
- 字体度量 canvas≠DOM：同一 FONT_STACK + 显式 line-height；差异大则 viewspec 统一出测量参数逐行排版
- WKWebView/Safari 16.4+：leafer 纯 2D canvas，兼容
- 双渲染器漂移：viewspec 单一事实源，DOM 与 leafer 同吃一份

## Gates
`pnpm typecheck`；`bun test ui/test`（新增 viewspec/scene 用例）；`pnpm build` <8MB；8937 e2e 双渲染像素 diff + 功能清单回归（拖拽/缩放/旋转/吸附/框选/文本编辑/钢笔/图片拖入粘贴/缩放适配/切页/放映/pptx 导出）。

## 约束
不 commit 用户 queue-v2 WIP；桥协议与宿主代码不动；pnpm 管依赖。