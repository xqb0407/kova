"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FC,
} from "react";
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
import { insertOrAppendDirective } from "@/components/agent-thread/cm-composer-input";
import { buildCommitDirective } from "@/lib/composer/commit-reference";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import {
  gitLogGraph,
  type GitGraphEntry,
  type GitGraphRef,
} from "@/lib/git/git";
import { onGitChanged } from "@/lib/git/git-status";
import {
  GRAPH_COLORS,
  GRAPH_ROW_H,
  laneWidthFor,
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

/** 选中提交 → 输入框里的引用芯片（不是把文字直接贴进去）：
 *  输入框在场落光标处、不在场退回草稿追加；返回是否插入成功。
 *  芯片发送时由 buildPiSendInput 展开成一行提交描述（见 lib/composer/commit-reference）。 */
export function addCommitToComposer(
  aui: {
    composer: {
      getState: () => { text?: string };
      setText: (text: string) => void;
    };
  },
  entry: GitGraphEntry,
): boolean {
  return insertOrAppendDirective(
    aui,
    buildCommitDirective({
      hash: entry.hash,
      subject: entry.subject,
      author: entry.author,
      time: entry.time,
    }),
  );
}

const laneColor = (color: number) => GRAPH_COLORS[color % GRAPH_COLORS.length];
// 留 2px 内边距：选中环（半径 r+3.4）不会被 SVG 左边缘裁掉
const GRAPH_INSET = 2;
const CY = GRAPH_ROW_H / 2;
const laneX = (lane: number, laneW: number) =>
  lane * laneW + laneW / 2 + GRAPH_INSET;

/** 圆点 → 底边某车道的合并/续道曲线（半径固定，弯头收得紧一点更像正规 git 图） */
const curveOut = (from: number, to: number, laneW: number) =>
  `M ${laneX(from, laneW)} ${CY} C ${laneX(from, laneW)} ${CY + 8}, ${laneX(to, laneW)} ${GRAPH_ROW_H - 8}, ${laneX(to, laneW)} ${GRAPH_ROW_H}`;

/** 顶边某车道 → 圆点：分叉汇入必须弯到圆点上，画直线会在半途留下悬空的断头 */
const curveIn = (from: number, to: number, laneW: number) =>
  `M ${laneX(from, laneW)} 0 C ${laneX(from, laneW)} ${CY - 8}, ${laneX(to, laneW)} ${CY - 8}, ${laneX(to, laneW)} ${CY}`;

/** 该行画了这条车道的上半段（顶边→中点）：自己接上方子边、直穿、或其它子边汇入本提交 */
const hasTopLine = (r: GraphRow, lane: number) =>
  (r.lane === lane && r.above) ||
  r.passThrough.some((p) => p.lane === lane) ||
  r.terminates.some((t) => t.lane === lane);

/** 该行画了这条车道的下半段（中点→底边）：直穿、第一父续道/换道、合并父曲线 */
const hasBottomLine = (r: GraphRow, lane: number) =>
  r.passThrough.some((p) => p.lane === lane) ||
  r.below?.lane === lane ||
  r.curves.some((c) => c.lane === lane);

/**
 * 单行左侧拓扑图：细车道线 + 小实心圆点（无光晕），选中行只加一圈细描边。
 * 线色跟着血缘走（GraphRow.color / GraphLane.color），换道不断色。
 */
const RowGraph: FC<{
  row: GraphRow;
  width: number;
  laneW: number;
  pulse?: boolean;
  /** 本行需要保持原色的车道集合（悬浮高亮）；null 表示全部原色 */
  hi?: Set<number> | null;
  /** 当前悬浮的这一行：只亮它的节点，同车道上下其它节点仍变淡 */
  hot?: boolean;
}> = ({ row, width, laneW, pulse = false, hi = null, hot = false }) => {
  const own = laneColor(row.color);
  const segs: { d: string; c: string; lane: number }[] = [];
  if (row.above)
    segs.push({
      d: `M ${laneX(row.lane, laneW)} 0 L ${laneX(row.lane, laneW)} ${CY}`,
      c: own,
      lane: row.lane,
    });
  for (const t of row.terminates)
    segs.push({
      d: curveIn(t.lane, row.lane, laneW),
      c: laneColor(t.color),
      lane: t.lane,
    });
  for (const p of row.passThrough)
    segs.push({
      d: `M ${laneX(p.lane, laneW)} 0 L ${laneX(p.lane, laneW)} ${GRAPH_ROW_H}`,
      c: laneColor(p.color),
      lane: p.lane,
    });
  if (row.below?.lane === row.lane)
    segs.push({
      d: `M ${laneX(row.lane, laneW)} ${CY} L ${laneX(row.lane, laneW)} ${GRAPH_ROW_H}`,
      c: laneColor(row.below.color),
      lane: row.lane,
    });
  else if (row.below)
    segs.push({
      d: curveOut(row.lane, row.below.lane, laneW),
      c: laneColor(row.below.color),
      lane: row.below.lane,
    });
  for (const c of row.curves)
    segs.push({
      d: curveOut(row.lane, c.lane, laneW),
      c: laneColor(c.color),
      lane: c.lane,
    });

  const tip = row.entry.refs.length > 0; // 分支/标签尖：略大的实心点
  const merge = row.entry.parents.length > 1;
  const r = tip ? 5 : merge ? 4.5 : 4;
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
            strokeWidth={dim ? 1.6 : lit ? 2.6 : 2}
            strokeLinecap="round"
            fill="none"
            className={cn(
              "transition-opacity duration-150 ease-out",
              dim ? "opacity-25" : "opacity-100",
            )}
          />
        );
      })}
      <g
        className={cn(
          "transition-opacity duration-150",
          nodeFaded && "opacity-25",
        )}
      >
        {/* 选中提交：一圈细描边定位，不做脉冲动画 */}
        {pulse ? (
          <circle
            cx={laneX(row.lane, laneW)}
            cy={CY}
            r={r + 3.4}
            fill="none"
            stroke={own}
            strokeWidth={1.6}
            strokeOpacity={0.55}
          />
        ) : null}
        <circle
          cx={laneX(row.lane, laneW)}
          cy={CY}
          r={r}
          fill={own}
          stroke="var(--card)"
          strokeWidth={1.5}
        />
      </g>
    </svg>
  );
};

