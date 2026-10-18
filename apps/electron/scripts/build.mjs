// Electron 主进程与 preload 打包：TS 源 → dist/*.cjs（electron 44 ESM main 亦可，
// 但 CJS 单文件最稳：node-pty/ws 外部化，避免运行时 require 路径问题）。
//
// --watch：常驻增量重建（scripts/dev.mjs 用）。重建后**由 dev.mjs 负责重启 Electron**
// ——主进程代码改动无法热更，只能换进程；把"发现变更"与"何时重启"分开，
// 免得这里再引一套进程管理。
import esbuild from "esbuild";
import { rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const distDir = new URL("../dist", import.meta.url).pathname;

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron", "node-pty", "ws", "better-sqlite3"],
};

const entries = [
  ["main/index.ts", "dist/main.cjs"],
  ["preload/index.ts", "dist/preload.cjs"],
];

/** 每次构建结束播报一行：dev.mjs 用它判定"这是初次构建还是改动后的重建"。
 *  初次构建全部完成后再额外播报 watch ready —— ctx.watch() 的 promise 在"开始监听"
 *  时即 resolve（不等首次构建），只靠它握手会让 dev.mjs 在初次构建落盘前就拉起
 *  Electron，把初次写入误判成改动、启动期白重启一次。 */
let completedBuilds = 0;
let readyAnnounced = false;
const announce = {
  name: "announce",
  setup(build) {
    build.onEnd((result) => {
      completedBuilds += 1;
      console.log(result.errors.length ? "[build] rebuilt (有错误)" : "[build] rebuilt");
      if (watch && !readyAnnounced && completedBuilds >= entries.length) {
        readyAnnounced = true;
        console.log("[build] watch ready");
      }
    });
  },
};

rmSync(distDir, { recursive: true, force: true });

if (watch) {
  for (const [entry, outfile] of entries) {
    const ctx = await esbuild.context({ ...common, entryPoints: [entry], outfile, plugins: [announce] });
    await ctx.watch();
  }
} else {
  for (const [entry, outfile] of entries) {
    await esbuild.build({ ...common, entryPoints: [entry], outfile });
  }
  console.log("[build] electron main+preload → dist/");
}
