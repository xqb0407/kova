import type { NextConfig } from "next";

// 静态导出到 out/：生产模式下 Tauri 内嵌为桌面 UI，远程网关同时将其作为网页 serve
const nextConfig: NextConfig = {
  output: "export",
  // pi-protocol 以 TS 源码直出（workspace 内部包免构建，设计文档 §1）
  transpilePackages: ["pi-protocol"],
  images: {
    // 静态导出不支持默认图片优化 loader
    unoptimized: true,
  },
};

export default nextConfig;