/** ref 小徽标：无图标、低饱和底色，宽度让给提交说明 */
/** 行内最多展示的 refs 数：一个提交常挂多个分支/标签，全量平铺会把提交说明
 *  挤成 0 宽（典型：merge 提交同时是 HEAD、分支、远端与标签） */
const MAX_VISIBLE_REFS = 2;

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
      // shrink + min-w-0：refs 多时收缩截断，而不是撑破列宽压住时间/作者/哈希
      "inline-flex max-w-[9rem] min-w-0 shrink items-center rounded-[5px] px-2 text-[12px] leading-[1.5] font-medium",
      REF_STYLE[r.kind],
    )}
  >
    <span className="min-w-0 truncate">{r.name}</span>
  </span>
);

/**
 * 图谱数据缓存（cwd → 提交列表）：
 * - 面板与弹窗同时挂载时共用一次 IPC（在途合并），不会各 spawn 一个 git 进程；
 * - "git-changed" 抖动合并成一次尾随拉取（连续 stage/commit 只拉一次）；
 * - 命中缓存先渲染，再后台刷新（SWR），切回面板不白屏。
 */
const graphCache = new Map<string, GitGraphEntry[]>();
const graphInflight = new Map<string, Promise<GitGraphEntry[]>>();
const graphFetchedAt = new Map<string, number>();
const GRAPH_TTL_MS = 1500;

function fetchGraph(cwd: string, force = false): Promise<GitGraphEntry[]> {
  const cached = graphCache.get(cwd);
  if (
    !force &&
    cached &&
    Date.now() - (graphFetchedAt.get(cwd) ?? 0) < GRAPH_TTL_MS
  )
    return Promise.resolve(cached);
  const running = graphInflight.get(cwd);
  if (running) return running; // 另一处（面板/弹窗）已经在拉了
  const p = gitLogGraph(cwd, 200)
    .then((r) => r ?? [])
    .catch(() => graphCache.get(cwd) ?? [])
    .then((list) => {
      graphCache.set(cwd, list);
      graphFetchedAt.set(cwd, Date.now());
      graphInflight.delete(cwd);
      return list;
    });
  graphInflight.set(cwd, p);
  return p;
}

/** 提交列表：初次拉取 + 写操作后经 "git-changed" 自动重拉（面板与弹窗共用缓存）；
 *  cwd 为 null 时（弹窗收起）不拉数据，省一次 IPC */
