/**
 * 表格结构化编辑层（自 CanvasStage 拆出）：按 tableSpec 同源几何渲染可点单元格，
 * 点格原位输入、Enter 下移 / Tab 右移、行列可增删；点遮罩或 Esc 退出并整包提交。
 * 取代旧 textarea 文本协议——那个方案会把全空单元格的行当垃圾滤掉（"只剩表头"bug 根因）。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { type El, type TableEl } from "@/doc";
import { tableSpec } from "@/viewspec";
import type { View } from "@/CanvasStage";

export const TableEditor: FC<{
  el: TableEl;
  view: View;
  /** 选择容器的画布偏移（root = {0,0}） */
  off: { x: number; y: number };
  onCommit: (patch: Partial<El>) => void;
  onClose: () => void;
}> = ({ el, view, off, onCommit, onClose }) => {
  const [rows, setRows] = useState<string[][]>(() => el.rows.map((r) => [...r]));
  const [editing, setEditing] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  /** 遮罩点击时 blur 先于 click：finish 必须读最新 rows，state 走 ref */
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const s = view.s;
  /** 几何与 TableElView/导出同源：始终按本地 rows 算（加删行列后 el 还是旧的） */
  const t = tableSpec({ ...el, rows });
  const cols = t.cols;
  const cellFont = Math.max(9, t.size * s);

  const setCell = (r: number, c: number, text: string) =>
    setRows((prev) => prev.map((row, ri) => (ri === r ? row.map((cell, ci) => (ci === c ? text : cell)) : row)));

  const commit = (next: string[][]) => onCommit({ rows: next } as Partial<El>);
  const finish = () => {
    commit(rowsRef.current);
    onClose();
  };
  /** 行列增删后立即落一版（防抖写盘自然合并；编辑中刷新其他视图不出错） */
  const apply = (next: string[][]) => {
    setRows(next);
    commit(next);
  };

  const move = (r: number, c: number, dr: number, dc: number) => {
    const nr = Math.min(rows.length - 1, Math.max(0, r + dr));
    const nc = Math.min(cols - 1, Math.max(0, c + dc));
    setEditing({ r: nr, c: nc });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const btn = "flex h-5 items-center gap-0.5 rounded border border-foreground/15 bg-background px-1.5 text-[11px] text-foreground/80 hover:bg-foreground/5 disabled:opacity-40";

  return (
    <>
      {/* 遮罩：点画布其他位置 = 结束编辑（先提交）；DOM 顺序在编辑层之前，不挡编辑层。
          .sc-overlay 整层 pointer-events:none，交互层必须显式 auto（同 .sc-textedit / selToolbar） */}
      <div className="pointer-events-auto fixed inset-0" onPointerDown={finish} />
      <div
        className="sc-ui-panel pointer-events-auto absolute"
        style={{ left: (off.x + el.x) * s + view.tx, top: (off.y + el.y) * s + view.ty, width: el.w * s }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div style={{ position: "relative", width: el.w * s, height: el.h * s, outline: "2px solid var(--ink)" }}>
          {rows.map((row, r) => {
            const isHead = r === 0 && t.header;
            return Array.from({ length: cols }, (_, c) => {
              const cx = (t.colX[c] ?? 0) * s;
              const cw = ((t.colX[c + 1] ?? el.w) - (t.colX[c] ?? 0)) * s;
              const rh = t.rowH * s;
              const active = editing.r === r && editing.c === c;
              return (
                <div
                  key={`${r}-${c}`}
                  style={{
                    position: "absolute",
                    left: cx,
                    top: r * rh,
                    width: Math.max(1, cw),
                    height: Math.max(1, rh),
                    background: isHead ? t.headerFill : t.fill,
                    border: `1px solid ${t.stroke}`,
                    boxSizing: "border-box",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: cellFont,
                    lineHeight: `${cellFont}px`,
                    color: t.color,
                    fontWeight: isHead ? 700 : undefined,
                    cursor: active ? "text" : "cell",
                  }}
                  onPointerDown={() => !active && setEditing({ r, c })}
                >
                  {active ? (
                    <input
                      autoFocus
                      value={row[c] ?? ""}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) finish();
                        else if (e.key === "Enter") move(r, c, 1, 0);
                        else if (e.key === "Tab") {
                          e.preventDefault();
                          move(r, c, 0, e.shiftKey ? -1 : 1);
                        } else if (e.key === "Escape") finish();
                      }}
                      onFocus={(e) => e.currentTarget.select()}
                      className="h-full w-full bg-transparent text-center outline-none"
                      style={{ fontSize: cellFont, fontWeight: isHead ? 700 : undefined, color: t.color }}
                    />
                  ) : (
                    <span className="overflow-hidden whitespace-nowrap">{row[c] ?? ""}</span>
                  )}
                </div>
              );
            });
          })}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <button type="button" className={btn} onClick={() => apply([...rows, Array.from({ length: cols }, () => "")])}>
            <PlusIcon className="size-3" /> 行
          </button>
          <button type="button" className={btn} onClick={() => apply(rows.map((r) => [...r, ""]))}>
            <PlusIcon className="size-3" /> 列
          </button>
          <button
            type="button"
            className={btn}
            disabled={rows.length <= 1}
            onClick={() => apply(rows.slice(0, -1))}
          >
            <MinusIcon className="size-3" /> 行
          </button>
          <button
            type="button"
            className={btn}
            disabled={cols <= 1}
            onClick={() => apply(rows.map((r) => r.slice(0, -1)))}
          >
            <MinusIcon className="size-3" /> 列
          </button>
          <button type="button" className={btn} onClick={finish}>
            完成
          </button>
        </div>
      </div>
    </>
  );
};
