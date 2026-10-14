// Electron 主进程与 preload 打包：TS 源 → dist/*.cjs（electron 38 ESM main 亦可，
// 但 CJS 单文件最稳：node-pty/ws 外部化，避免运行时 require 路径问题）。
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url).pathname, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron", "node-pty", "ws", "better-sqlite3"],
};

await build({ ...common, entryPoints: ["main/index.ts"], outfile: "dist/main.cjs" });
await build({ ...common, entryPoints: ["preload/index.ts"], outfile: "dist/preload.cjs" });
console.log("[build] electron main+preload → dist/");
