/**
 * 新会话初始模型：最近使用（可用）→ 默认模型（可用）→ 旧兜底。
 *
 * 钉住三件事：
 * 1. lastUsed 命中：run 用缓存模型，并钉进偏好列（刷新/恢复后不回落默认）；
 * 2. 缓存失效：改写成默认模型，新会话用默认（默认兜底不落偏好列，保持旧语义）；
 * 3. 已建会话没有自己的模型记录：恢复时仍只认默认，不被 lastUsed 漂移带走。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
import { dropRun, resolveSession } from "../../src/sessions/sessions";
import {
  customProviderUpsert,
  modelsReplace,
  sessionGet,
} from "../../src/storage/hostdb";
import {
  getLastUsedModelKey,
  getModels,
  registerCustomProvider,
  setCurrentModelKey,
  setLastUsedModelKey,
} from "../../src/model/model-catalog";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-new-session-model-"));
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

async function register(id: string, modelId: string): Promise<void> {
  const baseUrl = `https://${id}.example.com/v1`;
  await customProviderUpsert({
    id,
    name: id,
    baseUrl,
    models: "[]",
    api: "openai-chat",
  });
  await modelsReplace(id, [{ modelId, enabled: true }]);
  await registerCustomProvider({ id, name: id, baseUrl, api: "openai-chat" });
}

beforeAll(async () => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
  await register("ns-a", "ma");
  await register("ns-b", "mb");
});

// 同进程其它测试文件会读全局模型键：每个用例结束立刻归零，缩短污染窗口
afterEach(async () => {
  await setLastUsedModelKey(null);
  setCurrentModelKey(null);
});

afterAll(() => {
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

describe("新会话初始模型", () => {
  test("lastUsed 命中：用它应答，并钉进偏好列", async () => {
    await setLastUsedModelKey({ provider: "ns-a", modelId: "ma" });
    setCurrentModelKey({ provider: "ns-b", modelId: "mb" });

    const run = await resolveSession("ns-thread-last-used");
    expect(run.agent.state.model?.provider).toBe("ns-a");
    expect(run.agent.state.model?.id).toBe("ma");

    const row = await sessionGet(run.sessionId);
    expect(row?.modelProvider).toBe("ns-a");
    expect(row?.modelId).toBe("ma");
    dropRun(run.threadId);
  });

  test("请求携带界面显示模型：优先于 lastUsed，并钉进偏好列", async () => {
    // 缓存说 ns-a（最近使用），但界面上显示的是 ns-b：以界面为准——
    // 否则首轮会用另一个模型应答，显示层再被回拉改回来（A→B→A 抖动）
    await setLastUsedModelKey({ provider: "ns-a", modelId: "ma" });
    setCurrentModelKey({ provider: "ns-a", modelId: "ma" });

    const run = await resolveSession(
      "ns-thread-requested",
      undefined,
      undefined,
      undefined,
      undefined,
      { provider: "ns-b", modelId: "mb" },
    );
    expect(run.agent.state.model?.provider).toBe("ns-b");
    expect(run.agent.state.model?.id).toBe("mb");

    const row = await sessionGet(run.sessionId);
    expect(row?.modelProvider).toBe("ns-b");
    expect(row?.modelId).toBe("mb");
    // 两边缓存已漂移（缓存 A、界面 B）：以实际采用的 B 校正最近使用，
    // 否则下一轮新对话/重启后的首选还会沿用旧缓存
    expect(getLastUsedModelKey()).toEqual({ provider: "ns-b", modelId: "mb" });
    dropRun(run.threadId);
  });

  test("请求模型就是默认模型：不钉偏好列，也不改写最近使用", async () => {
    // 「没显式选过、显示回退到默认」的情形：保持「跟随默认」的旧语义，
    // 后续默认模型变更仍能影响这个会话（显式选同一模型走定靶 set_model，
    // 照样落列，不受影响）
    await setLastUsedModelKey(null);
    setCurrentModelKey({ provider: "ns-b", modelId: "mb" });

    const run = await resolveSession(
      "ns-thread-requested-default",
      undefined,
      undefined,
      undefined,
      undefined,
      { provider: "ns-b", modelId: "mb" },
    );
    expect(run.agent.state.model?.provider).toBe("ns-b");
    const row = await sessionGet(run.sessionId);
    expect(row?.modelProvider ?? null).toBeNull();
    expect(row?.modelId ?? null).toBeNull();
    expect(getLastUsedModelKey()).toBeNull();
    dropRun(run.threadId);
  });

  test("请求模型不可用：不报错，落回 lastUsed 链", async () => {
    await setLastUsedModelKey({ provider: "ns-a", modelId: "ma" });
    setCurrentModelKey({ provider: "ns-b", modelId: "mb" });

    const run = await resolveSession(
      "ns-thread-requested-gone",
      undefined,
      undefined,
      undefined,
      undefined,
      { provider: "ns-missing", modelId: "gone" },
    );
    expect(run.agent.state.model?.provider).toBe("ns-a");
    expect(run.agent.state.model?.id).toBe("ma");
    dropRun(run.threadId);
  });

  test("lastUsed 失效：改写成默认模型，新会话用默认且不钉偏好列", async () => {
    // ns-a 从目录移除 = provider 被删/停用的等价物
    getModels().deleteProvider("ns-a");
    await setLastUsedModelKey({ provider: "ns-a", modelId: "ma" });
    setCurrentModelKey({ provider: "ns-b", modelId: "mb" });

    const run = await resolveSession("ns-thread-default");
    expect(run.agent.state.model?.provider).toBe("ns-b");
    expect(run.agent.state.model?.id).toBe("mb");

    // 默认兜底不落偏好列：没显式选过的会话继续跟随默认模型
    const row = await sessionGet(run.sessionId);
    expect(row?.modelProvider ?? null).toBeNull();
    expect(row?.modelId ?? null).toBeNull();
    dropRun(run.threadId);
  });

  test("已建会话没有自己的记录：恢复时仍只认默认，不被 lastUsed 漂移", async () => {
    await setLastUsedModelKey(null);
    setCurrentModelKey({ provider: "ns-b", modelId: "mb" });

    const first = await resolveSession("ns-thread-restore");
    expect(first.agent.state.model?.provider).toBe("ns-b");
    const row = await sessionGet(first.sessionId);
    expect(row?.modelProvider ?? null).toBeNull();

    // 用户随后在别处切到了 ns-a：新会话的 lastUsed 变了，但这个旧会话不该跟
    await setLastUsedModelKey({ provider: "ns-a", modelId: "ma" });
    dropRun(first.threadId);
    const reborn = await resolveSession("ns-thread-restore", first.sessionId);
    expect(reborn.agent.state.model?.provider).toBe("ns-b");
    expect(reborn.agent.state.model?.id).toBe("mb");
    dropRun(reborn.threadId);
  });
});
