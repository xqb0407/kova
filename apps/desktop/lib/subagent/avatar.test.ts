/**
 * 子智能体头像纯逻辑测试。
 *
 * 头像改为运行时生成后，这里守住：
 * - 清单 id 唯一且符合 kv 校验的字符集；
 * - 每个预设都能生成合法 base64 SVG data URI，且同一 id 结果稳定；
 * - 显式参数真的进了 SVG（体色/背景色），避免"改了表但没生效"；
 * - 「随机」生成的值是 kv 白名单形态（能过校验、能被 subagentAvatarSrc 解析）；
 * - 头像值的放行规则与 sidecar 的 normalizeSubagentAvatar 对齐（值会原样进 <img src>）。
 */
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_AVATAR_PREFIX,
  BUILTIN_SUBAGENT_AVATARS,
  SUBAGENT_AVATAR_MAX_LENGTH,
  builtinAvatarSrc,
  defaultSubagentAvatar,
  randomSubagentAvatar,
  resolveSubagentAvatarSrc,
  subagentAvatarSrc,
  subagentAvatarValidationError,
} from "./avatar";

const DATA_URL_PREFIX = "data:image/svg+xml;base64,";

function decodeDataUrl(url: string): string {
  return atob(url.slice(DATA_URL_PREFIX.length));
}

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("内置预设清单", () => {
  test("id 唯一且符合 kv 校验的字符集", () => {
    const ids = BUILTIN_SUBAGENT_AVATARS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    for (const a of BUILTIN_SUBAGENT_AVATARS) expect(a.label.trim()).not.toBe("");
  });

  test("头像数量至少撑满 6×4 网格", () => {
    expect(BUILTIN_SUBAGENT_AVATARS.length).toBeGreaterThanOrEqual(24);
  });

  test("每个预设都能生成干净的矢量 base64 SVG data URL", () => {
    const generated = new Set<string>();
    for (const avatar of BUILTIN_SUBAGENT_AVATARS) {
      const src = builtinAvatarSrc(avatar.id);
      expect(src, avatar.id).not.toBeNull();
      expect(src!.startsWith(DATA_URL_PREFIX), avatar.id).toBe(true);

      const svg = decodeDataUrl(src!);
      expect(svg, avatar.id).toContain("<svg");
      expect(svg, avatar.id).toContain('viewBox="0 0 100 100"');
      // 内嵌位图会让"纯矢量、几 KB"的前提失效
      expect(svg, avatar.id).not.toContain("<image");
      expect(src!.length, avatar.id).toBeLessThan(16 * 1024);
      generated.add(src!);
    }
    // 24 个预设必须真的有 24 种结果（参数没被吞掉）
    expect(generated.size).toBe(BUILTIN_SUBAGENT_AVATARS.length);
  });

  test("同一 id 结果稳定且走缓存", () => {
    const first = builtinAvatarSrc("clay-01");
    expect(builtinAvatarSrc("clay-01")).toBe(first);
  });

  test("显式体色/背景色进入 SVG", () => {
    const svg = decodeDataUrl(builtinAvatarSrc("clay-01")!);
    expect(svg.toLowerCase()).toContain("#83b0a4"); // clay-01 体色（鼠尾草）
    expect(svg.toLowerCase()).toContain("#e2ecf4"); // clay-01 背景色（天蓝）
  });

  test("未知 id → null（渲染层回落按名默认，不出破图）", () => {
    expect(builtinAvatarSrc("does-not-exist")).toBeNull();
  });
});

describe("randomSubagentAvatar（「随机一张」，Clay 全参数空间随机组合）", () => {
  test("返回 base64 SVG data URL，是干净的矢量图", () => {
    const url = randomSubagentAvatar();
    expect(url.startsWith(DATA_URL_PREFIX)).toBe(true);
    const svg = decodeDataUrl(url);
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).not.toContain("<image");
  });

  test("能过 kv 校验，也能被 subagentAvatarSrc 解析", () => {
    for (let i = 0; i < 5; i += 1) {
      const url = randomSubagentAvatar();
      expect(subagentAvatarValidationError(url)).toBeUndefined();
      expect(subagentAvatarSrc(url)).toBe(url);
    }
  });

  test("随机性真实存在：多次调用几乎不重样", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) seen.add(randomSubagentAvatar());
    expect(seen.size).toBeGreaterThanOrEqual(18);
  });
});

