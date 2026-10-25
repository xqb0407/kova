/**
 * 结果 → 渲染序列（纯函数）。
 *
 * 输出是「组标签 + 命中行」交错的一维数组，命中行自带 selectableIndex
 *（键盘导航的下标），构建时一次算好——渲染层不再做跨组 offset 拼接，
 * 也没有逐行回数的 O(n²)。
 *
 * 三类输入对应三种视图：
 * - 命令模式（`>` 前缀）：只有命令行；
 * - 空查询：默认页（最近会话 / 最近产物 / 搜索历史）；
 * - 有查询：按 scope 过滤，`all` 页每域配额截断。
 */
import {
  ALL_LIMITS,
  type SearchDefaultData,
  type SearchHit,
  type SearchResultSet,
  type SearchRow,
  type SearchScope,
  type ActionCommand,
} from "./search-models";

export type BuildRowsInput = {
  isAction: boolean;
  trimmed: string;
  scope: SearchScope;
  /** 已按前缀过滤的命令（命令模式下使用） */
  actions: ActionCommand[];
  result: SearchResultSet;
  fallback: SearchDefaultData;
};

/** 构建序列：内部计数器保证 selectableIndex 与「可选中行出现序」一致 */
export function buildSearchRows(input: BuildRowsInput): SearchRow[] {
  const rows: SearchRow[] = [];
  let selectableIndex = 0;

  const pushHit = (hit: SearchHit) => {
    rows.push({ type: "hit", hit, selectableIndex });
    selectableIndex += 1;
  };
  const pushGroup = (
    label: string,
    hits: SearchHit[],
    action?: "clear-history",
  ) => {
    if (hits.length === 0) return;
    rows.push({ type: "label", label, action });
    for (const hit of hits) pushHit(hit);
  };
  /** `all` 页按配额截断；单域页签全量 */
  const cut = <T,>(list: T[], limit: number): T[] =>
    input.scope === "all" ? list.slice(0, limit) : list;

  if (input.isAction) {
    for (const cmd of input.actions) pushHit({ kind: "action", hit: cmd });
    return rows;
  }

  const { result, fallback, scope, trimmed } = input;

  if (!trimmed) {
    // 默认页只属于「全部」页签：其他 scope 下没有"最近内容"的语义
    if (scope !== "all") return rows;
    pushGroup(
      "最近会话",
      fallback.sessions
        .slice(0, ALL_LIMITS.sessions)
        .map((hit) => ({ kind: "session" as const, hit })),
    );
    pushGroup(
      "最近产物",
      fallback.artifacts
        .slice(0, ALL_LIMITS.artifacts)
        .map((hit) => ({ kind: "artifact" as const, hit })),
    );
    pushGroup(
      "搜索历史",
      fallback.history
        .slice(0, ALL_LIMITS.history)
        .map((hit) => ({ kind: "history" as const, hit })),
      "clear-history",
    );
    return rows;
  }

  const libraryOnly = scope === "library";
  const artifacts = (
    libraryOnly
      ? result.artifacts.filter((h) => h.sessionId === "__library__")
      : cut(result.artifacts, ALL_LIMITS.artifacts)
  ).map((hit) => ({ kind: "artifact" as const, hit }));

  // 「项目」把文件名与代码命中并成一组（它们同属项目域，分两组反而割裂）
  const project: SearchHit[] = [];
  if (scope === "project" || scope === "all") {
    for (const hit of cut(result.project.files, ALL_LIMITS.projectFiles)) {
      project.push({ kind: "projectFile", hit });
    }
    for (const hit of cut(result.project.contents, ALL_LIMITS.projectContents)) {
      project.push({ kind: "projectContent", hit });
    }
  }

  // 两个页签语义互斥：「会话」= 会话级命中（标题/首条消息），「内容」= 消息
  // 正文命中。原实现里会话组没有 scope 守卫，选「内容」时仍会冒出会话标题，
  // 与页签名不符（单测钉住这条）。
  pushGroup(
    "会话",
    scope === "conversations" || scope === "all"
      ? cut(result.sessions, ALL_LIMITS.sessions).map((hit) => ({
          kind: "session" as const,
          hit,
        }))
      : [],
  );
  pushGroup(
    "消息内容",
    scope === "content" || scope === "all"
      ? cut(result.messages, ALL_LIMITS.messages).map((hit) => ({
          kind: "message" as const,
          hit,
        }))
      : [],
  );
  pushGroup(libraryOnly ? "资料库文件" : "产物文件", artifacts);
  pushGroup("项目", project);

  return rows;
}
