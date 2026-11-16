import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import {
  checkWebhookRequest,
  createWebhookGuardState,
  forgetWebhookDelivery,
  summarizeWebhook,
  verifyWebhookSignature,
  webhookSigningPayload,
  WEBHOOK_MAX_BODY_BYTES,
} from "../../src/automation/webhook-guard";

const SECRET = "a".repeat(64);
const BODY = '{"ok":true}';
const hmac = (payload: string, secret = SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
/** 请求签名 = HMAC(timestamp + "." + body) */
const sigAt = (timestamp: number, body = BODY, secret = SECRET): string =>
  hmac(webhookSigningPayload(timestamp, body), secret);
const seenKey = (triggerId: string, delivery: string): string => `${triggerId}\u0000${delivery}`;

describe("webhook 校验链（L1）", () => {
  test("验签：好签名通过；坏签名/缺前缀/长度不等拒绝", () => {
    const state = createWebhookGuardState();
    const ts = Date.now();
    const r1 = checkWebhookRequest(state, {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: sigAt(ts),
      timestamp: ts,
      delivery: "d1",
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.deduplicated).toBe(false);

    const r2 = checkWebhookRequest(state, {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: sigAt(ts, BODY, "b".repeat(64)),
      timestamp: ts,
      delivery: "d2",
    });
    expect(r2).toEqual({ ok: false, status: 401, reason: "invalid signature" });

    expect(verifyWebhookSignature(SECRET, BODY, "no-prefix")).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, "sha256=short")).toBe(false);
  });

  test("时间戳进 MAC：改时间戳重放旧签名被拒", () => {
    const state = createWebhookGuardState();
    const ts = Date.now();
    // 捕获一次合法请求的签名，但把 header 时间戳改成「现在」
    const captured = sigAt(ts - 60_000);
    const r = checkWebhookRequest(state, {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: captured,
      timestamp: ts,
      delivery: "replay-1",
    });
    expect(r).toEqual({ ok: false, status: 401, reason: "invalid signature" });
  });

  test("时间窗：偏移 >5 分钟拒绝（防重放）", () => {
    const state = createWebhookGuardState();
    const old = Date.now() - 6 * 60 * 1000;
    const r = checkWebhookRequest(state, {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: sigAt(old),
      timestamp: old,
      delivery: "d3",
    });
    expect(r).toEqual({ ok: false, status: 401, reason: "timestamp out of range" });
    const recent = Date.now() - 4 * 60 * 1000;
    const r2 = checkWebhookRequest(state, {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: sigAt(recent),
      timestamp: recent,
      delivery: "d4",
    });
    expect(r2.ok).toBe(true);
  });

  test("幂等：同 trigger 同 delivery 重发 → deduplicated，不进限流窗口", () => {
    const state = createWebhookGuardState();
    const now = Date.now();
    const base = {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: sigAt(now),
      timestamp: now,
      delivery: "dup",
      now,
    };
    const r1 = checkWebhookRequest(state, base);
    expect(r1.ok).toBe(true);
    const r2 = checkWebhookRequest(state, base);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.deduplicated).toBe(true);
    // 限流窗口只记了 1 次
    expect(state.rateWindows.get("trg-1")?.length).toBe(1);
  });

  test("幂等桶按 trigger 隔离：同 delivery 打到不同 trigger 各自触发", () => {
    const state = createWebhookGuardState();
    const now = Date.now();
    const base = {
      secret: SECRET,
      body: BODY,
      signature: sigAt(now),
      timestamp: now,
      delivery: "same",
      now,
    };
    const a = checkWebhookRequest(state, { ...base, triggerId: "trg-a" });
    const b = checkWebhookRequest(state, { ...base, triggerId: "trg-b" });
    expect(a.ok && !a.deduplicated).toBe(true);
    expect(b.ok && !b.deduplicated).toBe(true);
    expect(state.seenDeliveries.has(seenKey("trg-a", "same"))).toBe(true);
    expect(state.seenDeliveries.has(seenKey("trg-b", "same"))).toBe(true);
  });

  test("限流：同 trigger 60s 内第 11 次 → 429；窗口滑动后恢复", () => {
    const state = createWebhookGuardState();
    const base = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const r = checkWebhookRequest(state, {
        triggerId: "trg-1",
        secret: SECRET,
        body: BODY,
        signature: sigAt(base),
        timestamp: base,
        delivery: `rl-${i}`,
        now: base,
      });
      expect(r.ok).toBe(true);
    }
    const r11 = checkWebhookRequest(state, {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: sigAt(base),
      timestamp: base,
      delivery: "rl-11",
      now: base,
    });
    expect(r11).toEqual({ ok: false, status: 429, reason: "rate limited" });
    // 被 429 的 delivery 不能进幂等台账：窗口滑动后同 delivery 重试应真正触发
    expect(state.seenDeliveries.has(seenKey("trg-1", "rl-11"))).toBe(false);
    const retry = checkWebhookRequest(state, {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: sigAt(base),
      timestamp: base,
      delivery: "rl-11",
      now: base + 61_000,
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.deduplicated).toBe(false);
  });

  test("未受理时撤销幂等标记：同 delivery 可重试（只影响该 trigger）", () => {
    const state = createWebhookGuardState();
    const now = Date.now();
    const base = {
      secret: SECRET,
      body: BODY,
      signature: sigAt(now),
      timestamp: now,
      delivery: "retry",
      now,
    };
    const first = checkWebhookRequest(state, { ...base, triggerId: "trg-a" });
    expect(first.ok && !first.deduplicated).toBe(true);
    const otherBefore = checkWebhookRequest(state, { ...base, triggerId: "trg-b" });
    expect(otherBefore.ok && !otherBefore.deduplicated).toBe(true);
    forgetWebhookDelivery(state, "trg-a", "retry");
    const retry = checkWebhookRequest(state, { ...base, triggerId: "trg-a" });
    expect(retry.ok && !retry.deduplicated).toBe(true);
    // 另一个 trigger 的幂等标记不受影响
    const otherRetry = checkWebhookRequest(state, { ...base, triggerId: "trg-b" });
    expect(otherRetry.ok && otherRetry.deduplicated).toBe(true);
  });

  test("限流按 trigger 独立：一个打满不影响另一个", () => {
    const state = createWebhookGuardState();
    const base = Date.now();
    const hit = (triggerId: string, i: number) =>
      checkWebhookRequest(state, {
        triggerId,
        secret: SECRET,
        body: BODY,
        signature: sigAt(base),
        timestamp: base,
        delivery: `${triggerId}-${i}`,
        now: base,
      });
    for (let i = 0; i < 10; i += 1) expect(hit("trg-hot", i).ok).toBe(true);
    expect(hit("trg-hot", 10)).toEqual({ ok: false, status: 429, reason: "rate limited" });
    expect(hit("trg-cold", 0).ok).toBe(true);
  });

  test("幂等 LRU：超限淘汰一半最旧，最旧可重新通过", () => {
    const state = createWebhookGuardState();
    const base = Date.now();
    // 每 10 条滑过一分钟：避开限流（限流窗口按 trigger），只测幂等台账容量
    const at = (i: number) => base + Math.floor(i / 10) * 61_000;
    for (let i = 0; i < 1024; i += 1) {
      checkWebhookRequest(state, {
        triggerId: "trg-1",
        secret: SECRET,
        body: BODY,
        signature: sigAt(at(i)),
        timestamp: at(i),
        delivery: `d-${i}`,
        now: at(i),
      });
    }
    expect(state.seenDeliveries.size).toBe(1024);
    // 第 1025 条触发淘汰一半
    checkWebhookRequest(state, {
      triggerId: "trg-1",
      secret: SECRET,
      body: BODY,
      signature: sigAt(at(1024)),
      timestamp: at(1024),
      delivery: "d-1025",
      now: at(1024),
    });
    expect(state.seenDeliveries.size).toBeLessThan(1024);
    expect(state.seenDeliveries.has(seenKey("trg-1", "d-0"))).toBe(false);
    expect(state.seenDeliveries.has(seenKey("trg-1", "d-1025"))).toBe(true);
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
