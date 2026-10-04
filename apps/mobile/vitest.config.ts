import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // 与 tsconfig 的 paths 对齐：@/* → ./*（metro 也按同一规则解析）
    alias: { "@": root },
  },
});
