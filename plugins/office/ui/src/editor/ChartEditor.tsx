/**
 * 图表数据面板（自 CanvasStage 拆出）：按类型给出「类目×系列 / 散点 / 甘特任务」三种表。
 * 支持从 Excel / Numbers / Google Sheets 直接粘贴（Tab 或逗号分隔）：从焦点单元格起
 * 落一块区域，自动扩行/扩列；点遮罩或 Esc 退出并整包提交。
 * 可视化契约由 chart/spec.ts 决定，面板只改数据，不重复实现样式默认值。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type FC } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { type ChartEl, type ChartPoint, type ChartTask, type El } from "@/doc";
import { CHART_META } from "@/chart/spec";
import type { View } from "@/CanvasStage";
import { chartDataModeOf, isBlockPaste, parseClipGrid, pasteCategory, pastePoints, pasteTasks } from "./chart-data";

const CELL = "h-6 min-w-0 rounded border border-foreground/15 bg-background px-1.5 text-[12px] outline-none focus:border-foreground/40";
const BTN = "flex h-5 items-center gap-0.5 rounded border border-foreground/15 bg-background px-1.5 text-xs text-foreground/80 hover:bg-foreground/5 disabled:opacity-40";
const XBTN = "flex size-5 shrink-0 items-center justify-center rounded text-foreground/40 hover:bg-foreground/5 hover:text-foreground";

export const ChartEditor: FC<{
  el: ChartEl;
  view: View;
  /** 选择容器的画布偏移（root = {0,0}） */
  off: { x: number; y: number };
  onCommit: (patch: Partial<El>) => void;
  onClose: () => void;
}> = ({ el, view, off, onCommit, onClose }) => {
  const mode = chartDataModeOf(el.chart);
  const [labels, setLabels] = useState<string[]>([...el.labels]);
  const [names, setNames] = useState<string[]>(el.series.map((s) => s.name));
  /** data[系列][类目]，与 names 对齐；类目数与 labels 对齐（读值越界回退 0） */
  const [data, setData] = useState<number[][]>(el.series.map((s) => [...s.data]));
  const [points, setPoints] = useState<ChartPoint[][]>(el.series.map((s) => (s.points ?? []).map((p) => ({ ...p }))));
  const [tasks, setTasks] = useState<ChartTask[]>((el.tasks ?? []).map((t) => ({ ...t })));
  /** 散点/气泡：当前编辑的系列序号 */
  const [active, setActive] = useState(0);
  /** 粘贴锚点：当前焦点单元格（c=0 为名称列，其余为数值列） */
  const [focus, setFocus] = useState({ r: 0, c: 1 });
  const stateRef = useRef({ labels, names, data, points, tasks, active });
  stateRef.current = { labels, names, data, points, tasks, active };

  const finish = () => {
    const cur = stateRef.current;
    if (mode === "tasks") {
      onCommit({ tasks: cur.tasks.filter((t) => t.name.trim().length > 0) } as Partial<El>);
    } else if (mode === "points") {
      onCommit({
        series: cur.points.map((pts, i) => ({
          ...(el.series[i] ?? { name: cur.names[i] ?? `系列 ${i + 1}`, data: [] }),
          name: cur.names[i] ?? `系列 ${i + 1}`,
          points: pts,
        })),
      } as Partial<El>);
    } else {
      onCommit({
        // 空类目补位而不是删行，保持与 data 的对齐（parse 会丢弃空类目）
        labels: cur.labels.map((l, i) => l.trim() || `类目 ${i + 1}`),
        series: cur.names.map((name, i) => ({
          ...(el.series[i] ?? { name, data: [] }),
          name: name.trim() || `系列 ${i + 1}`,
          data: (cur.data[i] ?? []).slice(0, cur.labels.length),
        })),
      } as Partial<El>);
    }
    onClose();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finishRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 粘贴：单值交给输入框默认行为；块粘贴从焦点单元格起写入 */
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const grid = parseClipGrid(e.clipboardData.getData("text/plain"));
    if (!isBlockPaste(grid)) return;
    e.preventDefault();
    const f = focus;
    if (mode === "tasks") setTasks((p) => pasteTasks(p, grid, f));
    else if (mode === "points") setPoints((p) => p.map((pts, i) => (i === active ? pastePoints(pts, grid, f) : pts)));
    else {
      const next = pasteCategory(labels, names, data, grid, f);
      setLabels(next.labels);
      setNames(next.names);
      setData(next.data);
    }
  };

  const rowOps = {
    add: () => {
      setLabels((p) => [...p, `类目 ${p.length + 1}`]);
      setData((p) => p.map((col) => [...col, 0]));
    },
    del: (r: number) => {
      setLabels((p) => p.filter((_, i) => i !== r));
      setData((p) => p.map((col) => col.filter((_, i) => i !== r)));
    },
  };
  const colOps = {
    add: () => {
      setNames((p) => [...p, `系列 ${p.length + 1}`]);
      setData((p) => [...p, Array.from({ length: labels.length }, () => 0)]);
    },
    del: (i: number) => {
      if (names.length <= 1) return;
      setNames((p) => p.filter((_, j) => j !== i));
      setData((p) => p.filter((_, j) => j !== i));
    },
  };

  const width = Math.max(mode === "category" ? 320 : 396, el.w * view.s);
  // .sc-overlay 整层 pointer-events:none，交互层必须显式 auto（同 .sc-textedit）
  const top = (off.y + el.y + el.h) * view.s + view.ty + 8;
  /** 面板估高 ~320px：图表下方放不下就翻到上方；clamp 到顶栏（46px）之下，避免首行被顶栏盖住 */
  const flip = top + 320 > window.innerHeight - 8;
  const topFinal = flip ? Math.max(54, (off.y + el.y) * view.s + view.ty - 328) : top;
  const hint = "从 Excel/CSV 复制后直接粘贴到任意单元格，可整块覆盖";

  return (
    <>
      {/* 遮罩只罩画布（absolute），不能 fixed 罩全视口：否则编辑时点属性面板第一下被吞成"结束编辑"（同 TableEditor） */}
      <div className="pointer-events-auto absolute inset-0" onPointerDown={finish} />
      <div
        className="sc-ui-panel pointer-events-auto absolute"
        style={{ left: (off.x + el.x) * view.s + view.tx, top: topFinal, width }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onPaste={onPaste}
      >
        <div className="rounded-md border border-foreground/15 bg-background p-2 shadow-lg">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold tracking-wide text-foreground/70">{CHART_META[el.chart ?? "bar"].label}</span>
            <span className="text-muted-foreground truncate text-[11px]" title={hint}>
              {hint}
            </span>
            {mode === "points" && (
              <select
                value={active}
                onChange={(e) => setActive(Number(e.target.value))}
                className="ml-auto h-6 rounded border border-foreground/15 bg-background px-1 text-[11px]"
                aria-label="编辑系列"
              >
                {names.map((n, i) => (
                  <option key={i} value={i}>
                    {n || `系列 ${i + 1}`}
                  </option>
                ))}
              </select>
            )}
          </div>

          {mode === "category" && (
            <>
              <div className="flex items-center gap-1" style={{ paddingLeft: 92 }}>
                {names.map((name, i) => (
                  <div key={i} className="flex min-w-0 flex-1 items-center gap-0.5">
                    <input
                      value={name}
                      onChange={(e) => setNames((p) => p.map((n, j) => (j === i ? e.target.value : n)))}
                      onFocus={() => setFocus({ r: 0, c: i + 1 })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={`${CELL} flex-1 font-semibold`}
                      aria-label={`系列 ${i + 1} 名称`}
                    />
                    <button type="button" className={XBTN} disabled={names.length <= 1} onClick={() => colOps.del(i)} aria-label="删除系列">
                      <MinusIcon className="size-3" />
                    </button>
                  </div>
                ))}
                <button type="button" className={BTN} onClick={colOps.add} aria-label="添加系列">
                  <PlusIcon className="size-3" />
                </button>
              </div>
              <div className="mt-1 max-h-52 space-y-1 overflow-y-auto">
                {labels.map((lb, r) => (
                  <div key={r} className="flex items-center gap-1">
                    <input
                      value={lb}
                      placeholder={`类目 ${r + 1}`}
                      autoFocus={r === 0}
                      onChange={(e) => setLabels((p) => p.map((v, j) => (j === r ? e.target.value : v)))}
                      onFocus={() => setFocus({ r, c: 0 })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={`${CELL} w-[88px] shrink-0`}
                      aria-label={`类目 ${r + 1}`}
                    />
                    {names.map((_, i) => (
                      <input
                        key={i}
                        type="number"
                        value={data[i]?.[r] ?? 0}
                        onChange={(e) => {
                          const v = Number.parseFloat(e.target.value);
                          setData((p) => p.map((col, j) => (j === i ? col.map((x, k) => (k === r ? (Number.isFinite(v) ? v : 0) : x)) : col)));
                        }}
                        onFocus={() => setFocus({ r, c: i + 1 })}
                        onKeyDown={(e) => e.stopPropagation()}
                        className={`${CELL} flex-1 text-right tabular-nums`}
                        aria-label={`${names[i]} 第 ${r + 1} 个数值`}
                      />
                    ))}
                    <button type="button" className={XBTN} onClick={() => rowOps.del(r)} aria-label="删除类目行">
                      <MinusIcon className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <button type="button" className={BTN} onClick={rowOps.add}>
                  <PlusIcon className="size-3" /> 类目
                </button>
                <span className="text-muted-foreground text-xs">饼/环图只取第一个系列</span>
                <button type="button" className={`${BTN} ml-auto`} onClick={finish}>
                  完成
                </button>
              </div>
            </>
          )}

          {mode === "points" && (
            <>
              <div className="flex items-center gap-1 pb-1">
                <span className="w-[22px] shrink-0 text-[11px] text-muted-foreground">#</span>
                <span className="w-[86px] shrink-0 text-right text-[11px] text-muted-foreground">X</span>
                <span className="flex-1 text-right text-[11px] text-muted-foreground">Y</span>
                {el.chart === "bubble" && <span className="w-[60px] shrink-0 text-right text-[11px] text-muted-foreground">尺寸</span>}
                <span className="w-4" />
              </div>
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {(points[active] ?? []).map((p, r) => (
                  <div key={r} className="flex items-center gap-1">
                    <span className="w-[22px] shrink-0 text-[11px] text-muted-foreground">{r + 1}</span>
                    <input
                      type="number"
                      step="any"
                      value={p.x}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        setPoints((prev) => prev.map((pts, i) => (i === active ? pts.map((q, k) => (k === r ? { ...q, x: Number.isFinite(v) ? v : 0 } : q)) : pts)));
                      }}
                      onFocus={() => setFocus({ r, c: 0 })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={`${CELL} w-[86px] shrink-0 text-right tabular-nums`}
                      aria-label={`散点 ${r + 1} X`}
                    />
                    <input
                      type="number"
                      step="any"
                      value={p.y}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        setPoints((prev) => prev.map((pts, i) => (i === active ? pts.map((q, k) => (k === r ? { ...q, y: Number.isFinite(v) ? v : 0 } : q)) : pts)));
                      }}
                      onFocus={() => setFocus({ r, c: 1 })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={`${CELL} flex-1 text-right tabular-nums`}
                      aria-label={`散点 ${r + 1} Y`}
                    />
                    {el.chart === "bubble" && (
                      <input
                        type="number"
                        step="any"
                        value={p.size ?? ""}
                        placeholder="尺寸"
                        onChange={(e) => {
                          const v = Number.parseFloat(e.target.value);
                          setPoints((prev) =>
                            prev.map((pts, i) =>
                              i === active ? pts.map((q, k) => (k === r ? { ...q, size: Number.isFinite(v) ? v : undefined } : q)) : pts,
                            ),
                          );
                        }}
                        onFocus={() => setFocus({ r, c: 2 })}
                        onKeyDown={(e) => e.stopPropagation()}
                        className={`${CELL} w-[60px] shrink-0 text-right tabular-nums`}
                        aria-label={`气泡 ${r + 1} 尺寸`}
                      />
                    )}
                    <button
                      type="button"
                      className={XBTN}
                      onClick={() =>
                        setPoints((prev) => prev.map((pts, i) => (i === active ? pts.filter((_, k) => k !== r) : pts)))
                      }
                      aria-label="删除数据点"
                    >
                      <MinusIcon className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <button
                  type="button"
                  className={BTN}
                  onClick={() => setPoints((prev) => prev.map((pts, i) => (i === active ? [...pts, { x: 0, y: 0 }] : pts)))}
                >
                  <PlusIcon className="size-3" /> 数据点
                </button>
                {names.length > 1 && (
                  <button
                    type="button"
                    className={BTN}
                    onClick={() => {
                      setPoints((prev) => prev.filter((_, i) => i !== active));
                      setNames((prev) => prev.filter((_, i) => i !== active));
                      setActive((a) => Math.max(0, a - 1));
                      setFocus({ r: 0, c: 0 });
                    }}
                    aria-label="删除当前系列"
                  >
                    <MinusIcon className="size-3" /> 系列
                  </button>
                )}
                <button
                  type="button"
                  className={BTN}
                  onClick={() => {
                    setNames((prev) => [...prev, `系列 ${prev.length + 1}`]);
                    setPoints((prev) => [...prev, []]);
                    setActive(names.length);
                    setFocus({ r: 0, c: 0 });
                  }}
                  aria-label="添加系列"
                >
                  <PlusIcon className="size-3" /> 系列
                </button>
                <button type="button" className={`${BTN} ml-auto`} onClick={finish}>
                  完成
                </button>
              </div>
              <div className="text-muted-foreground mt-1 text-[11px]">气泡的尺寸列可选；X/Y 落在数值轴上</div>
            </>
          )}

          {mode === "tasks" && (
            <>
              <div className="flex items-center gap-1 pb-1">
                <span className="w-[120px] shrink-0 text-[11px] font-semibold text-foreground/70">任务</span>
                <span className="flex-1 text-right text-[11px] text-muted-foreground">开始</span>
                <span className="flex-1 text-right text-[11px] text-muted-foreground">结束</span>
                <span className="w-[64px] text-right text-[11px] text-muted-foreground">进度</span>
                <span className="w-4" />
              </div>
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {tasks.map((t, r) => (
                  <div key={r} className="flex items-center gap-1">
                    <input
                      value={t.name}
                      placeholder={`任务 ${r + 1}`}
                      onChange={(e) => setTasks((p) => p.map((v, j) => (j === r ? { ...v, name: e.target.value } : v)))}
                      onFocus={() => setFocus({ r, c: 0 })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={`${CELL} w-[120px] shrink-0`}
                      aria-label={`任务 ${r + 1} 名称`}
                    />
                    <input
                      type="number"
                      step="any"
                      value={t.start}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        setTasks((p) => p.map((x, j) => (j === r ? { ...x, start: Number.isFinite(v) ? v : 0 } : x)));
                      }}
                      onFocus={() => setFocus({ r, c: 1 })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={`${CELL} flex-1 text-right tabular-nums`}
                      aria-label={`任务 ${r + 1} 开始`}
                    />
                    <input
                      type="number"
                      step="any"
                      value={t.end}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        setTasks((p) => p.map((x, j) => (j === r ? { ...x, end: Number.isFinite(v) ? v : 0 } : x)));
                      }}
                      onFocus={() => setFocus({ r, c: 2 })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={`${CELL} flex-1 text-right tabular-nums`}
                      aria-label={`任务 ${r + 1} 结束`}
                    />
                    <input
                      type="number"
                      step="0.05"
                      min={0}
                      max={1}
                      value={t.progress ?? 0}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        const n = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
                        setTasks((p) => p.map((x, j) => (j === r ? { ...x, progress: n } : x)));
                      }}
                      onFocus={() => setFocus({ r, c: 3 })}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={`${CELL} w-[64px] shrink-0 text-right tabular-nums`}
                      aria-label={`任务 ${r + 1} 进度`}
                    />
                    <button
                      type="button"
                      className={XBTN}
                      onClick={() => setTasks((p) => p.filter((_, j) => j !== r))}
                      aria-label="删除任务行"
                    >
                      <MinusIcon className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <button
                  type="button"
                  className={BTN}
                  onClick={() => {
                    const last = tasks[tasks.length - 1];
                    setTasks((p) => [...p, { name: `任务 ${p.length + 1}`, start: last?.end ?? 0, end: (last?.end ?? 0) + 2, progress: 0 }]);
                  }}
                >
                  <PlusIcon className="size-3" /> 任务
                </button>
                <span className="text-muted-foreground text-[11px]">进度 0~1（0.4 = 40%）</span>
                <button type="button" className={`${BTN} ml-auto`} onClick={finish}>
                  完成
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
};
