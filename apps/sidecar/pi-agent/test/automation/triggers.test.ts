import { describe, test, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import {
  deleteTrigger,
  deleteTriggersForTask,
  generateWebhookSecret,
  getTrigger,
  listTriggers,
  regenerateTriggerSecret,
  resetTriggersForTest,
  saveTrigger,
  setTriggerEnabled,
  triggersPath,
} from "../../src/automation/triggers";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-triggers-"));
const prevPath = process.env.PI_TRIGGERS_PATH;

beforeAll(() => {
  process.env.PI_TRIGGERS_PATH = path.join(tmp, "triggers.json");
});

afterAll(() => {
  if (prevPath === undefined) delete process.env.PI_TRIGGERS_PATH;
  else process.env.PI_TRIGGERS_PATH = prevPath;
});

beforeEach(() => {
  if (existsSync(triggersPath())) writeFileSync(triggersPath(), "{}", "utf8");
  resetTriggersForTest();
});

const okTask = () => true;

const webhookInput = (overrides: Record<string, unknown> = {}) => ({
  id: "trg-abc",
  type: "webhook",
  taskId: "task-1",
  enabled: true,
  config: { type: "webhook", secret: generateWebhookSecret() },
  ...overrides,
});

describe("trigger 存储（triggers.json）", () => {
  test("save → list 回读；webhook secret 生成", async () => {
    await saveTrigger(webhookInput(), okTask);
    const all = listTriggers();
    expect(all).toHaveLength(1);
    expect(all[0]?.type).toBe("webhook");
    expect(all[0]?.taskId).toBe("task-1");
    const cfg = all[0]!.config;
    expect(cfg.type).toBe("webhook");
    if (cfg.type === "webhook") expect(cfg.secret.length).toBeGreaterThanOrEqual(32);
  });

  test("新建 webhook 不带/带短 secret 被拒（secret 由 sidecar 生成）", async () => {
    // 空 secret：normalize 形状拒绝
    await expect(
      saveTrigger({ ...webhookInput({ id: "trg-x" }), config: { type: "webhook", secret: "" } }, okTask),
    ).rejects.toThrow("invalid trigger shape");
    // 短 secret：长度策略拒绝（新建必须是生成的 64 位）
    await expect(
      saveTrigger({ ...webhookInput({ id: "trg-y" }), config: { type: "webhook", secret: "short" } }, okTask),
    ).rejects.toThrow("must be generated");
  });

  test("更新 webhook 保留原 secret（外部传入被忽略）", async () => {
    await saveTrigger(webhookInput(), okTask);
    const before = getTrigger("trg-abc")!.config as { type: "webhook"; secret: string };
    // 更新请求带外部篡改的短 secret：existing 存在 → 长度策略跳过 → 保留原值
    await saveTrigger({ ...webhookInput(), config: { type: "webhook", secret: "tampered" } }, okTask);
    const after = getTrigger("trg-abc")!.config as { type: "webhook"; secret: string };
    expect(after.secret).toBe(before.secret);
  });

  test("更新 webhook 可省略 secret（补回原值）", async () => {
    await saveTrigger(webhookInput(), okTask);
    const before = getTrigger("trg-abc")!.config as { type: "webhook"; secret: string };
    await saveTrigger(
      {
        id: "trg-abc",
        type: "webhook",
        taskId: "task-1",
        enabled: false,
        config: { type: "webhook" },
      },
      okTask,
    );
    const after = getTrigger("trg-abc")!;
    expect((after.config as { secret: string }).secret).toBe(before.secret);
    expect(after.enabled).toBe(false);
  });

  test("regenerate 换密钥；非 webhook 抛错", async () => {
    await saveTrigger(webhookInput(), okTask);
    const old = (getTrigger("trg-abc")!.config as { secret: string }).secret;
    const { secret } = regenerateTriggerSecret("trg-abc");
    expect(secret).not.toBe(old);
    expect((getTrigger("trg-abc")!.config as { secret: string }).secret).toBe(secret);

    await saveTrigger(
      {
        id: "trg-file",
        type: "file",
        taskId: "task-1",
        config: { type: "file", paths: ["src/**/*.ts"] },
      },
      okTask,
    );
    expect(() => regenerateTriggerSecret("trg-file")).toThrow("not a webhook");
  });

  test("新建不带 id：sidecar 生成 id 并可回读", async () => {
    const saved = await saveTrigger(
      {
        type: "file",
        taskId: "task-1",
        config: { type: "file", paths: ["src/**/*.ts"] },
      },
      okTask,
    );
    expect(saved.id.length).toBeGreaterThan(0);
    expect(saved.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(listTriggers().some((t) => t.id === saved.id)).toBe(true);
  });

  test("跨进程可见：外部写盘后 list 立即读到（mtime+size 失效缓存）", async () => {
    await saveTrigger(webhookInput(), okTask);
    const file = JSON.parse(readFileSync(triggersPath(), "utf8")) as {
      version: 1;
      triggers: Array<Record<string, unknown>>;
    };
    file.triggers.push({
      id: "trg-ext",
      type: "git",
      taskId: "task-1",
      enabled: true,
      config: { type: "git", cwd: "/tmp/repo" },
    });
    writeFileSync(triggersPath(), JSON.stringify(file), "utf8");
    expect(listTriggers().some((t) => t.id === "trg-ext")).toBe(true);

    // 外部删除同样立即可见
    file.triggers = file.triggers.filter((t) => t.id !== "trg-ext");
    writeFileSync(triggersPath(), JSON.stringify(file), "utf8");
    expect(listTriggers().some((t) => t.id === "trg-ext")).toBe(false);
  });

  test("文件触发器拒绝逃逸 workspace 的 glob（绝对路径/..）", async () => {
    await expect(
      saveTrigger(
        { id: "trg-abs", type: "file", taskId: "task-1", config: { type: "file", paths: ["/etc/**"] } },
        okTask,
      ),
    ).rejects.toThrow("invalid trigger shape");
    await expect(
      saveTrigger(
        { id: "trg-up", type: "file", taskId: "task-1", config: { type: "file", paths: ["../secret/**"] } },
        okTask,
      ),
    ).rejects.toThrow("invalid trigger shape");
    // 混合列表：非法路径被丢弃，合法路径保留
    const saved = await saveTrigger(
      {
        id: "trg-mix",
        type: "file",
        taskId: "task-1",
        config: { type: "file", paths: ["/etc/**", "src/**/*.ts"] },
      },
      okTask,
    );
    expect(saved.config).toEqual({ type: "file", paths: ["src/**/*.ts"] });
  });

  test("git 触发器拒绝非法分支名（路径逃逸）", async () => {
    await expect(
      saveTrigger(
        {
          id: "trg-gitbad",
          type: "git",
          taskId: "task-1",
          config: { type: "git", cwd: "/tmp/repo", branch: "../../etc/passwd" },
        },
        okTask,
      ),
    ).rejects.toThrow("invalid trigger shape");
  });

  test("IM 触发器拒绝非法正则", async () => {
    await expect(
      saveTrigger(
        {
          id: "trg-im-bad",
          type: "im",
          taskId: "task-1",
          config: { type: "im", platform: "feishu", pattern: "([" },
        },
        okTask,
      ),
    ).rejects.toThrow("invalid trigger shape");
  });

  test("taskId 校验：引用不存在任务被拒", async () => {
    await expect(saveTrigger(webhookInput(), () => false)).rejects.toThrow("not found");
  });

  test("坏形状丢弃：normalize 阶段拒绝", async () => {
    // 缺 paths 的 file 触发器
    await expect(
      saveTrigger(
        { id: "trg-bad", type: "file", taskId: "t", config: { type: "file", paths: [] } },
        okTask,
      ),
    ).rejects.toThrow();
    // 非法 id
    await expect(saveTrigger(webhookInput({ id: "bad id!" }), okTask)).rejects.toThrow();
    // 未知 type
    await expect(
      saveTrigger({ id: "trg-z", type: "http", taskId: "t", config: {} }, okTask),
    ).rejects.toThrow();
  });

  test("delete / setEnabled / 任务删除级联", async () => {
    await saveTrigger(webhookInput(), okTask);
    await saveTrigger(
      {
        id: "trg-f2",
        type: "file",
        taskId: "task-2",
        config: { type: "file", paths: ["docs/**"] },
      },
      okTask,
    );
    setTriggerEnabled("trg-abc", false);
    expect(getTrigger("trg-abc")?.enabled).toBe(false);
    expect(deleteTrigger("trg-abc")).toBe(true);
    expect(deleteTrigger("trg-abc")).toBe(false);
    expect(deleteTriggersForTask("task-2")).toBe(1);
    expect(listTriggers()).toHaveLength(0);
  });
});
