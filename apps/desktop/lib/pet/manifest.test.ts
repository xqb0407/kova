import { describe, expect, test } from "bun:test";
import { clipForMotion, resolvePetUrl, resolvePetManifest } from "./manifest";

describe("Codex 官方包兼容", () => {
  test("spritesheetPath + 缺省几何 → 9 行契约全动作", () => {
    const r = resolvePetManifest({
      id: "firefly--lingxiaotian",
      displayName: "流萤",
      spritesheetPath: "spritesheet.webp",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pet.geometry).toEqual({ columns: 8, rows: 9, frameWidth: 192, frameHeight: 208 });
    expect(r.pet.spritesheetUrl).toBe("spritesheet.webp");
    expect(Object.keys(r.pet.clips)).toHaveLength(9);
    expect(r.pet.clips.working).toMatchObject({ kind: "atlas", row: 7, frames: 6, loop: true });
    expect(r.pet.clips.failed).toMatchObject({ kind: "atlas", row: 5, loop: false });
  });

  test("spriteVersionNumber: 2 → 11 行（含视线格）", () => {
    const r = resolvePetManifest({ spritesheetPath: "s.webp", spriteVersionNumber: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pet.geometry?.rows).toBe(11);
  });

  test("显式 rows 优先于 spriteVersionNumber", () => {
    const r = resolvePetManifest({ spritesheetPath: "s.webp", spriteVersionNumber: 2, rows: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pet.geometry?.rows).toBe(12);
  });
});

describe("我们的清单写法", () => {
  test("motions 省略 → 图集模式全落默认行表", () => {
    const r = resolvePetManifest({ spritesheet: "sheet.webp" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pet.clips.idle).toMatchObject({ kind: "atlas", row: 0, loop: true });
  });

  test("动图形态：.apng/.webp → animated，.png → static，相对路径按 baseUrl 拼", () => {
    const r = resolvePetManifest(
      {
        motions: {
          idle: "idle.apng",
          working: { src: "work.webp", loop: true },
          failed: "failed.png",
        },
      },
      "https://example.com/pets/mochi/",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pet.geometry).toBeNull();
    expect(r.pet.clips.idle).toEqual({ kind: "animated", src: "https://example.com/pets/mochi/idle.apng", loop: true });
    expect(r.pet.clips.working).toEqual({ kind: "animated", src: "https://example.com/pets/mochi/work.webp", loop: true });
    expect(r.pet.clips.failed).toEqual({ kind: "static", src: "https://example.com/pets/mochi/failed.png" });
    // 动图模式：没写的动作不生成 clip
    expect(r.pet.clips.waving).toBeUndefined();
  });

  test("图集模式下行号写法与对象覆盖", () => {
    const r = resolvePetManifest({
      spritesheet: "sheet.webp",
      motions: {
        failed: 3, // 自定义图集：失败画在第 3 行
        waving: { row: 4, frames: 6, loop: true },
        idle: { row: 0, interval: 300 }, // durations 缺省沿用行表
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pet.clips.failed).toMatchObject({ kind: "atlas", row: 3, frames: 8, loop: false });
    expect(r.pet.clips.waving).toMatchObject({ kind: "atlas", row: 4, frames: 6, loop: true });
    expect(r.pet.clips.idle).toMatchObject({ kind: "atlas", row: 0, interval: 300 });
    expect(r.pet.clips.idle).toHaveProperty("durations");
  });

  test("非法数值逐项回落默认（帧数/间隔/坏 durations）", () => {
    const r = resolvePetManifest({
      spritesheet: "sheet.webp",
      motions: { working: { row: 2, frames: -1, interval: 0, durations: [100, -5, Number.NaN] } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const clip = r.pet.clips.working!;
    expect(clip).toMatchObject({ kind: "atlas", row: 2, frames: 6, interval: 120 });
    expect(clip).toHaveProperty("durations", undefined);
  });
});

describe("拒绝与边界", () => {
  test("视频扩展名明确报错（不进 v1）", () => {
    const r = resolvePetManifest({ motions: { idle: "run.webm" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("视频");
  });

  test("不认识的扩展名报错", () => {
    const r = resolvePetManifest({ motions: { idle: "run.foo" } });
    expect(r.ok).toBe(false);
  });

  test("既没有 spritesheet 也没有 motions → 报错", () => {
    expect(resolvePetManifest({ displayName: "空" }).ok).toBe(false);
    expect(resolvePetManifest(null).ok).toBe(false);
    expect(resolvePetManifest([1, 2]).ok).toBe(false);
  });

  test("未知动作名被忽略（前向兼容）", () => {
    const r = resolvePetManifest({ motions: { dancing: "d.apng", idle: "i.apng" } } as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.pet.clips as Record<string, unknown>).dancing).toBeUndefined();
    expect(r.pet.clips.idle).toBeDefined();
  });

  test("行号写法在无图集清单里报错", () => {
    const r = resolvePetManifest({ motions: { idle: 3 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("行号");
  });
});

describe("resolvePetUrl / clipForMotion", () => {
  test("绝对地址与根相对地址原样返回", () => {
    expect(resolvePetUrl("https://a/b.png", "https://x/")).toBe("https://a/b.png");
    expect(resolvePetUrl("data:image/png;base64,xx", "https://x/")).toBe("data:image/png;base64,xx");
    expect(resolvePetUrl("/pet-fixtures/a.apng", "https://x/")).toBe("/pet-fixtures/a.apng");
  });

  test("相对地址拼 baseUrl（容忍多余斜杠）", () => {
    expect(resolvePetUrl("a.apng", "https://x/pets")).toBe("https://x/pets/a.apng");
    expect(resolvePetUrl("a.apng", "https://x/pets/")).toBe("https://x/pets/a.apng");
  });

  test("clipForMotion：动作缺失回落 idle，再缺失为 null", () => {
    const r = resolvePetManifest({ motions: { idle: "i.apng" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(clipForMotion(r.pet, "working")).toMatchObject({ kind: "animated" });
    expect(clipForMotion({ ...r.pet, clips: {} }, "working")).toBeNull();
  });
});
