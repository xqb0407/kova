# 拆分「UI 设计画布」：新建独立 Figma 级 UI 设计引擎插件

## 背景与现状耦合（已探明）

- 当前"UI 设计"不是独立画布：`DocKind = "board" | "deck" | "ui"`，`ui` 只是给无限画布白板表面播了三个 375×812 圆角矩形种子（`slide-canvas/ui/src/editor/useEditorShell.ts:42` 原话："UI 设计档的编辑表面仍是无限画布，只是种子与徽标不同"）。共用 `*.canvas.json`、同一 Leafer stage、同一编辑器外壳；`office` 插件是同代码的拷贝，也带这套。
- 面板体系是通用的：`panels.json` 的 `opens` glob 认领文件（`*` 不跨路径分隔符）、`doc.list` 按面板自己的 glob 扫卡片墙、agent 写盘命中认领自动开板（sidecar `open-panel-tool.ts`）、`findPanelForFile` 按 glob 具体度路由。宿主/sidecar 无需特判即可承载新画布。

用户决策：落地为**独立新插件**（真正不共用画布）、第一版=**核心设计台**（多页+画板+图层+完整属性检视+变换/吸附/撤销，不含 auto-layout/组件/样式库）、**Figma 式专业编辑器外壳**、**复用 leafer-ui 引擎**。

## 一、新插件 `plugins/ui-design`（镜像 slide-canvas 工程约定）

```
plugins/ui-design/
  package.json            # react19 + leafer-ui + @leafer-in/editor@2.2.11 + @leafer-in/export + radix + lucide + tailwind4 + vite(singlefile)
  panels.json             # [{ id:"design", title:"UI 设计", entry:"design.html",
                          #    opens:["*.uidesign.json"], permissions:["document","export","agent","notify"] }]
  icon.svg / components.json
  design.html             # postbuild: cp ui/dist/index.html design.html
  ui/{index.html, vite.config.ts, tsconfig.json}   # 与 slide-canvas 同款单文件构建
  ui/src/
    main.tsx / App.tsx / index.css     # Figma 风格 token：中性灰 chrome + #0d99ff 强调色，深浅双主题（host theme.update 已支持）
    bridge.ts            # 从 slide-canvas 精简复用（doc 桥协议 kova-ui-plugin/1）
    doc.ts               # 设计文档模型 v1 + 容错解析 + 序列化（策略同 CanvasDoc：未知字段忽略/坏节点丢弃/数值钳制）
    state.ts             # useDesign：文档+选择(Set<nodeId>)+撤销重做(50 步/500ms 合并)+800ms 防抖保存+外部冲突框+剪贴板(子树复制)+增删改/成组/对齐分布
    geometry.ts          # 世界包围盒/变换矩阵/吸附候选（纯函数，单测覆盖）
    leafer/scene.ts      # 设计树→leafer 节点树按 key diff patch：frame=Box+clip、group、rect/ellipse/线/箭头/多边形/星形、text(runs)、image、fills(纯色/线性/径向渐变)、effects(投影/内阴影/层模糊)
    leafer/DesignStage.tsx  # 缩放平移(滚轮/空格/中键/H) + @leafer-in/editor 点选/框选/拖动/缩放/旋转/双击深选 + 智能参考线 & 距离标签 + 就地文本编辑 DOM overlay
    leafer/ledger.ts     # editor 节点变换 → 文档几何补丁（纯函数，参考已验证的同款 editorLedger.ts）
    chrome/Toolbar.tsx   # 顶部居中悬浮工具栏：移动V/画板F/形状R▾(矩形 椭圆 直线 箭头 三角 菱形 五边形 六边形 星形)/文字T/抓手H + 撤销重做
    chrome/FileMenu.tsx  # 左上文件 pill：文档名 · 回首页 · 导出 ▾ · 帮助
    chrome/LayersPanel.tsx # 左侧栏：图层树（展开/收起、👁显隐、🔒锁定、双击重命名、上移下移）+ 左下角页面切换下拉（新建/重命名页）
    chrome/Inspector.tsx # 右侧栏 Design 区：对齐行 · 位置尺寸(X/Y/W/H/旋转) · 不透明度 · 圆角(统一+四角) · 填充(增删/开关/颜色+渐变编辑) · 描边(色/宽/内中外对齐/虚线) · 阴影(外/内) · 文字(字号/字重/行高/字距/对齐) · 导出；设备预设画板（iOS 375×812 / 390×844、Android 360×800、平板、桌面 1440×900、自定义）
    chrome/ZoomBar.tsx   # 左下缩放 pill（− % + 适配⌘0 100%⌘1）
    Home.tsx             # 卡片墙(doc.list *.uidesign.json，缩略图=当前页画板布局) + 新建(命名+设备预设) + 「用 AI 生成 UI」(建档+预填提示词)
  ui/test/*.test.ts      # bun test：解析容错/序列化往返/ledger 变换/几何与吸附/对齐分布
  skills/ui-design/SKILL.md
```

