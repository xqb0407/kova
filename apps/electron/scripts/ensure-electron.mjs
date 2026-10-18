#!/usr/bin/env node
/**
 * Electron 44 起 npm 包不再带 postinstall（只有 install-electron 这个 bin），
 * `bun install` 不会下载运行时二进制。启动前在这里补齐；已安装时 install.js
 * 会直接退出，不产生重复下载。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const electronDir = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "electron");

const result = spawnSync(process.execPath, [join(electronDir, "install.js")], {
  stdio: "inherit",
  env: {
    ...process.env,
    // 与 bun.lock 的 npmmirror 源保持一致；需要换源时显式设置 ELECTRON_MIRROR。
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/",
  },
});

process.exit(result.status ?? 1);
