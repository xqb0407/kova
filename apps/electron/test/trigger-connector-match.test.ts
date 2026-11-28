import { describe, expect, test } from "bun:test";
import {
  connectorFireSummary,
  connectorItemKind,
  matchConnectorTriggers,
  matchConnectorTriggersWithItems,
} from "../main/trigger-connector-match";

const connector = (overrides: Record<string, unknown> = {}) => ({
  id: "trg-conn",
  type: "connector",
  taskId: "task-1",
  enabled: true,
  config: { type: "connector", provider: "jira" },
  ...overrides,
});

const item = (overrides: Record<string, unknown> = {}) => ({
  key: "KI-123",
  title: "修复登录页崩溃",
  sourceName: "KI",
  type: "ticket",
  ...overrides,
});

describe("connector 事项类型归一", () => {
  test("issue/ticket → issue；pull_request/merge_request → pr；其余 other", () => {
    expect(connectorItemKind("issue")).toBe("issue");
    expect(connectorItemKind("ticket")).toBe("issue");
    expect(connectorItemKind("pull_request")).toBe("pr");
    expect(connectorItemKind("merge_request")).toBe("pr");
    expect(connectorItemKind("discussion")).toBe("other");
    expect(connectorItemKind(undefined)).toBe("other");
  });
});

describe("connector 触发器匹配（L1d）", () => {
  test("provider 精确匹配；禁用/其它类型跳过", () => {
    expect(matchConnectorTriggers([connector()], { provider: "jira", connectorId: "c1", items: [item()] })).toHaveLength(1);
    expect(matchConnectorTriggers([connector()], { provider: "gitlab", connectorId: "c1", items: [item()] })).toHaveLength(0);
    expect(matchConnectorTriggers([connector({ enabled: false })], { provider: "jira", connectorId: "c1", items: [item()] })).toHaveLength(0);
    expect(matchConnectorTriggers([connector({ type: "im" })], { provider: "jira", connectorId: "c1", items: [item()] })).toHaveLength(0);
  });

  test("connectorId 绑定：给了就只匹配该连接器", () => {
    const bound = connector({ config: { type: "connector", provider: "jira", connectorId: "c9" } });
    expect(matchConnectorTriggers([bound], { provider: "jira", connectorId: "c9", items: [item()] })).toHaveLength(1);
    expect(matchConnectorTriggers([bound], { provider: "jira", connectorId: "c1", items: [item()] })).toHaveLength(0);
  });

  test("sourceName 大小写不敏感；缺 source 的事项不命中限定", () => {
    const scoped = connector({ config: { type: "connector", provider: "gitlab", sourceName: "Org/Repo" } });
    const gl = (o: Record<string, unknown>) => item({ type: "issue", key: "org/repo#12", ...o });
    expect(matchConnectorTriggers([scoped], { provider: "gitlab", connectorId: "c1", items: [gl({ sourceName: "org/repo" })] })).toHaveLength(1);
    expect(matchConnectorTriggers([scoped], { provider: "gitlab", connectorId: "c1", items: [gl({ sourceName: "other/repo" })] })).toHaveLength(0);
    expect(matchConnectorTriggers([scoped], { provider: "gitlab", connectorId: "c1", items: [gl({ sourceName: undefined })] })).toHaveLength(0);
  });

  test("itemType 过滤：issue/pr 归一；other 类型只在不过滤时命中", () => {
    const wantIssue = connector({ config: { type: "connector", provider: "jira", itemType: "issue" } });
    const wantPr = connector({ config: { type: "connector", provider: "gitlab", itemType: "pr" } });
    const noFilter = connector({ config: { type: "connector", provider: "github" } });
    expect(matchConnectorTriggers([wantIssue], { provider: "jira", connectorId: "c1", items: [item()] })).toHaveLength(1);
    expect(matchConnectorTriggers([wantIssue], { provider: "jira", connectorId: "c1", items: [item({ type: "merge_request" })] })).toHaveLength(0);
    expect(matchConnectorTriggers([wantPr], { provider: "gitlab", connectorId: "c1", items: [item({ type: "merge_request" })] })).toHaveLength(1);
    expect(matchConnectorTriggers([wantPr], { provider: "gitlab", connectorId: "c1", items: [item({ type: "release" })] })).toHaveLength(0);
    expect(matchConnectorTriggers([noFilter], { provider: "github", connectorId: "c1", items: [item({ type: "release" })] })).toHaveLength(1);
  });

  test("批次内任一事项命中即触发", () => {
    const scoped = connector({ config: { type: "connector", provider: "jira", sourceName: "KI" } });
    const batch = [item({ sourceName: "XX" }), item({ key: "KI-9", sourceName: "KI" })];
    expect(matchConnectorTriggers([scoped], { provider: "jira", connectorId: "c1", items: batch })).toHaveLength(1);
    expect(matchConnectorTriggers([scoped], { provider: "jira", connectorId: "c1", items: [item({ sourceName: "XX" })] })).toHaveLength(0);
  });

  test("明细匹配：每个触发器只带自己命中的事项子集", () => {
    const scoped = connector({ config: { type: "connector", provider: "jira", sourceName: "KI" } });
    const wantPr = connector({
      id: "trg-pr",
      config: { type: "connector", provider: "jira", itemType: "pr" },
    });
    const batch = [
      item({ key: "KI-9" }),
      item({ key: "XX-1", sourceName: "XX" }),
      item({ key: "KI-5", sourceName: "XX", type: "merge_request" }),
    ];
    const matches = matchConnectorTriggersWithItems([scoped, wantPr], {
      provider: "jira",
      connectorId: "c1",
      items: batch,
    });
    expect(matches).toHaveLength(2);
    const scopedItems = matches.find((m) => m.trigger.id === "trg-conn")!.items.map((x) => x.key);
    expect(scopedItems).toEqual(["KI-9"]);
    const prItems = matches.find((m) => m.trigger.id === "trg-pr")!.items.map((x) => x.key);
    expect(prItems).toEqual(["KI-5"]);
    // 全不命中（如都过了过滤条件）不出现
    const noHit = matchConnectorTriggersWithItems([connector()], {
      provider: "jira",
      connectorId: "c1",
      items: [],
    });
    expect(noHit).toHaveLength(0);
  });
});

