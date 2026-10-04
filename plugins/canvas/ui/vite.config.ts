import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from "@tailwindcss/vite";

// 单文件产物：canvas 插件整个 UI 打成一个 HTML（宿主经桥以 blob: iframe 承载，
// 插件分发场景没有静态资源服务器）。postbuild 把 dist/index.html 拷成插件根的
// canvas.html（panels.json entry 指向它）。
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    target: "esnext",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8_000,
  },
});
