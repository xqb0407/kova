import { describe, expect, test } from "bun:test";
import {
  EMPTY_DEFAULT_DATA,
  EMPTY_RESULT_SET,
  parseQuery,
  type SearchResultSet,
} from "../../lib/search/search-models";
import { buildSearchRows } from "../../lib/search/search-rows";
import { formatRelativeTime, projectNameOf } from "../../lib/search/search-format";

const sessionHit = (id: string) =>
  ({
    sessionId: id,
    title: `会话 ${id}`,
    firstMessage: "",
    cwd: "/tmp/proj",
    archived: false,
    updatedAt: "2026-01-01T00:00:00Z",
  }) as const;

const messageHit = (sessionId: string, seq: number) =>
  ({
    sessionId,
    seq,
    role: "user",
    preview: `消息 ${seq}`,
    title: "会话",
    cwd: "/tmp/proj",
    archived: false,
    updatedAt: "2026-01-01T00:00:00Z",
  }) as const;

function result(over: Partial<SearchResultSet> = {}): SearchResultSet {
  return { ...EMPTY_RESULT_SET, ...over };
}

describe("parseQuery", () => {
  test("普通查询原样 trim", () => {
    expect(parseQuery("  部署  ")).toEqual({ isAction: false, trimmed: "部署" });
  });
  test("> 前缀进命令模式并剥离前缀", () => {
    expect(parseQuery("> 新")).toEqual({ isAction: true, trimmed: "新" });
    expect(parseQuery(">")).toEqual({ isAction: true, trimmed: "" });
  });
});

