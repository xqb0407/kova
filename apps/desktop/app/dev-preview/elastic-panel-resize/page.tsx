"use client";

/**
 * ElasticPanelResize 的浏览器预览页。
 *
 * 跑法：cd apps/desktop && bun run dev
 *      → http://localhost:3000/dev-preview/elastic-panel-resize
 *
 * 页面只放这一个组件：没有标题、工具栏、模拟指针或网络请求。组件自己在
 * ShadowRoot 里绘制 1000×1000 基准场景、右侧空面板、噪声和 SVG 把手。
 *
 * 验收提示：
 * - 初始无把手；鼠标移到面板左边缘（32px 命中带）出现 75×15 胶囊。
 * - 拖动时把手向移动方向弯曲并整体偏移；越界只有最多 15px 橡皮筋。
 * - 键盘 Tab 聚焦把手后：←/→ 20px，Shift+←/→ 60px，Home 最大面板，
 *   End 最小面板，Escape 重置，双击重置。
 * - 系统“减少动态效果”打开后，位置直接到达且把手保持直胶囊。
 */

import { ElasticPanelResize } from "@/components/elastic-panel-resize/ElasticPanelResize";

export default function Page() {
  return (
    <main
      style={{
        width: "100%",
        minHeight: "100vh",
        background: "#f1f1f1",
      }}
    >
      <ElasticPanelResize />
    </main>
  );
}
