"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { FolderOpenIcon } from "lucide-react";
import {
  ensureDir,
  getDir,
  isDirLoading,
  useFileTreeVersion,
  useFileTreeWiring,
} from "@/lib/file-tree";
import { focusPanelTab } from "@/lib/panel-tabs";
import { isTauri } from "@/lib/tauri";
import { useWorkspace } from "@/lib/workspace-store";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/custom-ui/file-tree";
import { FileTypeIcon } from "./file-type-icon";
import { TabEmpty } from "./tab-empty";

/**
 * 「文件」标签（explorer）：workspace 文件树浏览。
 * 数据 = Rust fs_list_dir 单层懒加载（lib/file-tree store），只为
 * **已展开**的目录建树节点，未展开子树零渲染成本；展开/选中状态受控。
 * 点击文件 → focusPanelTab("file", { path })：复用「文件」标签渲染
 * 磁盘实时内容（CodeMirror，见 file-view 的磁盘模式）。
 * 仅 Tauri 桌面端出现（tab-registry 可见性过滤），web 端不渲染。
 */

const joinRel = (parent: string, name: string) =>
  parent ? `${parent}/${name}` : name;

/**
 * 收集"可见且应已缓存"的目录：根 + 沿已加载数据能走到的展开链。
 * 未加载的展开目录走不深，等它补水触发版本 bump 后 effect 再跑一遍，
 * 逐层收敛（self-healing：store 只失效不主动重拉）。
 */
function collectVisibleDirs(cwd: string, expanded: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    out.push(rel);
    const listing = getDir(cwd, rel);
    if (!listing) continue;
    for (const e of listing.entries) {
      if (!e.dir) continue;
      const child = joinRel(rel, e.name);
      if (expanded.has(child)) stack.push(child);
    }
  }
  return out;
}

/** 从缓存递归生成声明式树；只有展开且已加载的目录才下探 */
function renderEntries(
  cwd: string,
  rel: string,
  expanded: ReadonlySet<string>,
): ReactNode[] {
  const listing = getDir(cwd, rel);
  if (!listing) {
    // 展开的目录补水在途：占位行保住展开反馈（disabled 行不可选中）
    return [
      <FileTreeFile
        key={`${rel}\u0000loading`}
        value={`${rel}\u0000loading`}
        name={isDirLoading(cwd, rel) ? "加载中…" : "（无法读取该目录）"}
        disabled
      />,
    ];
  }
  const rows = listing.entries.map((e) => {
    const child = joinRel(rel, e.name);
    if (e.dir) {
      return (
        <FileTreeFolder key={child} value={child} name={e.name}>
          {expanded.has(child) ? renderEntries(cwd, child, expanded) : null}
        </FileTreeFolder>
      );
    }
    return (
      <FileTreeFile
        key={child}
        value={child}
        name={e.name}
        icon={<FileTypeIcon path={e.name} />}
      />
    );
  });
  if (listing.truncated) {
    rows.push(
      <FileTreeFile
        key={`${rel}\u0000truncated`}
        value={`${rel}\u0000truncated`}
        name="…（条目过多，已截断）"
        disabled
      />,
    );
  }
  return rows;
}

export const FileTreeTab: FC = () => {
  const workspace = useWorkspace();
  useFileTreeWiring();
  const treeVersion = useFileTreeVersion();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);

  // 切 workspace 收起全部展开（旧路径在新根下无意义）
  useEffect(() => {
    setExpanded([]);
    setSelected(null);
  }, [workspace]);

  // 补水：可见目录链缺缓存就拉（挂载、展开变化、失效 bump 后各收敛一次）
  useEffect(() => {
    if (!workspace || !isTauri()) return;
    for (const dir of collectVisibleDirs(workspace, expandedSet)) {
      ensureDir(workspace, dir);
    }
  }, [workspace, expandedSet, treeVersion]);

  const handleSelect = useCallback(
    (value: string) => {
      if (!workspace) return;
      const idx = value.lastIndexOf("/");
      const parent = idx < 0 ? "" : value.slice(0, idx);
      const name = idx < 0 ? value : value.slice(idx + 1);
      const entry = getDir(workspace, parent)?.entries.find(
        (e) => e.name === name,
      );
      if (!entry || entry.dir) return; // 文件夹只做展开/收起
      setSelected(value);
      // focus:undefined 清掉该标签可能残留的消息快照上下文（复用同标签）
      focusPanelTab("file", {
        cwd: workspace,
        path: value,
        title: name,
        focus: undefined,
      });
    },
    [workspace],
  );

  // 整棵树在 (workspace, expanded, 版本) 三个依赖上 memo：
  // 未变化的已加载子树复用同一批元素引用，React 只 diff 不重建
  const children = useMemo(
    () =>
      workspace && isTauri()
        ? renderEntries(workspace, "", expandedSet)
        : null,
    [workspace, expandedSet, treeVersion],
  );

  if (!workspace || !isTauri())
    return (
      <TabEmpty
        icon={FolderOpenIcon}
        text={workspace ? "文件树仅在桌面端可用" : "选择工作目录后可浏览文件树"}
      />
    );

  return (
    <div className="h-full overflow-y-auto p-1.5">
      <FileTree
        ariaLabel="工作区文件"
        value={selected}
        onValueChange={handleSelect}
        expandedIds={expanded}
        onExpandedChange={setExpanded}
      >
        {children}
      </FileTree>
    </div>
  );
};
