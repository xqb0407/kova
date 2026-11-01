/**
 * 项目内置头像（DiceBear Gaze）纯逻辑测试。
 *
 * 守住清单 ↔ 生成脚本 ↔ public/ 落盘 SVG 三者同集合：少一个文件就是选择器里
 * 一格破图，多一个就是选不到的死资源。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_PROJECT_AVATARS,
  isProjectAvatarId,
  projectAvatarSrc,
} from "./project-avatars";

const DESKTOP_ROOT = join(import.meta.dir, "..", "..");
const PUBLIC_DIR = join(DESKTOP_ROOT, "public", "project-avatars");
const SCRIPT = join(
  DESKTOP_ROOT,
  "..",
  "..",
  "scripts",
  "generate-project-avatars.mjs",
);

describe("内置头像清单", () => {
  test("id 唯一、label 非空", () => {
    const ids = BUILTIN_PROJECT_AVATARS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of BUILTIN_PROJECT_AVATARS) expect(a.label.trim()).not.toBe("");
  });

  test("每个预设在 public/project-avatars 下都有对应 SVG，且是干净的矢量文件", () => {
    for (const a of BUILTIN_PROJECT_AVATARS) {
      const file = join(PUBLIC_DIR, `${a.id}.svg`);
      expect(existsSync(file), a.id).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg, a.id).toContain("<svg");
      expect(svg, a.id).toContain('viewBox="0 0 100 100"');
      // 内嵌位图会让"纯矢量、几 KB"的前提失效
      expect(svg, a.id).not.toContain("<image");
      expect(svg.length, a.id).toBeLessThan(16 * 1024);
    }
  });

  test("与生成脚本的 AVATARS 表同集合（两边改一处必须同步另一处）", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const scriptIds = [...source.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map(
      (m) => m[1],
    );
    expect(scriptIds.length).toBeGreaterThan(0);
    expect([...scriptIds].sort()).toEqual(
      BUILTIN_PROJECT_AVATARS.map((a) => a.id).sort(),
    );
  });
});

describe("projectAvatarSrc / isProjectAvatarId", () => {
  test("合法 id → 根相对静态地址；未知 id → null（回退图标，不出破图）", () => {
    const first = BUILTIN_PROJECT_AVATARS[0]!;
    expect(projectAvatarSrc(first.id)).toBe(`/project-avatars/${first.id}.svg`);
    expect(projectAvatarSrc("gaze-does-not-exist")).toBeNull();
    expect(projectAvatarSrc(undefined)).toBeNull();
    expect(projectAvatarSrc(null)).toBeNull();
  });

  test("白名单只认清单里的 id", () => {
    expect(isProjectAvatarId("gaze-01")).toBe(true);
    expect(isProjectAvatarId("cat")).toBe(false);
    expect(isProjectAvatarId("../gaze-01")).toBe(false);
    expect(isProjectAvatarId(1)).toBe(false);
  });
});
