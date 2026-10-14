import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from "@tailwindcss/vite";

// 单文件产物：聚合面板整个 UI（幻灯片+表格+文档三引擎）打成一个 HTML（宿主经桥以
// blob: iframe 承载，插件分发场景没有静态资源服务器）。postbuild 把 dist/index.html
// 拷成插件根的 office.html（panels.json entry 指向它）。三引擎合一体积 20MB+，
// sidecar 的 PANEL_ASSET_MAX_BYTES 已相应放宽。
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: {
    alias: { "@": resolve(fileURLToPath(new URL(".", import.meta.url)), "src") },
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    target: "esnext",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 12_000,
  },
});
