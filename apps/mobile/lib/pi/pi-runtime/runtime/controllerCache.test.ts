/**
 * 控制器缓存（内存治理）单测：这是"切会话不再越切越大"的唯一闸门——
 * 默认 LRU 上限 3、切会话收紧到 1，且直播中/有排队的永不逐出（逐出会拆订阅）。
 */
import { describe, expect, test } from "vitest";
import {
  __resetControllerCacheForTests,
  pruneControllers,
  touchController,
  type CacheableController,
} from "./controllerCache";

const controller = (
  state: Partial<CacheableController["getState"] extends () => infer S ? S : never> = {},
): CacheableController & { disposed: boolean } => {
  const self = {
    disposed: false,
    getState: () => ({
      runStatus: "idle",
      queue: { steering: [], followUp: [] },
      ...state,
    }),
    dispose() {
      self.disposed = true;
    },
  };
  return self;
};

describe("控制器缓存逐出", () => {
  test("keep=1：只留活动会话，上一会话被释放", () => {
    __resetControllerCacheForTests();
    const controllers = new Map<string, CacheableController>();
    for (const id of ["a", "b", "c"]) controllers.set(id, controller());
    touchController("a");
    touchController("b");
    touchController("c");

    const evicted = pruneControllers(controllers, "c", 1);
    expect([...controllers.keys()]).toEqual(["c"]);
    expect(evicted.sort()).toEqual(["a", "b"]);
  });

  test("keep=3（默认）：超出的按 LRU 逐出，活动会话不受影响", () => {
    __resetControllerCacheForTests();
    const controllers = new Map<string, CacheableController>();
    for (const id of ["a", "b", "c", "d"]) controllers.set(id, controller());
    for (const id of ["a", "b", "c", "d"]) touchController(id);

    const evicted = pruneControllers(controllers, "d");
    // a 最旧 → 被逐；b/c/d 留下
    expect(evicted).toEqual(["a"]);
    expect([...controllers.keys()].sort()).toEqual(["b", "c", "d"]);
  });

  test("直播中 / 有排队的控制器永不逐出，即使超出上限", () => {
    __resetControllerCacheForTests();
    const controllers = new Map<string, CacheableController>();
    controllers.set("live", controller({ runStatus: "running" }));
    controllers.set("queued", controller({ queue: { steering: [], followUp: [{ id: "q" }] } }));
    controllers.set("idle1", controller());
    controllers.set("idle2", controller());
    controllers.set("idle3", controller());
    for (const id of ["live", "queued", "idle1", "idle2", "idle3"]) touchController(id);

    // 收紧到 1：两个"活跃豁免"仍在，其余只剩最近使用的那个
    const evicted = pruneControllers(controllers, "idle3", 1);
    expect([...controllers.keys()].sort()).toEqual(["idle3", "live", "queued"]);
    expect(evicted.sort()).toEqual(["idle1", "idle2"]);
  });

  test("已在限额内 / dispose 抛错（被回调吞下）都不影响其余逐出", () => {
    __resetControllerCacheForTests();
    const controllers = new Map<string, CacheableController>();
    controllers.set("a", controller());
    controllers.set("b", controller());
    expect(pruneControllers(controllers, "b", 1)).toEqual(["a"]);

    const boom: CacheableController = {
      getState: () => ({ runStatus: "idle", queue: { steering: [], followUp: [] } }),
      dispose() {
        throw new Error("dispose failed");
      },
    };
    const controllers2 = new Map<string, CacheableController>([["x", boom], ["y", controller()]]);
    const errors: unknown[] = [];
    expect(pruneControllers(controllers2, "y", 1, (e) => errors.push(e))).toEqual(["x"]);
    expect(errors).toHaveLength(1);
    expect(controllers2.has("x")).toBe(false);
  });
});
