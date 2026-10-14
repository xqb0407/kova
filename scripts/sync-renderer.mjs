/**
 * 把前端静态导出（apps/desktop/out）同步进 Electron 包（apps/electron/renderer-out）：
 * 生产路径（electron . / 打包版）从这里加载页面。先删后拷，避免旧 chunk 残留。
 *   bun run build:renderer 已自动调用；也可单独执行 node scripts/sync-renderer.mjs
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "apps/desktop/out");
const dest = join(root, "apps/electron/renderer-out");
if (!existsSync(src)) {
  console.error(`[sync-renderer] 缺少 ${src}——先跑 next build（bun run build:renderer）`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[sync-renderer] out → renderer-out 已同步`);