**文档模型 `*.uidesign.json` v1**（独立扩展名，glob 与 `*.canvas.json` 零冲突）：`{ version, meta:{name,kind:"uidesign"}, activePage, pages:[{id,name,nodes:[树]}] }`；节点 = frame(clip+children)/group/形状/text(runs 复用现有口径)/image(src→`<档名>-assets/`，bridge.attach 落盘)，通用属性 x/y/w/h/rotation/opacity/visible/locked/fills[]/strokes[]/radius/effects[]。

## 二、宿主改动（apps/desktop，改动极小）

1. `lib/plugins/ui-plugin-bridge.ts`：`DocListItem.kind` 联合类型加 `"design"`。
2. `lib/plugins/canvas-doc-list.ts`：`kindOfPath` 识别 `.uidesign.json`→design；design 档摘要分支（名称/画板布局 preview/页框数=画板数/objects=节点总数；corrupt 语义不变）。
3. `plugins/marketplace.json`：加 `ui-design` 条目（拷贝装/链接装均走现有机制）。
sidecar 与面板"+"菜单零改动（通用认领/权限门控）。

## 三、无限画布侧解耦（去掉"共用"）

- **slide-canvas**：Home 移除「用 AI 生成 UI」与 ui 建档入口；`createDoc` 只收 board|deck；`docKindOf` 仍识别老档 `ui`（徽标改"UI 设计（旧）"），打开老 ui 档时顶部横幅提示 + 「让 AI 迁移」按钮（预填：按 ui-design skill 把圆角矩形画板转 frames、objects 平铺转画板子节点）；`uiStarterDoc` 移除、SKILL.md 删 ui kind 规范并注明去「UI 设计」面板。
- **office**：同步移除 Home 的 ui 创建项、`App.tsx` 转发文案改为指向新「UI 设计」面板、徽标同改。

## 四、Agent 契约（新插件 skills/ui-design/SKILL.md）

写骨架即自动开板（glob 认领机制）→ 逐画板 edit 迭代、每次落盘完整合法 JSON、id 稳定、迭代前先 read；附 schema 字段全表 + 常见组件（导航栏/卡片/按钮/列表）JSON 范例 + 出稿设计规范（8pt 栅格、字级阶梯、克制的色板），保证 agent 直接产出"像样"的界面稿而非乱摆矩形。

## 五、实施顺序

- **P1** 脚手架+doc.ts 模型/解析/单测，构建跑通
- **P2** leafer 渲染+交互核（选/变/撤销/保存/冲突）+ bridge + Home + 宿主 design 支持
- **P3** 外壳全量（工具栏/图层树/页面/Inspector 各分区/文本编辑/右键菜单）
- **P4** 吸附参考线+距离标签、对齐分布、PNG/SVG 导出、快捷键、Figma 视觉细节打磨
- **P5** 老画布解耦清理 + 两份 SKILL.md + 迁移横幅
- **P6** 验证：各插件 `typecheck`/`build`/`bun test`；desktop typecheck；手动闭环（市场装插件→建档→AI 生成逐画板上屏→手动编辑→回写→重开）

## 六、第一版明确不含

Auto-layout、共享颜色/文字样式、组件/实例、constraints、钢笔矢量、连线原型、标尺参考线、协同。（文档 version 化，后续迭代不破坏格式。）

## 风险

- 嵌套坐标系的编辑器变换回写是最易翻车点 → `ledger.ts` 纯函数 + 单测，且仓库已有同构成熟实现（`editorLedger.ts`）可参照。
- 新插件是独立 pnpm workspace，需先在插件目录装依赖（镜像 slide-canvas 的 lock 结构）。