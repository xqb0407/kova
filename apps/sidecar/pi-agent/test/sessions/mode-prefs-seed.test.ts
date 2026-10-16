/**
 * 新建会话的生效档位当场落进偏好行。
 *
 * 之前这两列留在 NULL：建会话时 run 按 kv「最近一次使用」装配，而 NULL 在重建时
 * 按 decodeApprovalLevel 解码回 ask——同一条对话会出现「被驱逐重建/重启后突然开始
 * 弹卡」，反过来也会「重启后从严格档滑回宽松档」，两条都无从排查。
 *
 * 这里钉三件事（顺序即用例顺序，共用同一个库，kv 状态靠前一例的写入累积）：
 * 1. 没有任何 kv 行（全新库）→ agent/ask，与旧行为一致；
 * 2. kv 有值 → 偏好行写着 run 真正用的档，驱逐重建后仍是同一档；
 * 3. kv 损坏（非 JSON）→ 回落 agent/ask，且照样落库。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
import { dropRun, resolveSession } from "../../src/sessions/sessions";
import { kvSet, sessionGet } from "../../src/storage/hostdb";

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
});