describe("connector 触发摘要", () => {
  test("平台名 + key + 标题", () => {
    expect(
      connectorFireSummary("jira", [item({ key: "KI-123", title: "修复登录页崩溃" })]),
    ).toBe("Jira: KI-123 修复登录页崩溃");
    expect(connectorFireSummary("gitlab", [item({ key: "group/repo!12", title: "改配置" })])).toBe(
      "GitLab: group/repo!12 改配置",
    );
  });

  test("≤5 条全列；超出截断为 …N more", () => {
    const five = Array.from({ length: 5 }, (_, i) => item({ key: `KI-${i + 1}` }));
    expect(connectorFireSummary("jira", five)).toBe("Jira: KI-1 修复登录页崩溃; KI-2 修复登录页崩溃; KI-3 修复登录页崩溃; KI-4 修复登录页崩溃; KI-5 修复登录页崩溃");
    const seven = Array.from({ length: 7 }, (_, i) => item({ key: `KI-${i + 1}` }));
    expect(connectorFireSummary("jira", seven)).toBe("Jira: KI-1 修复登录页崩溃; KI-2 修复登录页崩溃; KI-3 修复登录页崩溃; KI-4 修复登录页崩溃; KI-5 修复登录页崩溃 …2 more");
  });

  test("无 key 用标题；无 key 无标题给占位；标题压空白截 60", () => {
    expect(connectorFireSummary("linear", [item({ key: undefined, title: "  多  空白 " })])).toBe("Linear: 多 空白");
    expect(connectorFireSummary("linear", [item({ key: undefined, title: "" })])).toBe("Linear: (untitled)");
    expect(
      connectorFireSummary("github", [item({ key: "org/repo#1", title: "x".repeat(200) })]),
    ).toBe(`GitHub: org/repo#1 ${"x".repeat(60)}`);
  });

  test("总长预算：超预算少列一条，保住 …N more 尾部（fire 出口 200 字硬切）", () => {
    const long = "x".repeat(60);
    const items = Array.from({ length: 4 }, (_, i) => item({ key: `KI-${i + 1}`, title: long }));
    const summary = connectorFireSummary("jira", items);
    expect(summary.length).toBeLessThanOrEqual(180);
    expect(summary.endsWith("…2 more")).toBe(true);
  });
});