describe("buildSearchRows", () => {
  test("组标签与命中行交错，selectableIndex 连续递增（不含 label）", () => {
    const rows = buildSearchRows({
      isAction: false,
      trimmed: "部署",
      scope: "all",
      actions: [],
      result: result({
        sessions: [sessionHit("s1"), sessionHit("s2")],
        messages: [messageHit("s1", 1)],
      }),
      fallback: EMPTY_DEFAULT_DATA,
    });

    const labels = rows.filter((r) => r.type === "label").map((r) => r.label);
    expect(labels).toEqual(["会话", "消息内容"]);

    const hits = rows.filter(
      (r): r is Extract<typeof r, { type: "hit" }> => r.type === "hit",
    );
    // 3 条命中：2 会话 + 1 消息
    expect(hits.length).toBe(3);
    // 下标必须是 0..n-1 连续，渲染层直接取用（原实现逐行回数 label）
    expect(hits.map((h) => h.selectableIndex)).toEqual([0, 1, 2]);
    expect(hits[0]!.hit.kind).toBe("session");
    expect(hits[2]!.hit.kind).toBe("message");
    expect(rows[0]!.type).toBe("label");
  });

  test("all 页每域配额截断，单域页签不截断", () => {
    const many = Array.from({ length: 20 }, (_, i) => sessionHit(`s${i}`));
    const all = buildSearchRows({
      isAction: false,
      trimmed: "x",
      scope: "all",
      actions: [],
      result: result({ sessions: many }),
      fallback: EMPTY_DEFAULT_DATA,
    });
    const allHits = all.filter((r) => r.type === "hit");
    expect(allHits.length).toBe(6); // ALL_LIMITS.sessions

    const conversations = buildSearchRows({
      isAction: false,
      trimmed: "x",
      scope: "conversations",
      actions: [],
      result: result({ sessions: many }),
      fallback: EMPTY_DEFAULT_DATA,
    });
    expect(conversations.filter((r) => r.type === "hit").length).toBe(20);
  });

  test("scope=content 不渲染会话组；scope=conversations 保留消息", () => {
    const rows = buildSearchRows({
      isAction: false,
      trimmed: "x",
      scope: "content",
      actions: [],
      result: result({ sessions: [sessionHit("s1")], messages: [messageHit("s1", 1)] }),
      fallback: EMPTY_DEFAULT_DATA,
    });
    const labels = rows.filter((r) => r.type === "label").map((r) => r.label);
    expect(labels).not.toContain("会话");
    expect(labels).toContain("消息内容");
  });

  test("scope=library 只保留资料库归属的产物行", () => {
    const rows = buildSearchRows({
      isAction: false,
      trimmed: "x",
      scope: "library",
      actions: [],
      result: result({
        artifacts: [
          { sessionId: "__library__", rel: "资料.md", name: "资料.md", preview: "", title: null, cwd: "", archived: false },
          { sessionId: "s1", rel: "产物.md", name: "产物.md", preview: "", title: "会话", cwd: "/tmp", archived: false },
        ],
      }),
      fallback: EMPTY_DEFAULT_DATA,
    });
    const hits = rows.filter(
      (r): r is Extract<typeof r, { type: "hit" }> => r.type === "hit",
    );
    expect(hits.length).toBe(1);
    expect(hits[0]!.hit.kind).toBe("artifact");
    expect(
      hits[0]!.hit.kind === "artifact" && hits[0]!.hit.hit.sessionId,
    ).toBe("__library__");
  });

  test("空查询 → 默认页三组（最近会话/产物/历史），历史组带清空动作", () => {
    const rows = buildSearchRows({
      isAction: false,
      trimmed: "",
      scope: "all",
      actions: [],
      result: EMPTY_RESULT_SET,
      fallback: {
        sessions: [sessionHit("s1")],
        artifacts: [],
        history: [{ query: "部署", createdAt: "2026-01-01" }],
      },
    });
    const labels = rows.filter((r) => r.type === "label");
    expect(labels.map((l) => l.label)).toEqual(["最近会话", "搜索历史"]);
    expect(
      labels.find((l) => l.label === "搜索历史")?.action,
    ).toBe("clear-history");
  });

  test("空查询 + 非 all scope → 无行（默认页只属于全部页签）", () => {
    const rows = buildSearchRows({
      isAction: false,
      trimmed: "",
      scope: "project",
      actions: [],
      result: EMPTY_RESULT_SET,
      fallback: { ...EMPTY_DEFAULT_DATA, sessions: [sessionHit("s1")] },
    });
    expect(rows).toEqual([]);
  });

  test("命令模式只渲染命令，selectableIndex 从 0 开始", () => {
    const rows = buildSearchRows({
      isAction: true,
      trimmed: "新",
      scope: "all",
      actions: [
        {
          id: "action:new-thread",
          label: "新对话",
          hint: "开始一个新会话",
          icon: (() => null) as never,
          run: () => {},
        },
      ],
      result: EMPTY_RESULT_SET,
      fallback: EMPTY_DEFAULT_DATA,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe("hit");
    if (rows[0]!.type === "hit") {
      expect(rows[0]!.hit.kind).toBe("action");
      expect(rows[0]!.selectableIndex).toBe(0);
    }
  });

  test("项目域：文件名与代码命中并成一组，顺序在前", () => {
    const rows = buildSearchRows({
      isAction: false,
      trimmed: "x",
      scope: "project",
      actions: [],
      result: result({
        project: {
          files: [{ rel: "src/a.ts", name: "a.ts" }],
          contents: [{ rel: "src/b.ts", name: "b.ts", line: 3, preview: "x" }],
          truncated: false,
        },
      }),
      fallback: EMPTY_DEFAULT_DATA,
    });
    const hits = rows.filter(
      (r): r is Extract<typeof r, { type: "hit" }> => r.type === "hit",
    );
    expect(hits.map((h) => h.hit.kind)).toEqual(["projectFile", "projectContent"]);
  });
});

describe("search-format", () => {
  test("projectNameOf 取路径尾段", () => {
    expect(projectNameOf("/Users/x/proj")).toBe("proj");
    expect(projectNameOf("/Users/x/proj/")).toBe("proj");
    expect(projectNameOf("")).toBe("");
  });

  test("formatRelativeTime：刚刚 / 分钟 / 小时 / 天 / 跨年日期", () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe("刚刚");
    expect(formatRelativeTime(now - 5 * 60_000)).toBe("5分钟前");
    expect(formatRelativeTime(now - 3 * 3_600_000)).toBe("3小时前");
    expect(formatRelativeTime(now - 2 * 86_400_000)).toBe("2天前");
    expect(formatRelativeTime("")).toBeNull();
    expect(formatRelativeTime(0)).toBeNull();
    // 跨年：给全日期
    expect(formatRelativeTime("2020-03-05T00:00:00Z")).toMatch(/^2020\//);
  });
});
