/**
 * ContextMenu：画布/图层树共用的右键菜单。
 * 受控浮层（坐标 + 条目由调用方给；条目在每次渲染时按当前选择现算，避免闭包过期），
 * 视口边缘自动收位；外点/Esc/滚轮/窗口缩放关闭。
 * nodeMenu / canvasMenu 是两份条目清单的单一出处（快捷键标注与行为同源）。
 */
import { useEffect, useRef, type FC, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronsDown,
  ChevronsUp,
  Code,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Group,
  ImagePlus,
  Lock,
  LockOpen,
  Maximize2,
  Scissors,
  Square,
  Trash2,
  Ungroup,
} from "lucide-react";
import { findNode, type DesignNode } from "../doc";
import { nodeToCss } from "../css";
import { copyText } from "../lib/clipboard";
import { bridge } from "../bridge";
import type { DesignStore } from "../state";

export type CtxItem =
  | { sep: true }
  | {
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onClick: () => void;
    };

export const ContextMenu: FC<{ x: number; y: number; items: CtxItem[]; onClose: () => void }> = ({ x, y, items, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      }
    };
    const close = () => onClose();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);
  // 预估尺寸收位（条目定高，够准）
  const W = 196;
  const H = items.reduce((a, it) => a + ("sep" in it ? 9 : 28), 12);
  return (
    <div
      ref={ref}
      data-ctx-menu=""
      className="fixed z-[70] rounded-xl border p-1 shadow-pop"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - W - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - H - 8)),
        width: W,
        borderColor: "var(--border)",
        background: "var(--popover)",
        color: "var(--popover-foreground)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        "sep" in it ? (
          <div key={i} className="my-1 h-px" style={{ background: "var(--border)" }} />
        ) : (
          <button
            key={i}
            type="button"
            disabled={it.disabled}
            onClick={() => {
              it.onClick();
              onClose();
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--secondary)] disabled:cursor-default disabled:opacity-40"
            style={{ color: it.danger ? "var(--destructive)" : "var(--foreground)" }}
          >
            <span className="flex w-4 shrink-0 items-center justify-center">{it.icon}</span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.shortcut && (
              <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: "var(--muted-foreground)" }}>
                {it.shortcut}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
};

/**
 * 显隐/锁定批量切换（菜单与快捷键共用）：混合选择时按“有任何隐藏/有任何锁定”
 * 统一整组取反（与菜单文案的单一方向一致）；多条 updateNode 用 coalesce 并成一个撤销步。
 */
export function toggleFlagAll(store: DesignStore, ids: string[], flag: "visible" | "locked") {
  const nodes = ids.map((id) => findNode(store.doc, id)?.node).filter(Boolean) as DesignNode[];
  if (flag === "visible") {
    const v = nodes.some((n) => n.visible === false); // 有隐藏的 → 全显，否则全隐
    nodes.forEach((n, i) => store.updateNode(n.id, { visible: v } as Partial<DesignNode>, i > 0 ? { coalesce: true } : undefined));
  } else {
    const v = !nodes.some((n) => n.locked === true); // 有锁定的 → 全解，否则全锁
    nodes.forEach((n, i) => store.updateNode(n.id, { locked: v } as Partial<DesignNode>, i > 0 ? { coalesce: true } : undefined));
  }
}

/** 节点右键菜单：ids = 生效选择（右键未选中节点时调用方已把选择改为它） */
export function nodeMenu(store: DesignStore, ids: string[]): CtxItem[] {
  if (ids.length === 0) return canvasMenu(store);
  const doc = store.doc;
  const nodes = ids.map((id) => findNode(doc, id)?.node).filter(Boolean) as DesignNode[];
  const first = nodes[0];
  const anyGroup = nodes.some((n) => n.type === "group");
  const anyHidden = nodes.some((n) => n.visible === false);
  const anyLocked = nodes.some((n) => n.locked === true);
  return [
    { label: "复制", icon: <Copy size={13} />, shortcut: "⌘C", onClick: () => store.copySelected() },
    { label: "剪切", icon: <Scissors size={13} />, shortcut: "⌘X", onClick: () => store.cutSelected() },
    { label: "创建副本", icon: <CopyPlus size={13} />, shortcut: "⌘D", onClick: () => store.duplicateSelected() },
    { sep: true },
    { label: "置于顶层", icon: <ArrowUpToLine size={13} />, shortcut: "⌘⇧]", onClick: () => store.reorderSelected("front") },
    { label: "上移一层", icon: <ChevronsUp size={13} />, shortcut: "⌘]", onClick: () => store.reorderSelected("up") },
    { label: "下移一层", icon: <ChevronsDown size={13} />, shortcut: "⌘[", onClick: () => store.reorderSelected("down") },
    { label: "置于底层", icon: <ArrowDownToLine size={13} />, shortcut: "⌘⇧[", onClick: () => store.reorderSelected("back") },
    { sep: true },
    ...(ids.length >= 2 ? [{ label: "成组", icon: <Group size={13} />, shortcut: "⌘G", onClick: () => store.groupSelected() }] : []),
    ...(anyGroup
      ? [{ label: "取消成组", icon: <Ungroup size={13} />, shortcut: "⌘⇧G", onClick: () => store.ungroupSelected() }]
      : []),
    {
      label: anyHidden ? "显示" : "隐藏",
      icon: anyHidden ? <Eye size={13} /> : <EyeOff size={13} />,
      shortcut: "⌘⇧H",
      onClick: () => toggleFlagAll(store, ids, "visible"),
    },
    {
      label: anyLocked ? "解锁" : "锁定",
      icon: anyLocked ? <LockOpen size={13} /> : <Lock size={13} />,
      shortcut: "⌘⇧L",
      onClick: () => toggleFlagAll(store, ids, "locked"),
    },
    ...(nodes.length === 1 && first
      ? [
          {
            label: "复制 CSS",
            icon: <Code size={13} />,
            shortcut: "⌘⇧C",
            onClick: () => {
              void copyText(nodeToCss(first)).then((ok) => bridge.notify(ok ? "已复制该图层的 CSS" : "复制失败", ok ? undefined : "error"));
            },
          },
        ]
      : []),
    { sep: true },
    { label: "缩放到选中", icon: <Maximize2 size={13} />, shortcut: "⇧⌘1", onClick: () => store.fitSelection() },
    { label: "删除", icon: <Trash2 size={13} />, shortcut: "⌫", danger: true, onClick: () => store.deleteSelected() },
  ];
}

/** 画布空白处右键菜单；onPlaceImage 由舞台接隐藏文件选择 */
export function canvasMenu(store: DesignStore, onPlaceImage?: () => void): CtxItem[] {
  return [
    { label: "全选", icon: <Square size={13} />, shortcut: "⌘A", onClick: () => store.setSel(store.page.nodes.map((n) => n.id)) },
    { label: "粘贴", icon: <Copy size={13} />, shortcut: "⌘V", onClick: () => store.pasteClipboard() },
    ...(onPlaceImage
      ? [
          {
            label: "置入图片…",
            icon: <ImagePlus size={13} />,
            onClick: () => onPlaceImage(),
          },
        ]
      : []),
    { sep: true },
    { label: "适配画布", icon: <Maximize2 size={13} />, shortcut: "⌘0", onClick: () => store.fitView() },
    { label: "缩放至 100%", shortcut: "⌘1", onClick: () => store.zoomTo(1) },
  ];
}