describe("subagentAvatarSrc", () => {
  test("内置 id → base64 data URL；未知 id → null（渲染默认图标，不出破图）", () => {
    const first = BUILTIN_SUBAGENT_AVATARS[0]!;
    expect(subagentAvatarSrc(`${BUILTIN_AVATAR_PREFIX}${first.id}`)).toBe(builtinAvatarSrc(first.id));
    expect(subagentAvatarSrc("builtin:does-not-exist")).toBeNull();
  });

  test("图片 data URL 原样返回；其它形态一律 null", () => {
    expect(subagentAvatarSrc(PNG_1PX)).toBe(PNG_1PX);
    expect(subagentAvatarSrc("https://example.com/a.png")).toBeNull();
    expect(subagentAvatarSrc("/Users/me/a.png")).toBeNull();
    expect(subagentAvatarSrc("data:text/html;base64,PGI+")).toBeNull();
    expect(subagentAvatarSrc("")).toBeNull();
    expect(subagentAvatarSrc(undefined)).toBeNull();
    expect(subagentAvatarSrc(null)).toBeNull();
  });
});

describe("defaultSubagentAvatar / resolveSubagentAvatarSrc（按名默认，没有空态）", () => {
  test("同名恒定同脸；按 sidecar 归一规则（trim + 小写）看作同一身份", () => {
    expect(defaultSubagentAvatar("Explorer")).toBe(defaultSubagentAvatar("Explorer"));
    expect(defaultSubagentAvatar("Explorer")).toBe(defaultSubagentAvatar("  explorer "));
  });

  test("默认值是合法的内置预设，能解析成 data URL", () => {
    for (const name of ["Explorer", "Code-reviewer", "Test-runner", "Fixer", "", "客服"]) {
      const value = defaultSubagentAvatar(name);
      expect(value.startsWith(BUILTIN_AVATAR_PREFIX)).toBe(true);
      expect(subagentAvatarSrc(value)).not.toBeNull();
    }
  });

  test("哈希要把名字散开：几十个常见名至少落到三分之一的预设上", () => {
    const names = [
      "Explorer", "Code-reviewer", "Test-runner", "Fixer", "customer-service", "writer",
      "translator", "researcher", "planner", "qa", "designer", "ops", "data", "sql",
      "docs", "reviewer", "legal", "hr", "sales", "support", "frontend", "backend",
      "mobile", "security", "devops", "pm", "editor", "summarizer", "crawler", "bot",
    ];
    const distinct = new Set(names.map(defaultSubagentAvatar));
    expect(distinct.size).toBeGreaterThanOrEqual(Math.ceil(BUILTIN_SUBAGENT_AVATARS.length / 3));
  });

  test("resolve：显式值可解析就用它，否则落按名默认", () => {
    const first = BUILTIN_SUBAGENT_AVATARS[0]!;
    expect(resolveSubagentAvatarSrc(`${BUILTIN_AVATAR_PREFIX}${first.id}`, "x")).toBe(
      builtinAvatarSrc(first.id),
    );
    expect(resolveSubagentAvatarSrc(PNG_1PX, "x")).toBe(PNG_1PX);
    const fallback = subagentAvatarSrc(defaultSubagentAvatar("x"));
    expect(resolveSubagentAvatarSrc(undefined, "x")).toBe(fallback);
    expect(resolveSubagentAvatarSrc("", "x")).toBe(fallback);
    expect(resolveSubagentAvatarSrc("builtin:does-not-exist", "x")).toBe(fallback);
    expect(resolveSubagentAvatarSrc("https://example.com/a.png", "x")).toBe(fallback);
  });
});

describe("subagentAvatarValidationError（与 sidecar 规则对齐）", () => {
  test("空=清除、内置 id、图片 data URL、随机生成的值都合法", () => {
    expect(subagentAvatarValidationError("")).toBeUndefined();
    expect(subagentAvatarValidationError("   ")).toBeUndefined();
    expect(subagentAvatarValidationError("builtin:clay-01")).toBeUndefined();
    expect(subagentAvatarValidationError(PNG_1PX)).toBeUndefined();
    expect(subagentAvatarValidationError("data:image/webp;base64,UklGRg==")).toBeUndefined();
    expect(subagentAvatarValidationError(randomSubagentAvatar())).toBeUndefined();
  });

  test("http 地址 / 本地路径 / 非图片 MIME / 畸形内置 id 给出错误文案", () => {
    for (const bad of [
      "https://example.com/a.png",
      "/Users/me/a.png",
      "data:text/html;base64,PGI+",
      "data:image/png,notbase64",
      "builtin:",
      "builtin:Clay 01",
    ]) {
      expect(subagentAvatarValidationError(bad)).toBeString();
    }
  });

  test("超过体积上限的 data URL 报'过大'而不是'不支持'", () => {
    const huge = `data:image/png;base64,${"A".repeat(SUBAGENT_AVATAR_MAX_LENGTH)}`;
    expect(subagentAvatarValidationError(huge)).toMatch(/过大/);
  });
});
