"use client";

import { useEffect, useState, type FC } from "react";
import { ChevronDownIcon, RotateCwSquareIcon, XIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** 视口状态（fill=自适应面板；fixed=固定逻辑尺寸居中） */
export type ViewportState = {
  mode: "fill" | "fixed";
  width: number | null;
  height: number | null;
};

/** 设备预设（对齐 DevTools 设备模式常驻档位；坐标为 CSS 逻辑像素） */
export const DEVICE_PRESETS: Array<{ label: string; width: number; height: number }> = [
  { label: "iPhone SE", width: 375, height: 667 },
  { label: "iPhone 14 Pro", width: 393, height: 852 },
  { label: "iPhone 15 Pro Max", width: 430, height: 932 },
  { label: "iPad mini", width: 768, height: 1024 },
  { label: 'iPad Pro 11"', width: 834, height: 1194 },
  { label: "桌面 1280", width: 1280, height: 800 },
];

const MIN_SIZE = 200;
const MAX_SIZE = 4000;

const clampSize = (v: number) =>
  Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(v)));

/** 当前档位名：自适应 / 命中的预设名（含横置）/ 自定义 */
function currentLabel(vp: ViewportState): string {
  if (vp.mode !== "fixed" || !vp.width || !vp.height) return "自适应";
  const hit = DEVICE_PRESETS.find(
    (p) =>
      (p.width === vp.width && p.height === vp.height) ||
      (p.width === vp.height && p.height === vp.width),
  );
  if (!hit) return "自定义";
  return hit.width === vp.width ? hit.label : `${hit.label}（横）`;
}

/**
 * 设备工具栏（DevTools 设备模式风格）：预设下拉 + 自定义 W×H + 横竖屏旋转，
 * 右侧显示缩放比（面板放不下时按比例缩放，避免大尺寸设备在窄面板里溢出）。
 * 尺寸变更统一经 onApply 上抛给 browser-view（它负责同步主进程 + 驱动 webview
 * 元素尺寸）；拖拽调整尺寸的手柄在 browser-view 的设备框上。
 */
export const BrowserDeviceToolbar: FC<{
  vp: ViewportState;
  scale: number;
  onApply: (vp: ViewportState) => void;
  /** 隐藏设备工具栏（✕）：退出设备模式回自适应；出口就摆在行上，不藏进菜单 */
  onClose: () => void;
}> = ({ vp, scale, onApply, onClose }) => {
  const fixed = vp.mode === "fixed" && !!vp.width && !!vp.height;
  const [wInput, setWInput] = useState(vp.width ? String(vp.width) : "");
  const [hInput, setHInput] = useState(vp.height ? String(vp.height) : "");

  // 外部改尺寸（预设/旋转/AI resize/拖拽）时回填输入框
  useEffect(() => {
    setWInput(vp.width ? String(vp.width) : "");
    setHInput(vp.height ? String(vp.height) : "");
  }, [vp.width, vp.height]);

  const commitInputs = () => {
    const w = Number(wInput);
    const h = Number(hInput);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      // 非法输入回填原值，不静默改成别的尺寸
      setWInput(vp.width ? String(vp.width) : "");
      setHInput(vp.height ? String(vp.height) : "");
      return;
    }
    onApply({ mode: "fixed", width: clampSize(w), height: clampSize(h) });
  };

  const rotate = () => {
    if (!fixed) return;
    onApply({ mode: "fixed", width: vp.height!, height: vp.width! });
  };

  const inputCls =
    "border-border/60 bg-muted/30 h-6 w-14 rounded border px-1 text-center font-mono text-xs tabular-nums outline-none";

  return (
    // 控件整组居中（DevTools 设备模式同款排布）；✕ 绝对定位钉在右端，
    // 不参与居中计算，行宽变化时不会把控件推偏
    <div className="text-muted-foreground border-border/50 relative flex h-8 shrink-0 items-center justify-center gap-1 border-b px-2 text-xs">
      {/* 预设：自适应 + 常用设备 */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="设备预设"
              title="设备预设"
              className="hover:text-foreground hover:bg-muted inline-flex h-6 items-center gap-0.5 rounded px-1.5"
            >
              {currentLabel(vp)}
              <ChevronDownIcon className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-44">
          <DropdownMenuItem
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
            onClick={() => onApply({ mode: "fill", width: null, height: null })}
          >
            自适应（填满面板）
          </DropdownMenuItem>
          {DEVICE_PRESETS.map((p) => (
            <DropdownMenuItem
              key={p.label}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
              onClick={() =>
                onApply({ mode: "fixed", width: p.width, height: p.height })
              }
            >
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              <span className="text-muted-foreground/70 font-mono text-xs tabular-nums">
                {p.width}×{p.height}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 自定义尺寸：回车/失焦提交；提交即切到固定模式 */}
      <input
        aria-label="宽度"
        title="宽度（CSS 像素）"
        placeholder="auto"
        value={wInput}
        onChange={(e) => setWInput(e.target.value)}
        onBlur={commitInputs}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitInputs();
          }
        }}
        className={cn(inputCls, !fixed && "text-muted-foreground")}
      />
      <span className="text-muted-foreground/60">×</span>
      <input
        aria-label="高度"
        title="高度（CSS 像素）"
        placeholder="auto"
        value={hInput}
        onChange={(e) => setHInput(e.target.value)}
        onBlur={commitInputs}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitInputs();
          }
        }}
        className={cn(inputCls, !fixed && "text-muted-foreground")}
      />

      {/* 横竖屏旋转（交换宽高）：方形+旋转箭头，别用像刷新的循环箭头 */}
      <button
        type="button"
        aria-label="横屏/竖屏"
        title="横屏/竖屏"
        onClick={rotate}
        disabled={!fixed}
        className="hover:text-foreground hover:bg-muted inline-flex size-6 shrink-0 items-center justify-center rounded disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-inherit"
      >
        <RotateCwSquareIcon className="size-3.5" />
      </button>

      {fixed ? (
        <span className="text-muted-foreground font-mono tabular-nums">
          {Math.round(scale * 100)}%
        </span>
      ) : null}

      {/* 隐藏设备工具栏：行上的直接出口（Trae 同款，✕ 不藏菜单） */}
      <button
        type="button"
        aria-label="隐藏设备工具栏"
        title="隐藏设备工具栏"
        onClick={onClose}
        className="hover:text-foreground hover:bg-muted absolute top-1/2 right-2 inline-flex size-6 shrink-0 -translate-y-1/2 items-center justify-center rounded"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
};
