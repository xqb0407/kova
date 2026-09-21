import { describe, expect, test } from "bun:test";
import { createPiResumableStreamStorage } from "@/lib/pi/pi-resume-storage";

/**
 * 刷新续流登记的认领语义测试（双 session bug 与"多会话并发在飞"的回归防线）：
 * 框架原生 createResumableSessionStorage 不持久化 owner，刷新后新生成的
 * 随机草稿会劫持在飞登记（"新对话"行挂流、真实会话另成一行）。本实现按线程
 * 多槽登记、owner/sessionId 双轨认领，随机草稿永远认领不了；且 B 的登记不会
 * 顶掉 A（2026-09-14 实测：单槽被顶后 A 点开只剩已落盘的用户消息）。
 */

function memStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function setup() {
  const store = memStorage();
  const storage = createPiResumableStreamStorage(() => store);
  return { store, storage };
}

describe("piResumableStreamStorage 认领规则", () => {
  test("owner 线程可读回；其他线程（含新随机草稿）认领不了", () => {
    const { storage } = setup();
    storage.setStreamId("pi-req-1", "draft-A", "session-1");
    expect(storage.getStreamId("draft-A")).toBe("pi-req-1");
    // 模拟刷新：新挂载的草稿 id 与 owner 不同且非任何会话 → 拿不到
    expect(storage.getStreamId("draft-B-random")).toBeNull();
    expect(storage.getStreamId(undefined)).toBeNull();
  });

  test("刷新后以 remoteId（===sessionId）为 id 的会话列表行可认领续流", () => {
    const { storage } = setup();
    storage.setStreamId("pi-req-1", "draft-A", "session-1");
    expect(storage.getStreamId("session-1")).toBe("pi-req-1");
    expect(storage.peekEntries()).toEqual([
      { requestId: "pi-req-1", ownerChatId: "draft-A", sessionId: "session-1" },
    ]);
  });

  test("登记时 sessionId 未就绪：仅 owner 可认领，刷新后无人劫持", () => {
    const { storage } = setup();
    storage.setStreamId("pi-req-1", "draft-A");
    expect(storage.getStreamId("draft-A")).toBe("pi-req-1");
    expect(storage.getStreamId("session-1")).toBeNull();
    expect(storage.getStreamId("draft-B-random")).toBeNull();
  });

  test("多会话并发：B 的登记不顶掉 A，各自 owner/会话行都能认领自己的槽", () => {
    const { storage } = setup();
    storage.setStreamId("pi-req-A", "draft-A", "session-A");
    storage.setStreamId("pi-req-B", "draft-B", "session-B");
    expect(storage.getStreamId("session-A")).toBe("pi-req-A");
    expect(storage.getStreamId("session-B")).toBe("pi-req-B");
    expect(storage.peekEntries()).toHaveLength(2);
  });

  test("同线程连发顶掉旧槽（owner 粒度）；同会话换线程登记时旧草稿槽一并清除", () => {
    const { storage } = setup();
    storage.setStreamId("pi-req-1", "draft-A", "session-1");
    storage.setStreamId("pi-req-2", "draft-A", "session-1");
    expect(storage.getStreamId("draft-A")).toBe("pi-req-2");
    expect(storage.peekEntries()).toHaveLength(1);
    // 用户点开会话行（id===remoteId）再发：会话粒度互斥，旧草稿槽被顶
    storage.setStreamId("pi-req-3", "session-1", "session-1");
    expect(storage.peekEntries()).toHaveLength(1);
    expect(storage.getStreamId("draft-A")).toBeNull();
    expect(storage.getStreamId("session-1")).toBe("pi-req-3");
  });

  test("clear 只清自己认领的槽；A 收尾不误删 B 的在飞登记", () => {
    const { storage } = setup();
    storage.setStreamId("pi-req-A", "draft-A", "session-A");
    storage.setStreamId("pi-req-B", "draft-B", "session-B");
    // B 线程盲清 A？——matches 不中，无效
    storage.clear("draft-B-random");
    expect(storage.getStreamId("draft-A")).toBe("pi-req-A");
    storage.clear("session-A");
    expect(storage.getStreamId("draft-A")).toBeNull();
    expect(storage.getStreamId("session-B")).toBe("pi-req-B");
    expect(storage.peekEntries()).toHaveLength(1);
  });

  test("旧版单对象格式：读取兼容为一条槽，不被当作损坏丢弃", () => {
    const { store, storage } = setup();
    store.map.set(
      "pi-resumable-stream",
      JSON.stringify({ requestId: "pi-legacy", ownerChatId: "draft-L", sessionId: "session-L" }),
    );
    expect(storage.getStreamId("session-L")).toBe("pi-legacy");
    expect(storage.peekEntries()).toHaveLength(1);
  });

  test("裸字符串（框架原生）/损坏值：读取自愈清除而非抛错", () => {
    const { store, storage } = setup();
    store.map.set("pi-resumable-stream", "pi-legacy-raw-id");
    expect(storage.getStreamId("draft-A")).toBeNull();
    expect(store.map.has("pi-resumable-stream")).toBe(false);
    store.map.set("pi-resumable-stream", "{not json");
    expect(storage.peekEntries()).toEqual([]);
    expect(store.map.has("pi-resumable-stream")).toBe(false);
  });

  test("subscribe 感知登记变化，退订后停发", () => {
    const { storage } = setup();
    let ticks = 0;
    const un = storage.subscribe(() => {
      ticks += 1;
    });
    storage.setStreamId("pi-req-1", "draft-A", "session-1");
    expect(ticks).toBe(1);
    storage.clear("draft-A");
    expect(ticks).toBe(2);
    un();
    storage.setStreamId("pi-req-2", "draft-A", "session-1");
    expect(ticks).toBe(2);
  });

  test("超上限按登记序淘汰最旧", () => {
    const { storage } = setup();
    for (let i = 0; i < 12; i += 1) {
      storage.setStreamId(`pi-req-${i}`, `draft-${i}`, `session-${i}`);
    }
    expect(storage.peekEntries()).toHaveLength(10);
    expect(storage.getStreamId("session-0")).toBeNull();
    expect(storage.getStreamId("session-11")).toBe("pi-req-11");
  });

  test("存储不可用（隐私模式）：页内镜像维持同页读写一致，跨刷新降级", () => {
    const storage = createPiResumableStreamStorage(() => null);
    storage.setStreamId("pi-req-1", "draft-A", "session-1");
    // 同页内认领/清理照常——运行态水合（hydrate/findRunningTurn）同页 set 后
    // 随即 switch 到会话行 getStreamId 要能命中，不能因存储死亡而整体失效
    expect(storage.getStreamId("draft-A")).toBe("pi-req-1");
    expect(storage.getStreamId("session-1")).toBe("pi-req-1");
    storage.clear("draft-A");
    expect(storage.peekEntries()).toEqual([]);
    // 刷新 = 模块实例重建，内存镜像随之消失：登记不再存在（续流降级）
    expect(createPiResumableStreamStorage(() => null).peekEntries()).toEqual([]);
  });

  test("影子镜像：主槽被整页清空（webview 重建）时登记从镜像接管", () => {
    const store = memStorage();
    const shadow = memStorage();
    const storage = createPiResumableStreamStorage(() => store, () => shadow);
    storage.setStreamId("pi-req-1", "draft-A", "session-1");
    storage.setStreamId("pi-req-2", "draft-B", "session-2");
    expect(JSON.parse(shadow.map.get("pi-resumable-stream") ?? "null")).toEqual([
      { requestId: "pi-req-1", ownerChatId: "draft-A", sessionId: "session-1" },
      { requestId: "pi-req-2", ownerChatId: "draft-B", sessionId: "session-2" },
    ]);
    store.map.clear(); // 模拟 app 重启/webview 重建清空 sessionStorage
    expect(storage.getStreamId("session-1")).toBe("pi-req-1");
    expect(storage.getStreamId("session-2")).toBe("pi-req-2");
  });

  test("clear 同步删除影子镜像；陈旧镜像不复活", () => {
    const shadow = memStorage();
    const storage = createPiResumableStreamStorage(() => memStorage(), () => shadow);
    storage.setStreamId("pi-req-1", "draft-A", "session-1");
    storage.clear("session-1");
    expect(shadow.map.has("pi-resumable-stream")).toBe(false);
    expect(storage.peekEntries()).toEqual([]);
  });

  test("主槽读写全部抛异常：页内镜像兜底同页操作", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const storage = createPiResumableStreamStorage(
      () => broken,
      () => memStorage(),
    );
    storage.setStreamId("pi-req-1", "draft-A", "session-1");
    expect(storage.getStreamId("session-1")).toBe("pi-req-1");
    storage.clear("session-1");
    expect(storage.peekEntries()).toEqual([]);
  });
});
