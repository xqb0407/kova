import { describe, expect, test } from "bun:test";
import { liveCompactionBannerData } from "@/lib/pi/pi-live-compaction";

describe("liveCompactionBannerData", () => {
  test("自动压缩进行中（阈值/溢出）→ 流尾 start 分隔线", () => {
    expect(
      liveCompactionBannerData({ active: true, reason: "threshold" }),
    ).toEqual({ phase: "start" });
    expect(liveCompactionBannerData({ active: true, reason: "overflow" })).toEqual(
      { phase: "start" },
    );
  });

  test("手动压缩有独立锚点 marker → 实时 marker 让位", () => {
    expect(liveCompactionBannerData({ active: true, reason: "manual" })).toBeNull();
  });

  test("空闲 → 不渲染（完成态由检查点行在快照里重建）", () => {
    expect(liveCompactionBannerData({ active: false })).toBeNull();
    expect(liveCompactionBannerData({ active: false, reason: "threshold" })).toBeNull();
  });
});
