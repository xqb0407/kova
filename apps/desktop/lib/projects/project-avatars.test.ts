/**
 * 项目内置头像（DiceBear Gaze）纯逻辑测试。
 *
 * 头像改为运行时生成后，这里守住：
 * - 清单 id 唯一、label 非空；
 * - 每个预设都能生成合法 data URI（不是破图），且同一 id 结果稳定；
 * - 显式参数真的进了 SVG（体色/背景色），避免"改了表但没生效"。
 */
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_PROJECT_AVATARS,
  isProjectAvatarId,
  projectAvatarSrc,
} from "./project-avatars";

const DATA_URI_PREFIX = "data:image/svg+xml;charset=utf-8,";

function decodeDataUri(uri: string): string {
  return decodeURIComponent(uri.slice(DATA_URI_PREFIX.length));
}

describe("内置头像清单", () => {
  test("id 唯一、label 非空", () => {
    const ids = BUILTIN_PROJECT_AVATARS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of BUILTIN_PROJECT_AVATARS) expect(a.label.trim()).not.toBe("");
  });

  test("头像数量至少撑满 6×4 网格", () => {
    expect(BUILTIN_PROJECT_AVATARS.length).toBeGreaterThanOrEqual(24);
  });

  test("每个预设都能生成干净的矢量 data URI", () => {
    const generated = new Set<string>();
    for (const avatar of BUILTIN_PROJECT_AVATARS) {
      const src = projectAvatarSrc(avatar.id);
      expect(src, avatar.id).not.toBeNull();
      expect(src!.startsWith(DATA_URI_PREFIX), avatar.id).toBe(true);

      const svg = decodeDataUri(src!);
      expect(svg, avatar.id).toContain("<svg");
      expect(svg, avatar.id).toContain('viewBox="0 0 100 100"');
      // 内嵌位图会让"纯矢量、几 KB"的前提失效
      expect(svg, avatar.id).not.toContain("<image");
      expect(svg.length, avatar.id).toBeLessThan(16 * 1024);
      generated.add(src!);
    }
    // 12 个预设必须真的有 12 种结果（参数没被吞掉）
    expect(generated.size).toBe(BUILTIN_PROJECT_AVATARS.length);
  });

  test("同一 id 结果稳定且走缓存", () => {
    const first = projectAvatarSrc("gaze-01");
    expect(projectAvatarSrc("gaze-01")).toBe(first);
  });

  test("显式体色/背景色进入 SVG", () => {
    const svg = decodeDataUri(projectAvatarSrc("gaze-01")!);
    expect(svg.toLowerCase()).toContain("#e2725b"); // 陶土体色
    expect(svg.toLowerCase()).toContain("#f7efe7"); // 米白背景
  });
});

describe("projectAvatarSrc / isProjectAvatarId", () => {
  test("未知 id → null（回退图标，不出破图）", () => {
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
