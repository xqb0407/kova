import { describe, expect, test } from "bun:test";
import {
  compactionTakenOver,
  type CompactionStreamProbe,
  type ManualCompactionMarker,
} from "@/lib/pi/pi-compaction-marker";

const marker = (
  data: Partial<ManualCompactionMarker["data"]> = {},
  anchorIndex = 3,
): ManualCompactionMarker => ({
  threadId: "t1",
  remoteId: "s1",
  anchorIndex,
  data: { phase: "complete", generation: 2, tokensBefore: 114_000, ...data },
});

const textMsg = (): CompactionStreamProbe => ({
  content: [{ type: "text" }],
});

const compactionMsg = (data: unknown): CompactionStreamProbe => ({
  content: [{ type: "data", name: "compaction", data }],
});

describe("compactionTakenOver", () => {
  test("start 态 marker 永不判接管（compact 在飞，检查点行还不存在）", () => {
    expect(
      compactionTakenOver(
        [textMsg(), compactionMsg({ phase: "complete", generation: 2 })],
        marker({ phase: "start" }, 1),
      ),
    ).toBe(false);
  });

  test("流内无分隔线 → 未接管，marker 继续显示", () => {
    expect(compactionTakenOver([textMsg(), textMsg(), textMsg()], marker())).toBe(
      false,
    );
  });

  test("同 generation 的完成态线 → 接管（哪怕位置在锚点前）", () => {
    expect(
      compactionTakenOver(
        [compactionMsg({ phase: "complete", generation: 2 }), textMsg(), textMsg(), textMsg()],
        marker(),
      ),
    ).toBe(true);
  });

  test("流内 start 态线不算接管（生命周期未走完）", () => {
    expect(
      compactionTakenOver(
        [textMsg(), textMsg(), compactionMsg({ phase: "start", generation: 2 })],
        marker(),
      ),
    ).toBe(false);
  });

  test("异代完成态线在锚点前 → 未接管（更早的压缩，marker 仍属本次）", () => {
    expect(
      compactionTakenOver(
        [compactionMsg({ phase: "complete", generation: 1 }), textMsg(), textMsg()],
        marker(),
      ),
    ).toBe(false);
  });

  test("generation 缺位时按位置兜底：锚点之后（index >= anchorIndex）的完成态线 → 接管", () => {
    expect(
      compactionTakenOver(
        [textMsg(), textMsg(), textMsg(), compactionMsg({ phase: "complete" })],
        marker({ generation: undefined }),
      ),
    ).toBe(true);
  });

  test("generation 缺位时嵌在锚点消息内部的旧线不算接管（index === anchorIndex-1）", () => {
    expect(
      compactionTakenOver(
        [textMsg(), textMsg(), compactionMsg({ phase: "complete", generation: 1 })],
        marker({ generation: undefined }),
      ),
    ).toBe(false);
  });

  test("非 compaction 的 data part 不误判", () => {
    expect(
      compactionTakenOver(
        [
          textMsg(),
          textMsg(),
          textMsg(),
          { content: [{ type: "data", name: "stopped" }] },
        ],
        marker(),
      ),
    ).toBe(false);
  });
});
