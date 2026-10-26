import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";
import { resetWireBusForTests } from "@/lib/pi/wire-bus";
import {
  installRestartReconcile,
  reconcileAfterSidecarRestart,
  reconcileRunningControllers,
  resetRestartReconcileForTests,
  type RestartReconcilableController,
} from "./sidecar-restart-reconcile";

afterAll(() => {
  restoreAllMocks();
  resetWireBusForTests();
});

/** pi-chunk-batch 的 listen 桩（wire-bus 的唯一传输）与 toast 捕获 */
const listenersByEvent = new Map<string, (e: { payload: unknown }) => void>();
const toasts: { title?: string; description?: string }[] = [];

mockModule("@/desktop-bridge/event", () => ({
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    listenersByEvent.set(event, cb);
    return Promise.resolve(() => listenersByEvent.delete(event));
  },
}));
mockModule("@/components/ui/toast", () => ({
  toast: {
    message: (opts: { title?: string; description?: string }) => {
      toasts.push(opts);
    },
    error: () => {},
  },
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

const controllerStub = (
  state: { runStatus: string; compaction?: boolean; retry?: boolean },
): RestartReconcilableController & {
  refreshes: number;
  discards: number;
} => {
  let refreshes = 0;
  let discards = 0;
  return {
    getState: () => ({
      runStatus: state.runStatus,
      compaction: { active: state.compaction ?? false },
      retry: { active: state.retry ?? false },
    }),
    refresh: async () => {
      refreshes += 1;
    },
    discardLostPrompts: () => {
      discards += 1;
    },
    get refreshes() {
      return refreshes;
    },
    get discards() {
      return discards;
    },
  };
};

describe("reconcileRunningControllers（纯对账）", () => {
  test("只对在跑（running/压缩/重试）的控制器拉快照，空闲的不动", async () => {
    const running = controllerStub({ runStatus: "running" });
    const compacting = controllerStub({ runStatus: "idle", compaction: true });
    const retrying = controllerStub({ runStatus: "idle", retry: true });
    const idle = controllerStub({ runStatus: "idle" });

    const interrupted = reconcileRunningControllers([running, compacting, retrying, idle]);

    expect(interrupted).toBe(3);
    expect(running.refreshes).toBe(1);
    expect(compacting.refreshes).toBe(1);
    expect(retrying.refreshes).toBe(1);
    expect(idle.refreshes).toBe(0);
    // 空闲控制器立即收口 pending；在跑的等快照落定后再清乐观消息
    expect(idle.discards).toBe(1);
    await flush();
    expect(running.discards).toBe(1);
    expect(compacting.discards).toBe(1);
    expect(retrying.discards).toBe(1);
  });

  test("refresh 抛错不截断其余控制器，且仍会清理丢失的乐观消息", async () => {
    const failing = controllerStub({ runStatus: "running" });
    failing.refresh = async () => {
      throw new Error("snapshot failed");
    };
    const healthy = controllerStub({ runStatus: "running" });

    const interrupted = reconcileRunningControllers([failing, healthy]);
    expect(interrupted).toBe(2);
    await flush();
    expect(healthy.refreshes).toBe(1);
    expect(failing.discards).toBe(1);
    expect(healthy.discards).toBe(1);
  });

  test("在跑控制器：先拉快照，落定后才清丢失的乐观消息（避免删了又加）", async () => {
    const order: string[] = [];
    let release!: () => void;
    const controller: RestartReconcilableController = {
      getState: () => ({
        runStatus: "running",
        compaction: { active: false },
        retry: { active: false },
      }),
      refresh: () => {
        order.push("refresh");
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      discardLostPrompts: () => order.push("discard"),
    };

    reconcileRunningControllers([controller]);
    await flush();
    expect(order).toEqual(["refresh"]);

    release();
    await flush();
    expect(order).toEqual(["refresh", "discard"]);
  });

  test("discardLostPrompts 必须按方法调用（类实例的 this 不能丢）", async () => {
    class ControllerStub implements RestartReconcilableController {
      discards = 0;
      getState() {
        return {
          runStatus: "idle",
          compaction: { active: false },
          retry: { active: false },
        };
      }
      async refresh() {}
      discardLostPrompts() {
        // 裸取函数引用调用时这里 this 为 undefined → 抛错
        this.discards += 1;
      }
    }
    const stub = new ControllerStub();
    reconcileRunningControllers([stub]);
    expect(stub.discards).toBe(1);
  });

  test("discard 抛错不打断其余控制器与对账", () => {
    const bad = controllerStub({ runStatus: "idle" });
    bad.discardLostPrompts = () => {
      throw new Error("boom");
    };
    const good = controllerStub({ runStatus: "idle" });
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => reconcileRunningControllers([bad, good])).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(good.discards).toBe(1);
  });
});

describe("installRestartReconcile（wire 装订）", () => {
  // installer 是模块级单例（首个 getter 终身生效）：装订一次，用例间只换
  // getter 读到的 registry
  let currentRegistry: {
    disposed: boolean;
    controllers: Map<string, RestartReconcilableController>;
  } | null = null;

  beforeAll(async () => {
    // 自锚边界（见 lib/testing/mock-module 头注）：先掐掉此前测试文件装订的
    // wire-bus 传输（它可能指向别的文件泄漏的 listen 桩），并复位装订标记
    // （别的文件若经 usePiRuntime 装订过，生产 getter 会先占位），让本次订阅
    // 用本文件的 mock 与 getter 重新装订
    resetWireBusForTests();
    resetRestartReconcileForTests();
    installRestartReconcile(() => currentRegistry);
    await flush(); // 订阅传输就绪
  });

  const dispatchFrame = (line: string) => {
    listenersByEvent.get("pi-chunk-batch")!({ payload: [{ i: null, l: line }] });
    return flush();
  };

  test("pi_restarted 帧触发对账：在跑的归位、空闲不动、有中断才提示", async () => {
    const running = controllerStub({ runStatus: "running" });
    const idle = controllerStub({ runStatus: "idle" });
    currentRegistry = {
      disposed: false,
      controllers: new Map([["a", running], ["b", idle]]),
    };

    await dispatchFrame('{"type":"pi_restarted"}');

    expect(running.refreshes).toBe(1);
    expect(idle.refreshes).toBe(0);
    expect(toasts.some((t) => t.title === "AI 服务已重启")).toBe(true);
  });

  test("registry 已 disposed / 无 registry：帧是无害 no-op", async () => {
    const running = controllerStub({ runStatus: "running" });
    currentRegistry = { disposed: true, controllers: new Map([["a", running]]) };
    const toastsBefore = toasts.length;

    await dispatchFrame('{"type":"pi_restarted"}');
    expect(running.refreshes).toBe(0);

    currentRegistry = null;
    await dispatchFrame('{"type":"pi_restarted"}');
    expect(running.refreshes).toBe(0);
    expect(toasts.length).toBe(toastsBefore);
  });

  test("无关帧不触发对账", async () => {
    const running = controllerStub({ runStatus: "running" });
    currentRegistry = { disposed: false, controllers: new Map([["a", running]]) };

    await dispatchFrame('{"type":"sessions_changed","op":"updated","sessionId":"x"}');

    expect(running.refreshes).toBe(0);
  });

  test("reconcileAfterSidecarRestart 直接触发同一对账（远程 WS 帧源复用）", async () => {
    const running = controllerStub({ runStatus: "running" });
    const idle = controllerStub({ runStatus: "idle" });
    currentRegistry = {
      disposed: false,
      controllers: new Map([["a", running], ["b", idle]]),
    };

    reconcileAfterSidecarRestart();

    expect(running.refreshes).toBe(1);
    expect(idle.refreshes).toBe(0);
    expect(idle.discards).toBe(1);
    await flush();
    expect(running.discards).toBe(1);
  });
});
