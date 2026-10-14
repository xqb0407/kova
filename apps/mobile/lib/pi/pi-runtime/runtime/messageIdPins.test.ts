import { describe, expect, test } from "vitest";
import { messageId, shiftIndexPins, withIdPins } from "./messageIdPins";

/**
 * 消息 id 稳定性（本轮修复的回归网，纯逻辑单测）：
 *  - 行落盘补上 __seq 后 id 不能变——变了 React 整条卸载重挂（markdown 重解析、
 *    打字机归零、收尾闪一下），这是"不丝滑"的主因之一；
 *  - 冷加载历史行用 `pi-msg:<seq>`（与桌面同规），往上翻页 prepend 不受影响；
 *  - 乐观镜像自带 id 优先（与真实行对齐，避免用户气泡重挂）。
 */
describe("消息 id 钉扎", () => {
  test("在飞行 → 落盘：id 保持不变（钉扎）", () => {
    const pins = new Map<string, string>();
    withIdPins(pins, () => {
      // 第一帧：在飞（无 __seq）
      expect(messageId({}, 3)).toBe("pi-msg-idx:3");
      expect(messageId({}, 4)).toBe("pi-msg-idx:4");
      // 第二帧：同一行补上 __seq（落盘）——仍然拿旧 id
      expect(messageId({ __seq: 41 }, 3)).toBe("pi-msg-idx:3");
      expect(messageId({ __seq: 42 }, 4)).toBe("pi-msg-idx:4");
    });
  });

  test("冷加载（带 __seq）用 seq 形式；翻页 prepend 后已有的行 id 不变", () => {
    const pins = new Map<string, string>();
    withIdPins(pins, () => {
      expect(messageId({ __seq: 7 }, 0)).toBe("pi-msg:7");
      expect(messageId({ __seq: 8 }, 1)).toBe("pi-msg:8");
      // 往上翻页：头部插入两行老消息，原两行下标平移（0,1 → 2,3），seq 不变
      expect(messageId({ __seq: 5 }, 0)).toBe("pi-msg:5");
      expect(messageId({ __seq: 6 }, 1)).toBe("pi-msg:6");
      expect(messageId({ __seq: 7 }, 2)).toBe("pi-msg:7");
      expect(messageId({ __seq: 8 }, 3)).toBe("pi-msg:8");
    });
  });

  test("乐观镜像自带 id 优先", () => {
    const pins = new Map<string, string>();
    withIdPins(pins, () => {
      expect(messageId({ __optimisticId: "pi-msg-idx:9" }, 9)).toBe("pi-msg-idx:9");
    });
  });

  test("分页 prepend：下标台账随行右移，在飞行落盘仍拿旧 id", () => {
    const pins = new Map<string, string>();
    withIdPins(pins, () => {
      // 直播中：两行在飞（无 seq），钉在下标 3 / 4
      expect(messageId({}, 3)).toBe("pi-msg-idx:3");
      expect(messageId({}, 4)).toBe("pi-msg-idx:4");
      // 上翻一页：25 行旧页前置 → 同一批行整体后移到 28 / 29
      shiftIndexPins(pins, 25);
      expect(messageId({ __seq: 41 }, 28)).toBe("pi-msg-idx:3");
      expect(messageId({ __seq: 42 }, 29)).toBe("pi-msg-idx:4");
      // 冷读的旧页行（下标 0..24 从未登记）走 seq 形式，不受位移影响
      expect(messageId({ __seq: 5 }, 0)).toBe("pi-msg:5");
      // seq 键与下标无关：再移一次，落盘行仍认旧 id
      shiftIndexPins(pins, 10);
      expect(messageId({ __seq: 41 }, 38)).toBe("pi-msg-idx:3");
      // 非正位移是 no-op
      shiftIndexPins(pins, 0);
      expect(messageId({ __seq: 42 }, 39)).toBe("pi-msg-idx:4");
    });
  });

  test("无台账时退回原行为（投影可独立使用）", () => {
    expect(messageId({ __seq: 12 }, 3)).toBe("pi-msg:12");
    expect(messageId({}, 3)).toBe("pi-msg-idx:3");
  });
});
