import { describe, expect, test } from "bun:test";
import { motionInputKey, PetMotionMachine } from "./motion";

/** 收集快照序列的小工具 */
function track(machine: PetMotionMachine) {
  const snapshots: ReturnType<typeof machine.getSnapshot>[] = [];
  machine.subscribe(() => snapshots.push(machine.getSnapshot()));
  return snapshots;
}

describe("基础流转", () => {
  test("初始是 idle，快照引用在无变更时保持稳定", () => {
    const m = new PetMotionMachine();
    expect(m.getSnapshot()).toMatchObject({ type: "idle", loop: true });
    const s1 = m.getSnapshot();
    m.request("working");
    expect(m.getSnapshot()).not.toBe(s1);
    const s2 = m.getSnapshot();
    m.getSnapshot();
    expect(m.getSnapshot()).toBe(s2);
  });

  test("命令面插播一次性动作，播完交还声明层（不是落 idle）", () => {
    const m = new PetMotionMachine("working");
    m.request({ type: "waving", replay: true });
    expect(m.getSnapshot().type).toBe("waving");
    m.finish();
    expect(m.getSnapshot().type).toBe("working");
  });

  test("没有声明层时，一次性动作播完落 idle", () => {
    const m = new PetMotionMachine();
    m.request("jumping");
    m.finish();
    expect(m.getSnapshot().type).toBe("idle");
  });

  test("声明层自己的一次性动作播完 → 标记 done 落 idle；clear 不影响", () => {
    const m = new PetMotionMachine("review");
    m.finish();
    expect(m.getSnapshot().type).toBe("idle");
    // 同一 revision 再 finish 不重复发事件
    const events = track(m);
    m.finish();
    expect(events).toHaveLength(0);
  });

  test("循环动作调 finish 是空操作", () => {
    const m = new PetMotionMachine("working");
    const events = track(m);
    m.finish();
    expect(events).toHaveLength(0);
  });
});

describe("去重与重播", () => {
  test("同动作 + 同循环语义重复下发不重播（revision 不变）", () => {
    const m = new PetMotionMachine();
    const rev = m.getSnapshot().revision;
    m.request("working");
    const rev2 = m.getSnapshot().revision;
    expect(rev2).toBeGreaterThan(rev);
    m.request("working");
    expect(m.getSnapshot().revision).toBe(rev2);
  });

  test("replay: true 强制重播", () => {
    const m = new PetMotionMachine();
    m.request("working");
    const rev = m.getSnapshot().revision;
    m.request({ type: "working", replay: true });
    expect(m.getSnapshot().revision).toBeGreaterThan(rev);
  });

  test("已播完的一次性动作再下发会重新播", () => {
    const m = new PetMotionMachine();
    m.request("waving");
    m.finish();
    const rev = m.getSnapshot().revision;
    m.request("waving");
    expect(m.getSnapshot().revision).toBeGreaterThan(rev);
    expect(m.getSnapshot().type).toBe("waving");
  });

  test("loop 覆盖也算不同语义：working 循环下发后，working 单次再下发会重播", () => {
    const m = new PetMotionMachine();
    m.request({ type: "working", loop: false });
    const rev = m.getSnapshot().revision;
    m.request("working"); // 循环语义
    expect(m.getSnapshot().revision).toBeGreaterThan(rev);
    expect(m.getSnapshot().loop).toBe(true);
  });
});

describe("声明层与命令面的交接", () => {
  test("声明层变化清掉命令面的循环动作，prop 重新接管", () => {
    const m = new PetMotionMachine("idle");
    m.request({ type: "working", loop: true });
    expect(m.getSnapshot().type).toBe("working");
    m.setProp("waiting");
    expect(m.getSnapshot().type).toBe("waiting");
  });

  test("声明层变化保留正在播的一次性命令，到 finish 才交还", () => {
    const m = new PetMotionMachine("working");
    m.request("waving"); // 一次性
    m.setProp("waiting"); // 聚合状态晚一拍回落，不该掐断动画
    expect(m.getSnapshot().type).toBe("waving");
    m.finish();
    expect(m.getSnapshot().type).toBe("waiting");
  });

  test("clear 回落声明层；没有声明层落 idle", () => {
    const m = new PetMotionMachine("working");
    m.request("waving");
    m.clear();
    expect(m.getSnapshot().type).toBe("working");

    const m2 = new PetMotionMachine();
    m2.request("waving");
    m2.clear();
    expect(m2.getSnapshot().type).toBe("idle");
  });
});

describe("拖拽手势", () => {
  test("拖拽开始作废未播完的一次性命令（松手后不凭空重播）", () => {
    const m = new PetMotionMachine("working");
    m.request("waving");
    m.setDragging(true);
    expect(m.getSnapshot().type).toBe("working");
    m.setDragging(false);
    expect(m.getSnapshot().type).toBe("working");
  });

  test("拖拽开始保留循环命令", () => {
    const m = new PetMotionMachine("idle");
    m.request({ type: "working", loop: true });
    m.setDragging(true);
    expect(m.getSnapshot().type).toBe("working");
  });

  test("重复 setDragging 不发事件", () => {
    const m = new PetMotionMachine();
    const events = track(m);
    m.setDragging(true);
    const n = events.length;
    m.setDragging(true);
    expect(events).toHaveLength(n);
  });
});

describe("订阅与指纹", () => {
  test("每次变更通知订阅者，且拿到的是新快照", () => {
    const m = new PetMotionMachine();
    const events = track(m);
    m.request("waving");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("waving");
  });

  test("被忽略的重复下发不通知", () => {
    const m = new PetMotionMachine();
    m.request("waving");
    const events = track(m);
    m.request("waving");
    expect(events).toHaveLength(0);
  });

  test("motionInputKey：忽略 replay 与对象/字符串写法差异", () => {
    expect(motionInputKey("working")).toBe(motionInputKey({ type: "working" }));
    expect(motionInputKey({ type: "working", replay: true })).toBe(motionInputKey("working"));
    expect(motionInputKey("working")).not.toBe(motionInputKey({ type: "working", loop: false }));
    expect(motionInputKey(undefined)).toBe("");
  });
});
