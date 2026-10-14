/** 渲染层静态产物目录（next build 的 out/，构建时同步进 Electron 包） */
import { app } from "electron";
import { join } from "node:path";

export function rendererOutDir(): string {
  return join(app.getAppPath(), "renderer-out");
}
