/**
 * 子智能体头像纯逻辑测试。
 *
 * 守两条容易静默漂移的线：
 * 1. 内置预设清单（avatar.ts）↔ 生成脚本的 AVATARS 表 ↔ public/ 下真实落盘的 SVG，
 *    三者必须同集合——少一个文件就是设置页里一格破图，多一个就是选不到的死资源；
 * 2. 头像值的放行规则与 sidecar 的 normalizeSubagentAvatar 对齐（值会原样进 <img src>）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_AVATAR_PREFIX,
  BUILTIN_SUBAGENT_AVATARS,
  SUBAGENT_AVATAR_MAX_LENGTH,
  builtinAvatarSrc,
  defaultSubagentAvatar,
  resolveSubagentAvatarSrc,
  subagentAvatarSrc,
  subagentAvatarValidationError,
} from "./avatar";

const DESKTOP_ROOT = join(import.meta.dir, "..", "..");
const PUBLIC_DIR = join(DESKTOP_ROOT, "public", "subagent-avatars");
const SCRIPT = join(DESKTOP_ROOT, "..", "..", "scripts", "generate-subagent-avatars.mjs");

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("内置预设清单", () => {
  test("id 唯一且符合 kv 校验的字符集", () => {
    const ids = BUILTIN_SUBAGENT_AVATARS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    for (const a of BUILTIN_SUBAGENT_AVATARS) expect(a.label.trim()).not.toBe("");
  });

  test("每个预设在 public/subagent-avatars 下都有对应 SVG，且是干净的矢量文件", () => {
    for (const a of BUILTIN_SUBAGENT_AVATARS) {
      const file = join(PUBLIC_DIR, `${a.id}.svg`);
      expect(existsSync(file)).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain('viewBox="0 0 100 100"');
      // 内嵌位图会让"纯矢量、几 KB"的前提失效
      expect(svg).not.toContain("<image");
      expect(svg.length).toBeLessThan(16 * 1024);
    }
  });

  test("与生成脚本的 AVATARS 表同集合（两边改一处必须同步另一处）", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const scriptIds = [...source.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(scriptIds.length).toBeGreaterThan(0);
    expect([...scriptIds].sort()).toEqual(BUILTIN_SUBAGENT_AVATARS.map((a) => a.id).sort());
  });
});

describe("subagentAvatarSrc", () => {
  test("内置 id → 根相对静态地址；未知 id → null（渲染默认图标，不出破图）", () => {
    const first = BUILTIN_SUBAGENT_AVATARS[0]!;
    expect(subagentAvatarSrc(`${BUILTIN_AVATAR_PREFIX}${first.id}`)).toBe(builtinAvatarSrc(first.id));
    expect(builtinAvatarSrc(first.id)).toBe(`/subagent-avatars/${first.id}.svg`);
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

  test("默认值是合法的内置预设，能解析成静态地址", () => {
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
  test("空=清除、内置 id、图片 data URL 都合法", () => {
    expect(subagentAvatarValidationError("")).toBeUndefined();
    expect(subagentAvatarValidationError("   ")).toBeUndefined();
    expect(subagentAvatarValidationError("builtin:clay-01")).toBeUndefined();
    expect(subagentAvatarValidationError(PNG_1PX)).toBeUndefined();
    expect(subagentAvatarValidationError("data:image/webp;base64,UklGRg==")).toBeUndefined();
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
