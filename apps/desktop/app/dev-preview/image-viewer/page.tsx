"use client";

/**
 * 图片查看器的浏览器侧预览页（对齐 dev-preview 其它页：URL 直达，不接桌面桥）。
 * 直接喂 data URL 就能验缩放条/点阵底/适应与 1:1 的差别——磁盘图片那条路只多
 * 一次 fs_read_file_base64，与本页无关。
 *
 * 与 dev-preview 的其它页一样是**临时测量页**：本页只解决「看图器的观感与
 * 交互改完长什么样」，改样式/改缩放手感时打开它看一眼即可，不必开桌面壳。
 *
 * 跑法：cd apps/desktop && bun run dev → http://localhost:3000/dev-preview/image-viewer
 * 三块画布各验一件事：
 *   · 大图（1200×800）：适应窗口应缩到框内；点 1:1 应溢出并出现滚动条；
 *   · 小图（80×60）：适应**不应**被放大（位图只缩不放），百分比读数应为 100%；
 *   · SVG（200×100）：矢量图适应**允许**放大（贴满容器），百分比读数应 > 100%。
 */

import { useEffect, useState } from "react";
import {
  ImageView,
  ZoomableImage,
} from "@/components/agent-thread/agent-panel/image-viewer";

/** 用 canvas 现画一张带透明边的大图：透明区正好验点阵底 */
function bigPng(): string {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 800;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#e2e8f0";
    g.fillRect(0, 0, c.width, c.height);
    const grad = g.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, "#f97316");
    grad.addColorStop(1, "#0f766e");
    g.fillStyle = grad;
    g.fillRect(120, 80, 960, 640);
    g.fillStyle = "#ffffff";
    g.font = "600 64px system-ui";
    g.fillText("1200 × 800", 400, 430);
  }
  return c.toDataURL("image/png");
}

/** 小图：验「适应不放大」 */
function smallPng(): string {
  const c = document.createElement("canvas");
  c.width = 80;
  c.height = 60;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#0ea5e9";
    g.fillRect(0, 0, 80, 60);
    g.fillStyle = "#fff";
    g.font = "600 16px system-ui";
    g.fillText("80×60", 12, 36);
  }
  return c.toDataURL("image/png");
}

// 与应用同款：先 TextEncoder 出 UTF-8 字节再 btoa——直接 btoa("×") 写出的是
// Latin-1 单字节，解码端按 UTF-8 读就成非法序列（img 直接裂）
const svg = (() => {
  const text = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" rx="12" fill="#1d4ed8"/><text x="100" y="58" font-family="system-ui" font-size="22" fill="#fff" text-anchor="middle">200 x 100 SVG</text></svg>`;
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
})();

const Frame = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="flex h-[360px] w-[420px] flex-col overflow-hidden rounded-xl border">
    <p className="text-muted-foreground shrink-0 border-b px-3 py-1.5 text-xs">
      {title}
    </p>
    {children}
  </div>
);

export default function ImageViewerPreviewPage() {
  // SSR 首帧不许碰 canvas：挂载后再画，避免 hydration 不一致
  const [big, setBig] = useState<string | null>(null);
  const [small, setSmall] = useState<string | null>(null);
  useEffect(() => {
    setBig(bigPng());
    setSmall(smallPng());
  }, []);
  return (
    <div className="flex h-screen flex-wrap items-start gap-4 p-4">
      <Frame title="大图 1200×800：适应应缩小 / 1:1 应出滚动条">
        {big ? <ZoomableImage src={big} alt="big" /> : null}
      </Frame>
      <Frame title="小图 80×60：适应不放大，读数应为 100%">
        {small ? <ZoomableImage src={small} alt="small" /> : null}
      </Frame>
      <Frame title="SVG 200×100：矢量适应允许放大（读数 > 100%）">
        <ZoomableImage src={svg} alt="svg" upscaleToFit />
      </Frame>
      {/* 真组件的顶栏也过一眼：浏览器里没有桌面桥，落在「读取失败」态——
          正好只验面包屑那一行的版式（截断、元信息、复制按钮） */}
      <Frame title="图片标签顶栏（真组件·无桥→读取失败态）">
        <ImageView cwd="/tmp/demo" path="assets/ip-cats/A2-butler-coral.png" mime="image/png" />
      </Frame>
    </div>
  );
}