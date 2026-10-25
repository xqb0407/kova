/**
 * 全局搜索的领域模型（纯数据 + 常量，不依赖 React）。
 *
 * 分层约定（与仓库既有 components/lib 分工一致）：
 * - 本文件与 search-rows / search-format / search-open：可单测的纯逻辑；
 * - components/search/*：只负责渲染与交互，状态编排在
 *   lib/search/use-search-controller.ts。
 */
import {
  CornerDownLeftIcon,
  PlusIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import type {
  PiProjectSearchResult,
  PiSearchArtifactHit,
  PiSearchMessageHit,
  PiSearchSessionHit,
} from "@/lib/pi/pi-bridge";

/** 资料库文件在索引里的归属键（sidecar 侧哨兵，见 hostdb.ARTIFACT_OWNER_LIBRARY） */
export const LIBRARY_OWNER_KEY = "__library__";

export type SearchScope =
  | "all"
  | "conversations"
  | "content"
  | "artifacts"
  | "library"
  | "project";

export const SEARCH_SCOPES: readonly { id: SearchScope; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "conversations", label: "会话" },
  { id: "content", label: "内容" },
  { id: "artifacts", label: "产物" },
  { id: "library", label: "资料库" },
  { id: "project", label: "项目" },
];

/** 「全部」页各域配额（聚合视图每域有界；单域页签不截断） */
export const ALL_LIMITS = {
  sessions: 6,
  messages: 6,
  artifacts: 6,
  projectFiles: 4,
  projectContents: 6,
  history: 5,
} as const;

/** 操作命中（输入 `>` 前缀时的命令） */
export type ActionCommand = {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
};

export function buildActionCommands(deps: {
  onNewThread: () => void;
  onClearHistory: () => void;
  close: () => void;
}): ActionCommand[] {
  return [
    {
      id: "action:new-thread",
      label: "新对话",
      hint: "开始一个新会话",
      icon: PlusIcon,
      run: () => {
        deps.close();
        deps.onNewThread();
      },
    },
    {
      id: "action:close",
      label: "关闭搜索",
      hint: "Esc",
      icon: CornerDownLeftIcon,
      run: deps.close,
    },
    {
      id: "action:clear-history",
      label: "清空搜索历史",
      hint: "删除全部历史记录",
      icon: Trash2Icon,
      run: deps.onClearHistory,
    },
  ];
}

/** 一条搜索结果（按来源域区分渲染与落点） */
export type SearchHit =
  | { kind: "session"; hit: PiSearchSessionHit }
  | { kind: "message"; hit: PiSearchMessageHit }
  | { kind: "artifact"; hit: PiSearchArtifactHit }
  | { kind: "projectFile"; hit: { rel: string; name: string } }
  | {
      kind: "projectContent";
      hit: { rel: string; name: string; line: number; preview: string };
    }
  | { kind: "history"; hit: { query: string } }
  | { kind: "action"; hit: ActionCommand };

/**
 * 渲染序列的一行。label 是分组标题（不可选中）；hit 自带
 * `selectableIndex`，渲染层直接取用——避免原来"每行回头数前面有多少
 * label"的 O(n²) 计算。
 */
export type SearchRow =
  | { type: "label"; label: string; action?: "clear-history" }
  | { type: "hit"; hit: SearchHit; selectableIndex: number };

export type SearchHistoryRow = { query: string; createdAt: string };

/** 查询结果集（sidecar 单次往返返回的四域 + truncated） */
export type SearchResultSet = {
  sessions: PiSearchSessionHit[];
  messages: PiSearchMessageHit[];
  artifacts: PiSearchArtifactHit[];
  project: PiProjectSearchResult;
  truncated: boolean;
};

export const EMPTY_RESULT_SET: SearchResultSet = {
  sessions: [],
  messages: [],
  artifacts: [],
  project: { files: [], contents: [], truncated: false },
  truncated: false,
};

/** 默认页数据（最近会话 / 最近产物 / 搜索历史） */
export type SearchDefaultData = {
  sessions: PiSearchSessionHit[];
  artifacts: PiSearchArtifactHit[];
  history: SearchHistoryRow[];
};

export const EMPTY_DEFAULT_DATA: SearchDefaultData = {
  sessions: [],
  artifacts: [],
  history: [],
};

/** 输入 `>` 前缀 = 命令模式；返回剥离前缀后的查询词 */
export function parseQuery(raw: string): { isAction: boolean; trimmed: string } {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw.startsWith(">")) return { isAction: false, trimmed: trimmedRaw };
  return { isAction: true, trimmed: trimmedRaw.replace(/^>\s*/, "") };
}
