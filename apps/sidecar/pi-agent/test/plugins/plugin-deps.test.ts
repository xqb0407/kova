/** 插件依赖状态/安装入口的轻量测试（不触发真实 npm 网络安装）。 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPluginDeps, pluginDepsStatus } from "../../src/plugins/plugin-deps";

describe("pluginDepsStatus", () => {
  test("package.json 存在但 node_modules 缺失 → 可安装；装好/锁文件识别", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-deps-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } }),
      );
      expect(pluginDepsStatus(root)).toMatchObject({
        hasPackageJson: true,
        hasLockfile: false,
        hasNodeModules: false,
        missing: true,
        installable: true,
      });

      writeFileSync(join(root, "package-lock.json"), "{}");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      expect(pluginDepsStatus(root)).toMatchObject({
        hasPackageJson: true,
        hasLockfile: true,
        hasNodeModules: true,
        missing: false,
        installable: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("只有元数据、没有运行期依赖：不显示安装入口", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-deps-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "meta-only", version: "1.0.0", devDependencies: { vitest: "1" } }),
      );
      expect(pluginDepsStatus(root)).toMatchObject({
        hasPackageJson: true,
        hasNodeModules: false,
        missing: false,
        installable: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("无 package.json：安装入口直接拒绝，不 spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-deps-"));
    try {
      const result = await installPluginDeps(root);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("没有 package.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
