/**
 * 图表结构化编辑层（自 CanvasStage 拆出）：类目行 × 系列列的小表单，
 * 支持增删类目/系列；点遮罩或 Esc 退出并整包提交 labels/series。
 * 取代旧 textarea 文本协议（首行系列名 + Tab 数值）——不易懂也易丢数据。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { type ChartEl, type El } from "@/doc";
import type { View } from "@/CanvasStage";

export const ChartEditor: FC<{
  el: ChartEl;
  view: View;
  /** 选择容器的画布偏移（root = {0,0}） */
  off: { x: number; y: number };
  onCommit: (patch: Partial<El>) => void;
  onClose: () => void;
}> = ({ el, view, off, onCommit, onClose }) => {
  const [labels, setLabels] = useState<string[]>([...el.labels]);
  const [names, setNames] = useState<string[]>(el.series.map((s) => s.name));
  /** data[系列][类目]，与 names 对齐；类目数与 labels 对齐（读值越界回退 0） */
  const [data, setData] = useState<number[][]>(el.series.map((s) => [...s.data]));
  const stateRef = useRef({ labels, names, data });
  stateRef.current = { labels, names, data };

  const finish = () => {
    const cur = stateRef.current;
    onCommit({
      labels: cur.labels,
      series: cur.names.map((name, i) => ({ name, data: (cur.data[i] ?? []).slice(0, cur.labels.length) })),
    } as Partial<El>);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rowOps = {
    add: () => {
      setLabels((p) => [...p, ""]);
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

  const cell = "h-6 min-w-0 rounded border border-foreground/15 bg-background px-1.5 text-[12px] outline-none focus:border-foreground/40";
  const btn = "flex h-5 items-center gap-0.5 rounded border border-foreground/15 bg-background px-1.5 text-[11px] text-foreground/80 hover:bg-foreground/5 disabled:opacity-40";
  const xBtn = "flex size-5 shrink-0 items-center justify-center rounded text-foreground/40 hover:bg-foreground/5 hover:text-foreground";
  const width = Math.max(320, el.w * view.s);
  // .sc-overlay 整层 pointer-events:none，交互层必须显式 auto（同 .sc-textedit）
  const top = (off.y + el.y + el.h) * view.s + view.ty + 8;
  /** 面板估高 ~290px：图表下方放不下就翻到上方；clamp 到顶栏（46px）之下，避免首行被顶栏盖住 */
  const flip = top + 290 > window.innerHeight - 8;
  const topFinal = flip ? Math.max(54, (off.y + el.y) * view.s + view.ty - 296) : top;

  return (
    <>
      {/* 遮罩只罩画布（absolute），不能 fixed 罩全视口：否则编辑时点属性面板第一下被吞成"结束编辑"（同 TableEditor） */}
      <div className="pointer-events-auto absolute inset-0" onPointerDown={finish} />
      <div
        className="sc-ui-panel pointer-events-auto absolute"
        style={{ left: (off.x + el.x) * view.s + view.tx, top: topFinal, width }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="rounded-md border border-foreground/15 bg-background p-2 shadow-lg">
          <div className="flex items-center gap-1" style={{ paddingLeft: 92 }}>
            {names.map((name, i) => (
              <div key={i} className="flex min-w-0 flex-1 items-center gap-0.5">
                <input
                  value={name}
                  onChange={(e) => setNames((p) => p.map((n, j) => (j === i ? e.target.value : n)))}
                  onKeyDown={(e) => e.stopPropagation()}
                  className={`${cell} flex-1 font-semibold`}
                  aria-label={`系列 ${i + 1} 名称`}
                />
                <button type="button" className={xBtn} disabled={names.length <= 1} onClick={() => colOps.del(i)} aria-label="删除系列">
                  <MinusIcon className="size-3" />
                </button>
              </div>
            ))}
            <button type="button" className={btn} onClick={colOps.add} aria-label="添加系列">
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
                  onKeyDown={(e) => e.stopPropagation()}
                  className={`${cell} w-[88px] shrink-0`}
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
                    onKeyDown={(e) => e.stopPropagation()}
                    className={`${cell} flex-1 text-right tabular-nums`}
                    aria-label={`${names[i]} 第 ${r + 1} 个数值`}
                  />
                ))}
                <button type="button" className={xBtn} onClick={() => rowOps.del(r)} aria-label="删除类目行">
                  <MinusIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <button type="button" className={btn} onClick={rowOps.add}>
              <PlusIcon className="size-3" /> 类目
            </button>
            <span className="text-muted-foreground text-[11px]">饼/环图只取第一个系列</span>
            <button type="button" className={`${btn} ml-auto`} onClick={finish}>
              完成
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
