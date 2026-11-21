/**
 * 新建会话的生效档位当场落进偏好行。
 *
 * 之前这两列留在 NULL：建会话时 run 按 kv「最近一次使用」装配，而 NULL 在重建时
 * 按 decodeApprovalLevel 解码回 ask——同一条对话会出现「被驱逐重建/重启后突然开始
 * 弹卡」，反过来也会「重启后从严格档滑回宽松档」，两条都无从排查。
 *
 * 这里钉五件事（顺序即用例顺序，共用同一个库，kv 状态靠前一例的写入累积）：
 * 1. 没有任何 kv 行（全新库）→ agent/ask，与旧行为一致；
 * 2. kv 有值 → 偏好行写着 run 真正用的档，驱逐重建后仍是同一档；
 * 3. kv 损坏（非 JSON）→ 回落 agent/ask，且照样落库；
 * 4. kv = plan/goal（旧版污染）：mode 回落 agent（plan/goal 不作新会话默认），
 *    approvalLevel 仍跟随——模式与档位两条偏好各自独立；
 * 5. applyMode 写侧：plan/goal 不写 kv（模型自主 plan_enter 不污染新会话默认），
 *    agent/ask 照写。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
import { dropRun, resolveSession } from "../../src/sessions/sessions";
import { kvGet, kvSet, sessionGet } from "../../src/storage/hostdb";
import { applyMode } from "../../src/agent/modes";

/** persistModePrefs 的落库是 fire-and-forget：让一拍事件循环再断言，避免读写竞态 */
const settle = () => new Promise((r) => setTimeout(r, 10));

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mode-seed-"));
// 建会话会合成提示词并实时读身份文件：钉到空目录，避免触碰开发者真实 ~/.kova/
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
});

afterAll(() => {
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

describe("新会话的模式偏好种子", () => {
  test("kv 无行（全新库）：落 agent/ask", async () => {
    const run = await resolveSession("seed-thread-no-kv");
    expect(run.mode).toBe("agent");
    expect(run.approvalLevel).toBe("ask");

    const row = await sessionGet(run.sessionId);
    expect(row?.mode).toBe("agent");
    expect(row?.approvalLevel).toBe("ask");
  });

  test("kv 有值：落库 = 建会话时读到的「最近一次使用」档；驱逐重建后不漂", async () => {
    await kvSet("pi.mode", JSON.stringify({ mode: "agent", approvalLevel: "review" }));

    const run = await resolveSession("seed-thread-review");
    expect(run.approvalLevel).toBe("review");

    const row = await sessionGet(run.sessionId);
    expect(row?.mode).toBe("agent");
    expect(row?.approvalLevel).toBe("review");

    // 驱逐（LRU/重启的等价物）后按偏好行重建：仍是 review，而不是 NULL→ask
    dropRun(run.threadId);
    const reborn = await resolveSession("seed-thread-review", run.sessionId);
    expect(reborn.approvalLevel).toBe("review");
  });

  test("kv 损坏：回落 agent/ask，且照样落库", async () => {
    await kvSet("pi.mode", "{ 这不是 JSON");

    const run = await resolveSession("seed-thread-corrupt-kv");
    expect(run.approvalLevel).toBe("ask");

    const row = await sessionGet(run.sessionId);
    expect(row?.approvalLevel).toBe("ask");
  });

  test("kv = plan（旧版污染）：mode 回落 agent，approvalLevel 仍跟随", async () => {
    await kvSet("pi.mode", JSON.stringify({ mode: "plan", approvalLevel: "review" }));

    const run = await resolveSession("seed-thread-polluted-plan");
    expect(run.mode).toBe("agent");
    expect(run.approvalLevel).toBe("review");

    const row = await sessionGet(run.sessionId);
    expect(row?.mode).toBe("agent");
    expect(row?.approvalLevel).toBe("review");
  });

  test("kv = goal（旧版污染）：同样回落 agent", async () => {
    await kvSet("pi.mode", JSON.stringify({ mode: "goal", approvalLevel: "ask" }));

    const run = await resolveSession("seed-thread-polluted-goal");
    expect(run.mode).toBe("agent");
    expect(run.approvalLevel).toBe("ask");
  });
});

describe("applyMode 的 kv 写侧：plan/goal 不入「最近一次使用」", () => {
  test("plan/goal 不写 kv（模型自主 plan_enter 不污染新会话默认），agent/ask 照写", async () => {
    await kvSet("pi.mode", JSON.stringify({ mode: "agent", approvalLevel: "ask" }));
    const kvBaseline = (await kvGet("pi.mode"))?.value;

    const run = await resolveSession("seed-thread-apply-mode");
    // plan_enter / ensureGoalMode 的等价调用：kv 原样，会话偏好行照写
    // （驱逐/重启后恢复该会话仍应停在 plan/goal——那是单会话的工作态）
    applyMode(run, "plan");
    await settle();
    expect((await kvGet("pi.mode"))?.value).toBe(kvBaseline);
    expect((await sessionGet(run.sessionId))?.mode).toBe("plan");

    applyMode(run, "goal");
    await settle();
    expect((await kvGet("pi.mode"))?.value).toBe(kvBaseline);
    expect((await sessionGet(run.sessionId))?.mode).toBe("goal");

    // agent/ask 才是可作新会话默认的档：照写 kv
    applyMode(run, "agent");
    await settle();
    expect((await kvGet("pi.mode"))?.value).toBe(
      JSON.stringify({ mode: "agent", approvalLevel: run.approvalLevel }),
    );

    applyMode(run, "ask");
    await settle();
    expect((await kvGet("pi.mode"))?.value).toBe(
      JSON.stringify({ mode: "ask", approvalLevel: run.approvalLevel }),
    );
  });
});
