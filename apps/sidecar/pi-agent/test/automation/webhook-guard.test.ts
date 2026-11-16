import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import {
  checkWebhookRequest,
  createWebhookGuardState,
  summarizeWebhook,
  verifyWebhookSignature,
  WEBHOOK_MAX_BODY_BYTES,
} from "../../src/automation/webhook-guard";

const SECRET = "a".repeat(64);
const BODY = '{"ok":true}';
const sigOf = (body = BODY, secret = SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

describe("webhook 校验链（L1a）", () => {
  test("验签：好签名通过；坏签名/缺前缀/长度不等拒绝", () => {
    const state = createWebhookGuardState();
    const r1 = checkWebhookRequest(state, {
      secret: SECRET,
      body: BODY,
      signature: sigOf(),
      timestamp: Date.now(),
      delivery: "d1",
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.deduplicated).toBe(false);

    const r2 = checkWebhookRequest(state, {
      secret: SECRET,
      body: BODY,
      signature: sigOf(BODY, "b".repeat(64)),
      timestamp: Date.now(),
      delivery: "d2",
    });
    expect(r2).toEqual({ ok: false, status: 401, reason: "invalid signature" });

    expect(verifyWebhookSignature(SECRET, BODY, "no-prefix")).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, "sha256=short")).toBe(false);
  });

  test("时间窗：偏移 >5 分钟拒绝（防重放）", () => {
    const state = createWebhookGuardState();
    const r = checkWebhookRequest(state, {
      secret: SECRET,
      body: BODY,
      signature: sigOf(),
      timestamp: Date.now() - 6 * 60 * 1000,
      delivery: "d3",
    });
    expect(r).toEqual({ ok: false, status: 401, reason: "timestamp out of range" });
    const r2 = checkWebhookRequest(state, {
      secret: SECRET,
      body: BODY,
      signature: sigOf(),
      timestamp: Date.now() - 4 * 60 * 1000,
      delivery: "d4",
    });
    expect(r2.ok).toBe(true);
  });

  test("幂等：同 delivery 重发 → deduplicated，不进限流窗口", () => {
    const state = createWebhookGuardState();
    const now = Date.now();
    const r1 = checkWebhookRequest(state, {
      secret: SECRET, body: BODY, signature: sigOf(), timestamp: now, delivery: "dup",
      now,
    });
    expect(r1.ok).toBe(true);
    const r2 = checkWebhookRequest(state, {
      secret: SECRET, body: BODY, signature: sigOf(), timestamp: now, delivery: "dup",
      now,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.deduplicated).toBe(true);
    // 限流窗口只记了 1 次
    expect(state.rateWindows.get("")?.length).toBe(1);
  });

  test("限流：60s 内第 11 次 → 429；窗口滑动后恢复", () => {
    const state = createWebhookGuardState();
    const base = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const r = checkWebhookRequest(state, {
        secret: SECRET, body: BODY, signature: sigOf(), timestamp: base, delivery: `rl-${i}`,
        now: base,
      });
      expect(r.ok).toBe(true);
    }
    const r11 = checkWebhookRequest(state, {
      secret: SECRET, body: BODY, signature: sigOf(), timestamp: base, delivery: "rl-11",
      now: base,
    });
    expect(r11).toEqual({ ok: false, status: 429, reason: "rate limited" });
    // 61s 后窗口滑动，恢复放行
    const r12 = checkWebhookRequest(state, {
      secret: SECRET, body: BODY, signature: sigOf(), timestamp: base, delivery: "rl-12",
      now: base + 61_000,
    });
    expect(r12.ok).toBe(true);
  });

  test("幂等 LRU：超限淘汰一半最旧，最旧可重新通过", () => {
    const state = createWebhookGuardState();
    const now = Date.now();
    for (let i = 0; i < 1024; i += 1) {
      checkWebhookRequest(state, {
        secret: SECRET, body: BODY, signature: sigOf(), timestamp: now, delivery: `d-${i}`,
        now,
      });
    }
    expect(state.seenDeliveries.size).toBe(1024);
    // 第 1025 条触发淘汰一半
    checkWebhookRequest(state, {
      secret: SECRET, body: BODY, signature: sigOf(), timestamp: now, delivery: "d-1025",
      now,
    });
    expect(state.seenDeliveries.size).toBeLessThan(1024);
    expect(state.seenDeliveries.has("d-0")).toBe(false);
    expect(state.seenDeliveries.has("d-1025")).toBe(true);
  });

  test("summarizeWebhook：事件头 + body 预览，多值 header 取首个", () => {
    expect(
      summarizeWebhook(
        { "x-github-event": ["push", "ping"], "x-gitlab-event": "" },
        '{"ref":"refs/heads/main"}',
      ),
    ).toBe("push: {\"ref\":\"refs/heads/main\"}");
    expect(summarizeWebhook({}, "   \n ")).toBe("(empty body)");
    const long = "x".repeat(300);
    expect(summarizeWebhook({}, long).length).toBe(160);
  });

  test("body 上限常量 64KB（读取层执行，这里固化契约）", () => {
    expect(WEBHOOK_MAX_BODY_BYTES).toBe(64 * 1024);
  });
});