function useGitGraphEntries(
  cwd: string | null,
  tick?: number,
): GitGraphEntry[] | null {
  const [entries, setEntries] = useState<GitGraphEntry[] | null>(() =>
    cwd ? (graphCache.get(cwd) ?? null) : null,
  );
  useEffect(() => {
    if (!cwd) {
      setEntries(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setEntries(graphCache.get(cwd) ?? null); // 有缓存先顶上，别闪 loading
    const pull = () => {
      void fetchGraph(cwd, true).then((r) => {
        if (alive) setEntries(r);
      });
    };
    pull();
    const off = onGitChanged((changed) => {
      if (changed !== cwd) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        pull();
      }, 150);
    });
    return () => {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
    };
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
 * 图区尺寸：按所有行真正画出来的最大车道索引取宽，而不是 layout 里车道表的长度
 * ——中间空出来的道也会被算进长度，一列空车道就把提交说明推得老远。
 * 车道多时同步收紧列距，多人协作的分支图也不会把说明挤到很右边。
 */
function graphMetrics(rows: GraphRow[]): { laneW: number; width: number } {
  let max = 0;
  for (const r of rows) {
    max = Math.max(max, r.lane, r.below?.lane ?? 0);
    for (const l of r.curves) max = Math.max(max, l.lane);
    for (const l of r.passThrough) max = Math.max(max, l.lane);
    for (const l of r.terminates) max = Math.max(max, l.lane);
  }
  const lanes = max + 1;
  const laneW = laneWidthFor(lanes);
  return { laneW, width: Math.max(lanes * laneW, 24) + 4 };
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

const MSG_CLASS = "text-muted-foreground px-1 py-6 text-center text-xs";

/** 单行提交（memo）：只在本行的选中/悬浮/高亮状态变化时重渲染，不跟着整表走 */
const GraphRowItem = memo(function GraphRowItem({
  row,
  width,
  laneW,
  active,
  hi,
  hot,
  onActivate,
  onCopy,
  onHover,
}: {
  row: GraphRow;
  width: number;
  laneW: number;
  active: boolean;
  hi: Set<number> | null;
  hot: boolean;
  onActivate?: (row: GraphRow) => void;
  onCopy?: (hash: string) => void;
  onHover: (hash: string | null) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => (onActivate ? onActivate(row) : onCopy?.(row.entry.hash))}
      title={`${row.entry.subject}\n${row.entry.hash}\n${onActivate ? "点击查看提交详情" : "点击复制哈希"}`}
      onMouseEnter={() => onHover(row.entry.hash)}
      className={cn(
        "group flex w-full items-center gap-3 rounded-md px-2 text-left transition-colors",
        active ? "bg-muted" : "hover:bg-muted/60",
      )}
      style={{ height: GRAPH_ROW_H }}
    >
      <RowGraph
        row={row}
        width={width}
        laneW={laneW}
        pulse={active}
        hi={hi}
        hot={hot}
      />
      {/* overflow-hidden：refs/说明再长也在本列内裁切，绝不压到右侧三列 */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {row.entry.refs.slice(0, MAX_VISIBLE_REFS).map((r, i) => (
          <RefChip key={`${r.kind}:${r.name}:${i}`} r={r} />
        ))}
        {row.entry.refs.length > MAX_VISIBLE_REFS ? (
          <span
            title={row.entry.refs
              .slice(MAX_VISIBLE_REFS)
              .map((r) => r.name)
              .join("\n")}
            className="text-muted-foreground bg-muted/70 inline-flex shrink-0 items-center rounded-[5px] px-1.5 text-[12px] leading-[1.5] font-medium tabular-nums"
          >
            +{row.entry.refs.length - MAX_VISIBLE_REFS}
          </span>
        ) : null}
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
});

/** 列表体：表头（弹窗）+ 行；窄容器按容器宽度收掉时间/作者/哈希列 */
const GraphList: FC<{
  entries: GitGraphEntry[] | null;
  rows: GraphRow[];
  width: number;
  laneW: number;
  showHeader?: boolean;
  activeHash?: string | null;
  onActivate?: (row: GraphRow) => void;
  onCopy?: (hash: string) => void;
}> = ({
  entries,
  rows,
  width,
  laneW,
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
    const lanes = new Set<number>([
      row.lane,
      ...row.terminates.map((t) => t.lane),
    ]);
    if (row.below) lanes.add(row.below.lane);
    for (const c of row.curves) lanes.add(c.lane);
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
        rows.map((row, index) => (
          <GraphRowItem
            key={row.entry.hash}
            row={row}
            width={width}
            laneW={laneW}
            active={activeHash === row.entry.hash}
            hi={hiByRow?.[index] ?? null}
            hot={hovered === row.entry.hash}
            onActivate={onActivate}
            onCopy={onCopy}
            onHover={setHovered}
          />
        ))
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
  const { width, laneW } = useMemo(() => graphMetrics(rows), [rows]);

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
      <GraphList
        entries={entries}
        rows={rows}
        width={width}
        laneW={laneW}
        onCopy={copy}
      />
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
  onAddToContext?: (entry: GitGraphEntry) => boolean;
}> = ({ cwd, branch, open, onOpenChange, onAddToContext }) => {
  // tick 只在用户点刷新时自增；平时仍由 git-changed 自动重拉
  const [tick, setTick] = useState(0);
  const entries = useGitGraphEntries(open ? cwd : null, tick);
  const [filter, setFilter] = useState("");
  const rows = useGraphRows(entries, filter);
  const { width, laneW } = useMemo(() => graphMetrics(rows), [rows]);
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

  // 稳定引用：GraphRowItem 用 memo，回调每次新建会让整表失效
  const activate = useCallback((row: GraphRow) => {
    setActiveHash((h) => (h === row.entry.hash ? null : row.entry.hash));
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
            laneW={laneW}
            showHeader
            activeHash={activeHash}
            onActivate={activate}
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
                    // 同一个提交只加一次：对勾就是「已加入」，重复点不该再塞一枚
                    if (added === active.hash) return;
                    if (!onAddToContext(active)) {
                      toast.error("输入框未就绪，未能添加到对话");
                      return;
                    }
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
