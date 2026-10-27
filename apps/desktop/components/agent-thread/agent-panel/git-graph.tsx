"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  CheckIcon,
  CopyIcon,
  GitGraphIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  RotateCwIcon,
  SearchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  gitLogGraph,
  type GitGraphEntry,
  type GitGraphRef,
} from "@/lib/git/git";
import { onGitChanged } from "@/lib/git/git-status";
import {
  GRAPH_COLORS,
  GRAPH_LANE_W,
  GRAPH_ROW_H,
  layoutGraph,
  type GraphRow,
} from "@/lib/git/git-graph";
import { cn } from "@/lib/utils";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 列表时间列：今天只给时刻，同年省年份，跨年才给全日期 */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear())
    return `${d.getMonth() + 1}-${pad2(d.getDate())}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 详情区完整时间（精确到分钟，提交发生的那一刻） */
export function fmtStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const short = (hash: string) => hash.slice(0, 7);

const laneColor = (lane: number) => GRAPH_COLORS[lane % GRAPH_COLORS.length];
// 留 3.5px 内边距：节点光晕（半径可达 ~11px）不会在 SVG 左边缘被裁掉
const GRAPH_INSET = 3.5;
const laneX = (lane: number) =>
  lane * GRAPH_LANE_W + GRAPH_LANE_W / 2 + GRAPH_INSET;
const CY = GRAPH_ROW_H / 2;

/** 圆点 → 底边某车道的合并/续道曲线 */
const curvePath = (from: number, to: number) =>
  `M ${laneX(from)} ${CY} C ${laneX(from)} ${CY + 7}, ${laneX(to)} ${GRAPH_ROW_H - 7}, ${laneX(to)} ${GRAPH_ROW_H}`;

/** 该行画了这条车道的上半段（顶边→中点）：自己接上方子边、直穿、或其它子边汇入本提交 */
const hasTopLine = (r: GraphRow, lane: number) =>
  (r.lane === lane && r.above) ||
  r.passThrough.includes(lane) ||
  r.terminates.includes(lane);

/** 该行画了这条车道的下半段（中点→底边）：直穿、第一父续道/换道、合并父曲线 */
const hasBottomLine = (r: GraphRow, lane: number) =>
  r.passThrough.includes(lane) || r.below === lane || r.curves.includes(lane);

/** 单行左侧拓扑图：IDEA 式 2px 车道线 + 带光晕的大圆点，多分支并排一眼可辨 */
const RowGraph: FC<{
  row: GraphRow;
  width: number;
  pulse?: boolean;
  /** 本行需要保持原色的车道集合（悬浮高亮）；null 表示全部原色 */
  hi?: Set<number> | null;
  /** 当前悬浮的这一行：只亮它的节点，同车道上下其它节点仍变淡 */
  hot?: boolean;
}> = ({ row, width, pulse = false, hi = null, hot = false }) => {
  const own = laneColor(row.lane);
  const segs: { d: string; c: string; lane: number }[] = [];
  if (row.above)
    segs.push({
      d: `M ${laneX(row.lane)} 0 L ${laneX(row.lane)} ${CY}`,
      c: own,
      lane: row.lane,
    });
  for (const t of row.terminates)
    segs.push({
      d: `M ${laneX(t)} 0 L ${laneX(t)} ${CY}`,
      c: laneColor(t),
      lane: t,
    });
  for (const p of row.passThrough)
    segs.push({
      d: `M ${laneX(p)} 0 L ${laneX(p)} ${GRAPH_ROW_H}`,
      c: laneColor(p),
      lane: p,
    });
  if (row.below === row.lane)
    segs.push({
      d: `M ${laneX(row.lane)} ${CY} L ${laneX(row.lane)} ${GRAPH_ROW_H}`,
      c: own,
      lane: row.lane,
    });
  else if (row.below !== null)
    segs.push({ d: curvePath(row.lane, row.below), c: own, lane: row.lane });
  for (const c of row.curves)
    if (c !== row.lane)
      segs.push({ d: curvePath(row.lane, c), c: own, lane: row.lane });

  const tip = row.entry.refs.length > 0; // 分支/标签尖：更大的实心点
  const merge = row.entry.parents.length > 1;
  const r = tip ? 6.2 : merge ? 5.5 : 4.8;
  // 悬浮后只保住被标记的线；选中的行不参与淡化/加粗，始终原色。
  // 节点只认「悬浮的那一个 / 选中的那一个」，上下同线其它节点不跟着亮
  const faded = (lane: number) => !pulse && hi !== null && !hi.has(lane);
  const nodeFaded = hi !== null && !hot && !pulse;
  return (
    <svg width={width} height={GRAPH_ROW_H} aria-hidden className="shrink-0">
      {segs.map((s, i) => {
        const dim = faded(s.lane);
        const lit = !pulse && hi !== null && hi.has(s.lane);
        return (
          <path
            key={i}
            d={s.d}
            stroke={s.c}
            strokeLinecap="round"
            fill="none"
            className={cn(
              "opacity-95 [stroke-width:2.1] transition-[opacity,stroke-width] duration-200 ease-out",
              dim && "opacity-30 [stroke-width:1.8]",
              // 高亮的线加粗一点，配合变宽的过渡，亮起时更自然
              lit && "opacity-100 [stroke-width:2.9]",
            )}
          />
        );
      })}
      <g
        className={cn(
          "transition-opacity duration-200",
          nodeFaded && "opacity-30",
        )}
      >
        {/* 光晕把节点从车道线里托出来；整行悬浮时光晕加深，行有"被拿起来"的感觉 */}
        <circle
          cx={laneX(row.lane)}
          cy={CY}
          r={r + 4.8}
          fill={own}
          className="opacity-[0.18] transition-opacity duration-200 group-hover:opacity-[0.3]"
        />
        {/* 选中提交：脉冲点，一眼定位当前看的是哪个节点 */}
        {pulse ? (
          <circle
            cx={laneX(row.lane)}
            cy={CY}
            r={r}
            fill={own}
            className="animate-ping [animation-duration:1.8s] origin-center [transform-box:fill-box]"
          />
        ) : null}
        <circle cx={laneX(row.lane)} cy={CY} r={r} fill={own} />
      </g>
    </svg>
  );
};

/** ref 小徽标：无图标、低饱和底色，宽度让给提交说明 */
const REF_STYLE: Record<GitGraphRef["kind"], string> = {
  head: "bg-foreground/90 text-background",
  branch: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  remote: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  tag: "bg-amber-500/20 text-amber-700 dark:text-amber-400",
};

const RefChip: FC<{ r: GitGraphRef }> = ({ r }) => (
  <span
    title={r.name}
    className={cn(
      "inline-flex max-w-[9rem] shrink-0 items-center rounded-[5px] px-2 text-[12px] leading-[19px] font-medium",
      REF_STYLE[r.kind],
    )}
  >
    <span className="min-w-0 truncate">{r.name}</span>
  </span>
);

/** 提交列表：初次拉取 + 写操作后经 "git-changed" 自动重拉（面板与弹窗共用）；
 *  cwd 为 null 时（弹窗收起）不拉数据，省一次 IPC */
function useGitGraphEntries(
  cwd: string | null,
  tick?: number,
): GitGraphEntry[] | null {
  const [entries, setEntries] = useState<GitGraphEntry[] | null>(null);
  useEffect(() => {
    if (!cwd) return;
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
  return entries;
}

function useGraphRows(
  entries: GitGraphEntry[] | null,
  filter: string,
): GraphRow[] {
  return useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = !q
      ? (entries ?? [])
      : (entries ?? []).filter(
          (e) =>
            e.subject.toLowerCase().includes(q) ||
            e.author.toLowerCase().includes(q) ||
            e.hash.toLowerCase().startsWith(q),
        );
    return layoutGraph(list);
  }, [entries, filter]);
}

/**
 * 图区宽度：按所有行真正画出来的最大车道索引取宽，而不是 layout 里车道表的长度
 * ——中间空出来的道也会被算进长度，一列空车道就把提交说明推得老远。
 */
function graphWidth(rows: GraphRow[]): number {
  let max = 0;
  for (const r of rows) {
    max = Math.max(max, r.lane, r.below ?? 0);
    for (const l of r.curves) max = Math.max(max, l);
    for (const l of r.passThrough) max = Math.max(max, l);
    for (const l of r.terminates) max = Math.max(max, l);
  }
  return Math.max((max + 1) * GRAPH_LANE_W, 24) + 6;
}

const SearchField: FC<{
  value: string;
  onChange: (v: string) => void;
  className?: string;
}> = ({ value, onChange, className }) => (
  <div className={cn("relative", className)}>
    <SearchIcon className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="搜索提交 / 作者 / 哈希"
      className="bg-muted/60 h-8 pl-8 text-[13px]"
    />
  </div>
);

const MSG_CLASS = "text-muted-foreground/60 px-1 py-6 text-center text-xs";

/** 列表体：表头（弹窗）+ 行；窄容器按容器宽度收掉时间/作者/哈希列 */
const GraphList: FC<{
  entries: GitGraphEntry[] | null;
  rows: GraphRow[];
  width: number;
  showHeader?: boolean;
  activeHash?: string | null;
  onActivate?: (row: GraphRow) => void;
  onCopy?: (hash: string) => void;
}> = ({
  entries,
  rows,
  width,
  showHeader = false,
  activeHash,
  onActivate,
  onCopy,
}) => {
  const [hovered, setHovered] = useState<string | null>(null);

  // 悬浮高亮：亮的是「与这个提交直接相连的边」，以及这些边上下连续延伸的那一段线。
  // 车道号只是列，同一列后面可能被别的分支复用，所以不能整列点亮。
  const hiByRow = useMemo(() => {
    if (hovered === null) return null;
    const i = rows.findIndex((r) => r.entry.hash === hovered);
    if (i < 0) return null;
    const row = rows[i];
    const marks: Set<number>[] = rows.map(() => new Set<number>());
    // 本行相连的车道：自己、汇入本提交的其它子边、第一父、合并父
    const lanes = new Set<number>([row.lane, ...row.terminates]);
    if (row.below !== null) lanes.add(row.below);
    for (const c of row.curves) lanes.add(c);
    for (const l of lanes) marks[i].add(l);
    for (const l of lanes) {
      // 向下：沿着线一直走到断开处（父提交继续同一条线）
      if (hasBottomLine(row, l)) {
        for (let j = i + 1; j < rows.length; j++) {
          if (!hasTopLine(rows[j], l)) break;
          marks[j].add(l);
          if (!hasBottomLine(rows[j], l)) break;
        }
      }
      // 向上：子边同理，直到线在某个子提交处断开
      if (hasTopLine(row, l)) {
        for (let j = i - 1; j >= 0; j--) {
          if (!hasBottomLine(rows[j], l)) break;
          marks[j].add(l);
          if (!hasTopLine(rows[j], l)) break;
        }
      }
    }
    return marks;
  }, [hovered, rows]);

  if (entries === null) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-1.5 py-4 text-xs">
        <Loader2Icon className="size-3.5 animate-spin" />
        读取提交图谱…
      </div>
    );
  }
  if (entries.length === 0) return <div className={MSG_CLASS}>暂无提交</div>;

  return (
    <div className="flex flex-col" onMouseLeave={() => setHovered(null)}>
      {showHeader ? (
        <div
          onMouseEnter={() => setHovered(null)}
          className="text-muted-foreground/70 bg-popover sticky top-0 z-10 flex shrink-0 items-center gap-3 px-2 pt-2 pb-2 text-[12px] leading-4"
        >
          <span className="shrink-0" style={{ width }}>
            图谱
          </span>
          <span className="min-w-0 flex-1">提交说明</span>
          <span className="hidden w-16 shrink-0 @sm:block">时间</span>
          <span className="hidden w-[8.5rem] shrink-0 @md:block">作者</span>
          <span className="hidden w-[5rem] shrink-0 @lg:block">提交</span>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className={MSG_CLASS}>无匹配提交</div>
      ) : (
        rows.map((row, index) => {
          const active = activeHash === row.entry.hash;
          return (
            <button
              key={row.entry.hash}
              type="button"
              onClick={() =>
                onActivate ? onActivate(row) : onCopy?.(row.entry.hash)
              }
              title={`${row.entry.subject}\n${row.entry.hash}\n${onActivate ? "点击查看提交详情" : "点击复制哈希"}`}
              onMouseEnter={() => setHovered(row.entry.hash)}
              className={cn(
                "group flex w-full items-center gap-3 rounded-md px-2 text-left transition-colors",
                active ? "bg-muted" : "hover:bg-muted/60",
              )}
              style={{ height: GRAPH_ROW_H }}
            >
              <RowGraph
                row={row}
                width={width}
                pulse={active}
                hi={hiByRow?.[index] ?? null}
                hot={hovered === row.entry.hash}
              />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {row.entry.refs.map((r, i) => (
                  <RefChip key={`${r.kind}:${r.name}:${i}`} r={r} />
                ))}
                <span className="min-w-0 truncate text-sm text-foreground/90">
                  {row.entry.subject}
                </span>
              </span>
              <span className="text-muted-foreground hidden w-16 shrink-0 text-[13px] tabular-nums @sm:block">
                {fmtClock(row.entry.time)}
              </span>
              <span className="text-muted-foreground hidden w-[8.5rem] shrink-0 truncate text-[13px] @md:block">
                {row.entry.author}
              </span>
              <span className="text-muted-foreground hidden w-[5rem] shrink-0 font-mono text-[12px] @lg:block">
                {short(row.entry.hash)}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
};

/**
 * 面板版：搜索 + 紧凑列表。点行复制哈希（面板不做选中态，避免与详情弹窗抢交互）。
 */
export const GitGraph: FC<{ cwd: string; tick?: number }> = ({ cwd, tick }) => {
  const entries = useGitGraphEntries(cwd, tick);
  const [filter, setFilter] = useState("");
  const rows = useGraphRows(entries, filter);
  const width = useMemo(() => graphWidth(rows), [rows]);

  const copy = useCallback((hash: string) => {
    void navigator.clipboard?.writeText(hash).catch(() => {});
  }, []);

  return (
    // @container：面板很窄时按容器宽度收掉作者/时间列，提交信息优先占满
    <div className="@container flex flex-col">
      <SearchField
        value={filter}
        onChange={setFilter}
        className="mb-1 px-0.5"
      />
      <GraphList entries={entries} rows={rows} width={width} onCopy={copy} />
    </div>
  );
};

/** 详情区一格：标签 + 值（哈希可复制，复制后短暂换成对勾） */
const DetailField: FC<{
  label: string;
  value: string;
  mono?: boolean;
  copyText?: string;
  copied?: boolean;
  onCopy?: (text: string) => void;
}> = ({ label, value, mono = false, copyText, copied = false, onCopy }) => (
  <div className="flex min-w-0 items-center gap-1.5">
    <span className="text-muted-foreground w-11 shrink-0">{label}</span>
    <span
      className={cn(
        "min-w-0 truncate text-foreground/90",
        mono && "font-mono text-[12px]",
      )}
    >
      {value}
    </span>
    {copyText ? (
      <button
        type="button"
        title="复制"
        onClick={() => onCopy?.(copyText)}
        className="text-muted-foreground/50 hover:text-foreground hover:bg-muted shrink-0 rounded p-0.5 transition-colors"
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </button>
    ) : null}
  </div>
);

/**
 * 变更图谱弹窗：表格式列表（图谱 / 提交说明 / 时间 / 作者 / 提交）+ 选中提交详情。
 * 顶部可刷新，点击任意行切换详情；「添加到上下文」由调用方决定是否提供。
 */
export const GitGraphDialog: FC<{
  cwd: string;
  branch?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddToContext?: (entry: GitGraphEntry) => void;
}> = ({ cwd, branch, open, onOpenChange, onAddToContext }) => {
  // tick 只在用户点刷新时自增；平时仍由 git-changed 自动重拉
  const [tick, setTick] = useState(0);
  const entries = useGitGraphEntries(open ? cwd : null, tick);
  const [filter, setFilter] = useState("");
  const rows = useGraphRows(entries, filter);
  const width = useMemo(() => graphWidth(rows), [rows]);
  const [activeHash, setActiveHash] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // 已加入输入框的提交：只切图标做反馈，不关窗、不弹 toast
  const [added, setAdded] = useState<string | null>(null);

  // 收起（含外部直接把 open 置 false）时清空：下次打开仍是干净列表
  useEffect(() => {
    if (!open) {
      setActiveHash(null);
      setAdded(null);
    }
  }, [open]);

  const active = useMemo(
    () => entries?.find((e) => e.hash === activeHash) ?? null,
    [entries, activeHash],
  );

  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(text);
    window.setTimeout(() => setCopied((c) => (c === text ? null : c)), 1200);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(82vh,44rem)] w-[min(92vw,60rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="flex shrink-0 flex-row items-center gap-3 px-5 pt-4 pb-3 pr-24">
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <GitGraphIcon className="text-muted-foreground size-[18px] shrink-0" />
              Git 图谱
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-[13px]">
              {branch ? <span className="font-mono">{branch}</span> : null}
              {branch ? " · " : ""}
              {cwd}
            </DialogDescription>
          </div>
          <SearchField
            value={filter}
            onChange={setFilter}
            className="w-64 shrink-0"
          />
        </DialogHeader>

        {/* 刷新：与右上角关闭按钮并排（关闭按钮由 DialogContent 自带） */}
        <Button
          variant="ghost"
          size="icon-sm"
          title="刷新"
          onClick={() => setTick((t) => t + 1)}
          className="text-muted-foreground absolute top-4 right-12"
        >
          <RotateCwIcon />
        </Button>

        <div className="@container mx-4 my-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60">
          <GraphList
            entries={entries}
            rows={rows}
            width={width}
            showHeader
            activeHash={activeHash}
            onActivate={(row) =>
              setActiveHash((h) =>
                h === row.entry.hash ? null : row.entry.hash,
              )
            }
          />
        </div>

        {active ? (
          <div className="animate-in fade-in slide-in-from-bottom-2 shrink-0 px-5 pt-1 pb-3.5 duration-150">
            <div className="flex items-start justify-between gap-4">
              <p className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">
                {active.subject}
              </p>
              {onAddToContext ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    // 同一个提交只加一次：对勾就是「已加入」，重复点不该再塞一行
                    if (added === active.hash) return;
                    onAddToContext(active);
                    setAdded(active.hash);
                  }}
                >
                  {added === active.hash ? (
                    <CheckIcon
                      key={`check-${active.hash}`}
                      className="text-primary size-3.5 animate-in fade-in zoom-in-50 duration-200"
                    />
                  ) : (
                    <MessageSquarePlusIcon
                      key={`plus-${active.hash}`}
                      className="size-3.5"
                    />
                  )}
                  添加到上下文
                </Button>
              ) : null}
            </div>
            <div className="text-muted-foreground mt-3 grid grid-cols-2 gap-x-10 gap-y-2 text-[13px]">
              <DetailField label="作者" value={active.author} />
              <DetailField
                label="提交"
                value={short(active.hash)}
                mono
                copyText={active.hash}
                copied={copied === active.hash}
                onCopy={copy}
              />
              <DetailField label="时间" value={fmtStamp(active.time)} />
              <DetailField
                label="父提交"
                value={
                  active.parents.length
                    ? active.parents.map(short).join("、")
                    : "无（根提交）"
                }
                mono
                copyText={active.parents.join(" ") || undefined}
                copied={
                  !!active.parents.length && copied === active.parents.join(" ")
                }
                onCopy={copy}
              />
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
