# ElasticPanelResize

React + TypeScript 的弹性面板缩放组件。按 1000×1000 设计基准绘制一个右侧空面板：鼠标 / 触屏 / 键盘共用同一套状态，拖动时把手弯曲、整体偏移，越界只有最多 15px 橡皮筋；松手后弹簧回位并按离开规则隐藏。

**这是一个 React 入口，不是 Vue/Svelte/Solid/Preact 多框架包。** 非 React 入口已移除。

## 文件

| 文件 | 作用 |
| --- | --- |
| `ElasticPanelResize.tsx` | React 组件入口；只渲染宿主 `div`，挂载后由 runtime 创建 ShadowRoot |
| `motion-runtime.ts` | 实例生命周期：ShadowRoot、ResizeObserver、媒体查询、update/destroy |
| `ElasticPanelResizeEngine.js` | 完整交互核心：DOM/SVG、指针、键盘、物理、ARIA、RAF、计时器 |
| `ElasticPanelResizeEngine.d.ts` | 引擎公开类型与工厂声明 |

没有运行时依赖；React 侧只使用 `react` 的公开 API。

## 在本仓库运行

```bash
cd apps/desktop
bun run dev
```

打开：

```text
http://localhost:3000/dev-preview/elastic-panel-resize
```

该页面只放组件本身，没有标题、工具栏、模拟鼠标或网络请求。Next.js 开发模式右下角的 `N` 是框架 dev badge，生产构建不会出现。

## 在独立 React 项目使用

```bash
npm install react react-dom
```

把上面四个文件复制到例如 `src/elastic-panel-resize/`，然后：

```tsx
import { ElasticPanelResize } from "./elastic-panel-resize/ElasticPanelResize";

export default function App() {
  return <ElasticPanelResize />;
}
```

宿主容器宽度决定场景宽度；组件默认按 1000 宽的设计稿等比铺满。

```tsx
// 指定场景高度（设计单位，默认 1000）
<ElasticPanelResize height={640} />

// 强制减少动态效果；不传则跟随系统 prefers-reduced-motion
<ElasticPanelResize reducedMotion />

// 监听名义宽度（50.0 ~ 72.4）
<ElasticPanelResize
  ariaLabel="Inspector width"
  onChange={(state) => console.log(state.widthPercent, state.position)}
/>

// 从 42% 的位置开始（也接受 420 这样的设计像素值）
<ElasticPanelResize initialPosition={0.42} />
```

### Props

| Prop | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `height` | `number` | `1000` | 场景设计高度。场景宽度始终 1000 设计像素并按容器宽度整体缩放；更新不会重挂载 |
| `reducedMotion` | `boolean` | 跟随系统 | 传 `true` 强制直胶囊 / 位置直接到达；传 `false` 覆盖系统的 reduce |
| `initialPosition` | `number` | `0.3865` | 初始左边缘，0..1 比例或设计像素；仅初始化时读取 |
| `ariaLabel` | `string` | `"面板宽度"` | 分隔条可访问名称 |
| `onChange` | `(state) => void` | — | 名义目标变化时回调 |
| `className` / `style` / `id` | React 常规 | — | 作用于宿主 `div` |

`height` 是设计单位：在 1000px 宽容器里 `height={640}` 就是 640px 高；容器变窄时整体等比缩小。容器宽度为 0 的观测会被忽略，内部始终以 1000 设计宽初始化，首次正宽度到来再设置缩放，不会除以 0。

## 交互

- **鼠标**：靠近面板左边缘（32px 透明命中带）出现 75×15 灰色胶囊；拖动时把手向移动方向弯曲并整体偏移。
- **触屏**：按下出现，拖动与鼠标共用状态；松手后没有 hover，按延迟规则隐藏。
- **键盘**：`Tab` 聚焦分隔条，出现把手与 48×132、2px `#666` 焦点环。
  - `←` / `→`：每次 2% 场景宽
  - `Shift + ←` / `Shift + →`：每次 6%
  - `Home`：最大面板；`End`：最小面板
  - `Escape`：非拖动时重置；拖动中取消并恢复到本次按下前目标
  - 双击：重置到初始位置
- 松手、键盘变更、重置与取消都通过隐藏 `aria-live` 宣告，不逐帧刷屏。

## 实现要点

- 场景底色 `#efefef`，上叠 160px 平铺的内嵌 SVG `feTurbulence`（`fractalNoise`、`baseFrequency=0.75`、`numOctaves=3`、`stitchTiles=stitch`、饱和度 0），`contrast(4)`、`soft-light`、`opacity .65`；实测背景平均色约 `#f1f1f1`。面板 `#fbfbfb` 完全不透明，纹理不会透进面板。
- 面板：`inset: 17px 17px 17px auto` + 动态 `left`，`#fbfbfb`、1px `#d4d4d4`、40px 圆角、`0 2px 4px #0000000a` 与内描边 `0 0 0 1px #ffffffb3`。
- 两条 path 共用同一条二次贝塞尔：`M(40+O) (80-L/2) Q(40+O+2B) 80 (40+O) (80+L/2)`；外层白色描边 `S+2R`，内层灰色 `S`，整体透明度 `R`。
- 拖动位置直接跟随指针；越界 `e` 用 `p = t + sign(e) * 15 * (1 - exp(-|e|/35))`。松手后位置弹簧 `k=400, c=26`；把手 `B/O` 弹簧 `k=680, c=34`；`S/L/R` 用 `1-exp(-32dt)` 插值。每帧 4 个子步，`dt = min(frameDt, 1/30)`。
- `requestAnimationFrame` 只在需要时运行；位置误差 `<0.01`、速度 `<0.05`、`B/O` 差 `<0.01` 且速度 `<0.03`、`S/L` 差 `<0.01`、`R` 差 `<0.001` 时停止并吸附到静止状态。
- 指针速度超过 70ms 未更新即归零，松手不会再次反向拉弯把手。
- 尺寸变化保持设计坐标比例和拖动状态；`height` / `reducedMotion` 更新走同一实例，不重挂载。
- 所有样式注入组件自己的 ShadowRoot；不修改宿主 `body`、全局 ID 或全局样式。每个实例有独立引擎、独立 RAF/计时器/观察器，同一页面多实例状态不串扰。
- 卸载时取消 RAF、隐藏与 aria-live 计时器、窗口事件、指针捕获、ResizeObserver、媒体查询监听，并移除实例；同一宿主可重新挂载。

## 已验证

- 1000×1000：初始无把手；悬停 15×75 胶囊；普通拖动最大 90×5、`#9f9f9f`、整条偏移 9px；越界 15px、长线约 111×3；松手回弹归位，移开 450ms 后隐藏。
- 键盘完整路径、双击重置、focus 环尺寸、`aria-valuenow` 1 位小数、aria-live 不逐帧刷新。
- 触屏按下 / 拖拽 / 越界 / 松手隐藏，以及快速点按仍有视觉反馈。
- pointercancel、拖动中 Escape、lostpointercapture、回弹中重新抓取、方向反转。
- `reducedMotion` 系统偏好与 prop 覆盖：合法位置直接到达，把手保持直胶囊，无越界回弹。
- 多实例独立拖动/键盘，`height` 与 `reducedMotion` 更新不换实例，卸载后无残留，重新挂载正常。
- 375 / 768 / 1440px 无横向溢出；1440 下场景为等比方形，允许纵向滚动。

## 说明

组件按需求保持**空面板**：没有面板内容、工具栏、模拟鼠标、网络或复制功能。真实接入侧边栏时，使用 `onChange` 接收名义宽度；面板内部内容的接入不在这四个文件的范围内。
