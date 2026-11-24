import { describe, expect, it } from "bun:test";
import {
  buildAutomationItem,
  buildBackgroundTaskItem,
  buildExternalInboxItem,
} from "../../src/inbox/items";

describe("inbox item builders", () => {
  it("外部工作项：provider/key/url 预留字段与聚合 ID", () => {
    const item = buildExternalInboxItem({
      provider: "github",
      key: "o/r#12",
      type: "issue",
      title: "Fix login redirect",
      summary: "redirect loop on Safari",
      url: "https://github.com/o/r/issues/12",
      status: "open",
      sourceName: "o/r",
    });
    expect(item.id).toBe("external:github:o/r#12");
    expect(item.kind).toBe("external");
    expect(item.state).toBe("done");
    expect(item.outcome).toBe("resolved");
    expect(item.external?.provider).toBe("github");
    expect(item.external?.status).toBe("open");
    expect(item.deepLink?.url).toBe("https://github.com/o/r/issues/12");
    expect(item.actions).toEqual(["open", "mark_read", "archive"]);
  });

  it("外部工作项：idKey 只影响稳定 ID，展示编号仍用 key", () => {
    const item = buildExternalInboxItem({
      provider: "jira",
      idKey: "acme.atlassian.net/ACME-7",
      key: "ACME-7",
      type: "ticket",
      title: "Login fails",
      url: "https://acme.atlassian.net/browse/ACME-7",
      requiresAction: true,
      connectorId: "jira",
      reason: "assigned",
      externalId: "10042",
    });
    expect(item.id).toBe("external:jira:acme.atlassian.net/ACME-7");
    expect(item.sourceId).toBe("acme.atlassian.net/ACME-7");
    expect(item.external?.key).toBe("ACME-7");
    expect(item.external?.reason).toBe("assigned");
    expect(item.external?.externalId).toBe("10042");
    expect(item.meta?.connectorId).toBe("jira");
    expect(item.meta?.externalId).toBe("10042");
    expect(item.state).toBe("done");
    expect(item.outcome).toBe("needs_action");
    expect(item.requiresAction).toBe(true);
    expect(item.priority).toBe(1);
  });

  it("外部 URL 只接受 http(s)，拒绝 javascript/file", () => {
    const item = buildExternalInboxItem({
      provider: "jira",
      key: "JIRA-2",
      title: "ticket",
      url: "javascript:alert(1)",
    });
    expect(item.deepLink?.url).toBeUndefined();
    expect(item.external?.url).toBeUndefined();
  });

  it("外部 adapter 传坏时间时回落合法 ISO，不产生 NaN 排序", () => {
    const item = buildExternalInboxItem({
      provider: "jira",
      key: "JIRA-1",
      title: "ticket",
      createdAt: "not-a-date",
    });
    expect(Number.isFinite(Date.parse(item.createdAt))).toBe(true);
  });

  it("用户 Stop 的自动化运行是 stopped 历史项，不要求重跑", () => {
    const item = buildAutomationItem({
      taskId: "t1",
      taskName: "每日天气",
      runId: "r2",
      ok: false,
      stopped: true,
      error: "run aborted by stop request",
    });
    expect(item.state).toBe("done");
    expect(item.outcome).toBe("stopped");
    expect(item.requiresAction).toBe(false);
    expect(item.actions).not.toContain("retry");
    expect(item.title).toContain("已停止");
  });

  it("自动化任务名进 meta 前也脱敏", () => {
    const item = buildAutomationItem({
      taskId: "t1",
      taskName: "release token=secret123",
      runId: "r1",
      ok: false,
      error: "boom",
    });
    expect(item.title).toContain("自动化失败");
    expect(String(item.meta?.taskName)).not.toContain("secret123");
    expect(String(item.meta?.taskName)).toContain("token=***");
  });

  it("后台任务时间坏掉时回落合法 ISO", () => {
    const item = buildBackgroundTaskItem({
      taskId: 1,
      command: "npm test",
      source: "explicit",
      startedAt: Number.NaN,
      exitCode: 1,
      threadId: "t1",
    });
    expect(Number.isFinite(Date.parse(item.createdAt))).toBe(true);
    expect(item.outcome).toBe("failed");
  });
});
