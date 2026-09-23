/**
 * UI 插件桥解码层的测试：decodeUiMessage 是 iframe 第三方代码的安全边界，
 * 逐 kind 验证「收 / 拒」：协议版本、方向、路径逃逸、权限映射、长度上限。
 */
import { describe, expect, test } from "bun:test";
import {
  decodeUiMessage,
  encodeHostMessage,
  MESSAGE_PERMISSION,
  UI_PLUGIN_PROTOCOL,
} from "@/lib/plugins/ui-plugin-bridge";

const ui = (kind: string, payload: Record<string, unknown> = {}) => ({
  v: UI_PLUGIN_PROTOCOL,
  dir: "ui",
  kind,
  ...payload,
});

describe("decodeUiMessage 线路校验", () => {
  test("非本协议 / 非 ui 方向 / 非对象 → null", () => {
    expect(decodeUiMessage(null)).toBeNull();
    expect(decodeUiMessage("x")).toBeNull();
    expect(decodeUiMessage({})).toBeNull();
    expect(decodeUiMessage({ v: "other/1", dir: "ui", kind: "ui.ready" })).toBeNull();
    // 宿主帧绝不能被当成 UI 帧解码
    expect(decodeUiMessage(encodeHostMessage({ kind: "view.focus" }))).toBeNull();
  });

  test("未知 kind 静默丢弃（向前兼容）", () => {
    expect(decodeUiMessage(ui("some.future.kind"))).toBeNull();
  });

  test("无权限信号：ui.ready / doc.request 原样成形", () => {
    expect(decodeUiMessage(ui("ui.ready"))).toEqual({ kind: "ui.ready" });
    expect(decodeUiMessage(ui("doc.request"))).toEqual({ kind: "doc.request" });
  });

  test("doc.change：json 必填字符串且有长度上限", () => {
    expect(decodeUiMessage(ui("doc.change", { json: "{}" }))).toEqual({
      kind: "doc.change",
      json: "{}",
    });
    expect(decodeUiMessage(ui("doc.change"))).toBeNull();
    expect(decodeUiMessage(ui("doc.change", { json: 42 }))).toBeNull();
    expect(decodeUiMessage(ui("doc.change", { json: "x".repeat(8_000_001) }))).toBeNull();
  });

  test("doc.create：path 必须 workspace 相对（拒绝对齐路径/.. /空段/绝对）", () => {
    const ok = decodeUiMessage(ui("doc.create", { path: "a/b.canvas.json", json: "{}" }));
    expect(ok).toEqual({ kind: "doc.create", path: "a/b.canvas.json", json: "{}" });
    for (const bad of ["/abs.json", "../out.json", "a/../b.json", "a//b.json", "./a.json", ""]) {
      expect(decodeUiMessage(ui("doc.create", { path: bad, json: "{}" }))).toBeNull();
    }
  });

  test("doc.attach：name 限单段文件名，base64 有上限", () => {
    expect(decodeUiMessage(ui("doc.attach", { name: "pic.png", base64: "AAAA" }))).toEqual({
      kind: "doc.attach",
      name: "pic.png",
      base64: "AAAA",
    });
    // 不给路径自由度：资产目录由宿主拼
    expect(decodeUiMessage(ui("doc.attach", { name: "sub/pic.png", base64: "A" }))).toBeNull();
    expect(decodeUiMessage(ui("doc.attach", { name: "..", base64: "A" }))).toBeNull();
    expect(decodeUiMessage(ui("doc.attach", { name: "a.png", base64: "x".repeat(45_000_001) }))).toBeNull();
  });

  test("doc.export：filename 允许相对子目录", () => {
    expect(
      decodeUiMessage(ui("doc.export", { filename: "out/deck.pptx", base64: "AA" })),
    ).toEqual({ kind: "doc.export", filename: "out/deck.pptx", base64: "AA" });
    expect(decodeUiMessage(ui("doc.export", { filename: "../deck.pptx", base64: "AA" }))).toBeNull();
  });

  test("asset.request：reqId 限长 + path 相对", () => {
    expect(
      decodeUiMessage(ui("asset.request", { reqId: "a1", path: "deck.assets/x.png" })),
    ).toEqual({ kind: "asset.request", reqId: "a1", path: "deck.assets/x.png" });
    expect(decodeUiMessage(ui("asset.request", { reqId: "x".repeat(129), path: "a.png" }))).toBeNull();
    expect(decodeUiMessage(ui("asset.request", { reqId: "a1", path: "/etc/passwd" }))).toBeNull();
  });

  test("agent.prefill：100K 上限", () => {
    expect(decodeUiMessage(ui("agent.prefill", { text: "帮我改标题" }))).toEqual({
      kind: "agent.prefill",
      text: "帮我改标题",
    });
    expect(decodeUiMessage(ui("agent.prefill", { text: "x".repeat(100_001) }))).toBeNull();
  });

  test("ui.notify：level 白名单，缺省不带键", () => {
    expect(decodeUiMessage(ui("ui.notify", { text: "已导出" }))).toEqual({
      kind: "ui.notify",
      text: "已导出",
    });
    expect(decodeUiMessage(ui("ui.notify", { text: "坏了", level: "error" }))).toEqual({
      kind: "ui.notify",
      text: "坏了",
      level: "error",
    });
    expect(decodeUiMessage(ui("ui.notify", { text: "x", level: "fatal" }))).toEqual({
      kind: "ui.notify",
      text: "x",
    });
  });
});

describe("权限映射与宿主编码", () => {
  test("MESSAGE_PERMISSION 覆盖全部需门控的 kind", () => {
    expect(MESSAGE_PERMISSION["doc.change"]).toBe("document");
    expect(MESSAGE_PERMISSION["doc.attach"]).toBe("document");
    expect(MESSAGE_PERMISSION["asset.request"]).toBe("document");
    expect(MESSAGE_PERMISSION["doc.export"]).toBe("export");
    expect(MESSAGE_PERMISSION["agent.prefill"]).toBe("agent");
    expect(MESSAGE_PERMISSION["ui.notify"]).toBe("notify");
    // ui.ready / doc.request 无需权限（握手期就要能发）
    expect(MESSAGE_PERMISSION["ui.ready"]).toBeUndefined();
  });

  test("encodeHostMessage 带协议头与方向", () => {
    const m = encodeHostMessage({ kind: "doc.open", rev: 3, json: "{}", external: true });
    expect(m).toEqual({ v: UI_PLUGIN_PROTOCOL, dir: "host", kind: "doc.open", rev: 3, json: "{}", external: true });
  });
});
