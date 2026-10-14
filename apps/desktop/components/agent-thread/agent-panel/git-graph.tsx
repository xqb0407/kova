"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { CloudIcon, GitBranchIcon, Loader2Icon, SearchIcon, TagIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { gitLogGraph, type GitGraphEntry, type GitGraphRef } from "@/lib/git/git";
import { onGitChanged } from "@/lib/git/git-status";
import {
  GRAPH_COLORS,
  GRAPH_LANE_W,
  GRAPH_ROW_H,
  layoutGraph,
  type GraphRow,
} from "@/lib/git/git-graph";
import { cn } from "@/lib/utils";

/** 相对时间（面板各处共用） */
export function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`;
}

const laneColor = (lane: number) => GRAPH_COLORS[lane % GRAPH_COLORS.length];
const laneX = (lane: number) => lane * GRAPH_LANE_W + GRAPH_LANE_W / 2;
const CY = GRAPH_ROW_H / 2;

/** 圆点 → 底边某车道的合并/续道曲线 */
const curvePath = (from: number, to: number) =>
  `M ${laneX(from)} ${CY} C ${laneX(from)} ${CY + 8}, ${laneX(to)} ${GRAPH_ROW_H - 8}, ${laneX(to)} ${GRAPH_ROW_H}`;

/** 单行左侧拓扑图：车道线按各自车道着色，圆点按本提交车道着色 */
const RowGraph: FC<{ row: GraphRow; width: number }> = ({ row, width }) => {
  const own = laneColor(row.lane);
  const segs: { d: string; c: string }[] = [];
  if (row.above) segs.push({ d: `M ${laneX(row.lane)} 0 L ${laneX(row.lane)} ${CY}`, c: own });
  for (const t of row.terminates)
    segs.push({ d: `M ${laneX(t)} 0 L ${laneX(t)} ${CY}`, c: laneColor(t) });
  for (const p of row.passThrough)
    segs.push({ d: `M ${laneX(p)} 0 L ${laneX(p)} ${GRAPH_ROW_H}`, c: laneColor(p) });
  if (row.below === row.lane)
    segs.push({ d: `M ${laneX(row.lane)} ${CY} L ${laneX(row.lane)} ${GRAPH_ROW_H}`, c: own });
  else if (row.below !== null) segs.push({ d: curvePath(row.lane, row.below), c: own });
  for (const c of row.curves) if (c !== row.lane) segs.push({ d: curvePath(row.lane, c), c: own });

  const tip = row.entry.refs.length > 0; // 分支/标签尖：实心大点
  const merge = row.entry.parents.length > 1;
  const r = tip ? 3.4 : merge ? 3 : 2.4;
  return (
    <svg width={width} height={GRAPH_ROW_H} className="shrink-0" aria-hidden>
      {segs.map((s, i) => (
        <path
          key={i}
          d={s.d}
          stroke={s.c}
          strokeWidth={1.6}
          strokeLinecap="round"
          fill="none"
          opacity={0.9}
        />
      ))}
      <circle
        cx={laneX(row.lane)}
        cy={CY}
        r={r}
        fill={tip ? own : "transparent"}
        stroke={own}
        strokeWidth={1.6}
      />
    </svg>
  );
};

const REF_STYLE: Record<GitGraphRef["kind"], { chip: string; icon: FC<{ className?: string }> | null }> = {
  head: { chip: "border-transparent bg-foreground/90 text-background", icon: null },
  branch: {
    chip: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/5",
    icon: GitBranchIcon,
  },
  remote: {
    chip: "text-sky-600 dark:text-sky-400 border-sky-500/40 bg-sky-500/5",
    icon: CloudIcon,
  },
  tag: {
    chip: "text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/5",
    icon: TagIcon,
  },
};

const RefChip: FC<{ r: GitGraphRef }> = ({ r }) => {
  const s = REF_STYLE[r.kind];
  const Icon = s.icon;
  return (
    <span
      title={r.name}
      className={cn(
        "inline-flex max-w-[10rem] shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-xs leading-[16px]",
        s.chip,
      )}
    >
      {Icon ? <Icon className="size-2.5 shrink-0" /> : null}
      <span className="min-w-0 truncate">{r.name}</span>
    </span>
  );
};

/**
 * IDEA 风格提交图谱：左彩色车道拓扑（分叉/合并/HEAD），右提交信息 + ref 标签 + 作者 + 相对时间。
 * 数据来自 git_log_graph（拓扑序、含本地/远端分支尖），写操作后经 "git-changed" 自动重拉。
 */
export const GitGraph: FC<{ cwd: string; tick?: number }> = ({ cwd, tick }) => {
  const [entries, setEntries] = useState<GitGraphEntry[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    const pull = () => {
      gitLogGraph(cwd, 200)
        .then((r) => {
          if (alive) setEntries(r ?? []);
        })
        .catch(() => {});
    };
    pull();
    return onGitChanged((changed) => {
      if (changed === cwd) pull();
    });
  }, [cwd, tick]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = !q
      ? entries ?? []
      : (entries ?? []).filter(
          (e) =>
            e.subject.toLowerCase().includes(q) ||
            e.author.toLowerCase().includes(q) ||
            e.hash.toLowerCase().startsWith(q),
        );
    return layoutGraph(list);
  }, [entries, filter]);

  const copy = useCallback((hash: string) => {
    void navigator.clipboard?.writeText(hash).catch(() => {});
  }, []);

  if (entries === null) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-1.5 py-4 text-xs">
        <Loader2Icon className="size-3.5 animate-spin" />
        读取提交图谱…
      </div>
    );
  }
  if (entries.length === 0) {
    return <div className="text-muted-foreground/60 px-1 py-3 text-center text-xs">暂无提交</div>;
  }

  const width = (Math.max(...rows.map((r) => r.lanes), 1) + 1) * GRAPH_LANE_W;
  return (
    <div className="flex flex-col">
      {/* 次级吸顶：贴在区块折叠头（h-11=44px → top-11）下沿，负边距吃满卡片内容宽 */}
      <div className="bg-card/60 sticky top-11 z-10 relative -mx-2 mb-1 px-2.5  backdrop-blur-md">
        <SearchIcon className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-5 size-3 -translate-y-1/2" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索提交信息 / 作者 / 哈希前缀"
          className="pl-7 text-xs bg-background"
        />
      </div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground/60 px-1 py-3 text-center text-xs">无匹配提交</div>
      ) : (
        rows.map((row) => (
          <button
            key={row.entry.hash}
            type="button"
            onClick={() => copy(row.entry.hash)}
            title={`${row.entry.subject}\n${row.entry.hash}\n点击复制哈希`}
            className="hover:bg-muted/40 flex w-full items-center gap-2 rounded-md pr-1 text-left"
          >
            <RowGraph row={row} width={width} />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
              {row.entry.subject}
            </span>
            {row.entry.refs.length > 0 ? (
              <span className="flex shrink-0 items-center gap-1">
                {row.entry.refs.map((r, i) => (
                  <RefChip key={`${r.kind}:${r.name}:${i}`} r={r} />
                ))}
              </span>
            ) : null}
            <span className="text-muted-foreground w-16 shrink-0 truncate text-right text-xs">
              {row.entry.author}
            </span>
            <span className="text-muted-foreground w-14 shrink-0 text-right text-xs tabular-nums">
              {fmtWhen(row.entry.time)}
            </span>
          </button>
        ))
      )}
    </div>
  );
};
