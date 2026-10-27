import { describe, expect, test } from "bun:test";
import {
  pushRunCheckpoint,
  runCheckpointsForTest,
  type RunCheckpoint,
} from "@/lib/pi/pi-checkpoints";

/**
 * pushRunCheckpoint 去重规则（锚点改双键后）：
 * - 带稳定 id（pi-msg:<seq>）：同 id 重结算替换；同轮老条目（仅 index）一并替换
 * - 仅 index（老数据/降级）：沿用旧规则，同 index 替换、null 清 null
 */

const cp = (files: number): RunCheckpoint => ({
  cwd: "/w",
  hash: `hash-${files}-${Math.random().toString(36).slice(2, 8)}`,
  files,
  added: files,
  removed: 0,
});

describe("pushRunCheckpoint 去重", () => {
  test("同 anchorMessageId 重结算替换旧条目", () => {
    pushRunCheckpoint(
      "t-dedup-id",
      { anchorIndex: 2, anchorMessageId: "pi-msg:7" },
      cp(1),
    );
    pushRunCheckpoint(
      "t-dedup-id",
      { anchorIndex: 2, anchorMessageId: "pi-msg:7" },
      cp(5),
    );
    const list = runCheckpointsForTest("t-dedup-id");
    expect(list).toHaveLength(1);
    expect(list[0]?.files).toBe(5);
    expect(list[0]?.anchorMessageId).toBe("pi-msg:7");
  });

  test("新条目带 id 时同轮老条目（仅 index）一并替换，防新老并存两张卡", () => {
    pushRunCheckpoint("t-dedup-mix", { anchorIndex: 3 }, cp(1));
    pushRunCheckpoint(
      "t-dedup-mix",
      { anchorIndex: 3, anchorMessageId: "pi-msg:9" },
      cp(2),
    );
    const list = runCheckpointsForTest("t-dedup-mix");
    expect(list).toHaveLength(1);
    expect(list[0]?.anchorMessageId).toBe("pi-msg:9");
  });

  test("不同轮（不同 id）互不影响", () => {
    pushRunCheckpoint(
      "t-dedup-multi",
      { anchorIndex: 0, anchorMessageId: "pi-msg:3" },
      cp(1),
    );
    pushRunCheckpoint(
      "t-dedup-multi",
      { anchorIndex: 4, anchorMessageId: "pi-msg:11" },
      cp(2),
    );
    expect(runCheckpointsForTest("t-dedup-multi")).toHaveLength(2);
  });

  test("锚点未知（null）清掉旧的未知锚点条目，避免末尾兜底堆叠", () => {
    pushRunCheckpoint("t-dedup-null", { anchorIndex: null }, cp(1));
    pushRunCheckpoint("t-dedup-null", { anchorIndex: null }, cp(2));
    const list = runCheckpointsForTest("t-dedup-null");
    expect(list).toHaveLength(1);
    expect(list[0]?.files).toBe(2);
  });
});
