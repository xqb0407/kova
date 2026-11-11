/**
 * 项目头像（DiceBear）纯逻辑测试。
 *
 * 头像改为运行时生成后，这里守住：
 * - 24 个 Gaze 预设 id 唯一、label 非空、都能生成合法 data URI 且结果稳定；
 * - 「随机」覆盖 DiceBear 全部 61 种风格，id 可解析/可复现；
 * - 早期 `gaze-r-…` 随机 id 仍能渲染（兼容旧数据）。
 */
import { describe, expect, test } from "bun:test";
import { DICEBEAR_STYLE_IDS } from "./dicebear-styles";
import {
  BUILTIN_PROJECT_AVATARS,
  isProjectAvatarId,
  projectAvatarSrc,
  randomProjectAvatar,
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

describe("随机头像（DiceBear 全风格）", () => {
  test("生成的 id 全部可识别、可渲染且有变化", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 24; i += 1) {
      const id = randomProjectAvatar();
      expect(id.startsWith("dicebear:"), id).toBe(true);
      expect(isProjectAvatarId(id), id).toBe(true);
      const src = projectAvatarSrc(id);
      expect(src, id).not.toBeNull();
      expect(src!.startsWith(DATA_URI_PREFIX), id).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBeGreaterThan(1);
  });

  test("随机范围覆盖多种 DiceBear 风格", () => {
    const styles = new Set<string>();
    for (let i = 0; i < 24; i += 1) {
      styles.add(randomProjectAvatar().split(":")[1]!);
    }
    expect(styles.size).toBeGreaterThan(1);
  });

  test("61 种风格都能生成合法 data URI", () => {
    expect(DICEBEAR_STYLE_IDS.length).toBeGreaterThanOrEqual(61);
    for (const style of DICEBEAR_STYLE_IDS) {
      const id = `dicebear:${style}:e6f6f2:ab12cd34`;
      expect(isProjectAvatarId(id), style).toBe(true);
      const src = projectAvatarSrc(id);
      expect(src, style).not.toBeNull();
      expect(src!.startsWith(DATA_URI_PREFIX), style).toBe(true);
      expect(src, style).toBe(projectAvatarSrc(id));
    }
  });

  test("未知风格 / 参数越界一律不认", () => {
    expect(isProjectAvatarId("dicebear:not-a-style:e6f6f2:ab12cd34")).toBe(false);
    expect(isProjectAvatarId("dicebear:lorelei:zzzzzz:ab12cd34")).toBe(false);
    expect(isProjectAvatarId("dicebear:lorelei:e6f6f2:a")).toBe(false);
    expect(isProjectAvatarId("dicebear:lorelei:e6f6f2:ab12cd34:x")).toBe(false);
    expect(isProjectAvatarId("dicebear:../x:e6f6f2:ab12cd34")).toBe(false);
    expect(projectAvatarSrc("dicebear:not-a-style:e6f6f2:ab12cd34")).toBeNull();
  });
});

describe("兼容早期 Gaze 随机 id", () => {
  test("同一 id 稳定生成同一张图", () => {
    const id = "gaze-r-3fb6a8-e6f6f2-ab12cd34";
    expect(isProjectAvatarId(id)).toBe(true);
    const first = projectAvatarSrc(id);
    expect(projectAvatarSrc(id)).toBe(first);
    const svg = decodeDataUri(first!).toLowerCase();
    expect(svg).toContain("#3fb6a8");
    expect(svg).toContain("#e6f6f2");
  });

  test("参数越界 / 拼接外部内容一律不认", () => {
    expect(isProjectAvatarId("gaze-r-zzzzzz-e6f6f2-ab12cd34")).toBe(false);
    expect(isProjectAvatarId("gaze-r-3fb6a8")).toBe(false);
    expect(isProjectAvatarId("gaze-r-3fb6a8-e6f6f2-a")).toBe(false);
    expect(isProjectAvatarId("gaze-r-3fb6a8-e6f6f2-ab12cd34-x")).toBe(false);
    expect(isProjectAvatarId("gaze-r-../x-e6f6f2-ab12cd34")).toBe(false);
    expect(projectAvatarSrc("gaze-r-../x-e6f6f2-ab12cd34")).toBeNull();
  });
});
