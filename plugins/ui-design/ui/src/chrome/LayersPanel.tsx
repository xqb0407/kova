/**
 * LayersPanel：左侧图层栏。
 * 顶部页面下拉（切换/新建/重命名/删除）；树 = 当前页节点，前层在上（Figma 顺序），
 * 展开/收起、显隐、锁定、双击重命名、⌘/ 多选、行右键（节点菜单）、更多菜单（复制/排序/成组/删除）。
 */
import { useState, type FC, type MouseEvent } from "react";
import {
  ArrowUpRight,
  Boxes,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Diamond,
  Eye,
  EyeOff,
  Frame,
  Group,
  Hexagon,
  Image as ImageIcon,
  Lock,
  LockOpen,
  Minus,
  MoreHorizontal,
  Pentagon,
  PenTool,
  Plus,
  Shapes,
  Square,
  Star,
  Trash2,
  Triangle,
  Type,
  Ungroup,
} from "lucide-react";
import { instanceView, TYPE_LABELS, type DesignNode, type InstanceNode, type NodeType } from "../doc";
import type { DesignStore } from "../state";
import { ContextMenu, nodeMenu } from "./ContextMenu";
import { VariablesManager } from "./VariablesPanel";
import { StencilPanel } from "./StencilPanel";
import { InlineEdit, Menu, MenuItem } from "./ui";

const TYPE_ICONS: Record<NodeType, FC<{ size?: number }>> = {
  frame: Frame,
  group: Group,
  rect: Square,
  ellipse: Circle,
  triangle: Triangle,
  diamond: Diamond,
  pentagon: Pentagon,
  hexagon: Hexagon,
  star: Star,
  line: Minus,
  arrow: ArrowUpRight,
  text: Type,
  image: ImageIcon,
  icon: Shapes,
  vector: PenTool,
  instance: Boxes,
};

type RowProps = {
  store: DesignStore;
  node: DesignNode;
  depth: number;
  selected: boolean;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  pick: (node: DesignNode) => (e: MouseEvent) => void;
  /** 行右键：未选中先选中该行，再弹节点菜单（与画布右键同一份清单） */
  onRowMenu: (e: MouseEvent, node: DesignNode) => void;
};

const TreeRow: FC<RowProps> = ({ store, node, depth, selected, collapsed, toggle, pick, onRowMenu }) => {
  const [editing, setEditing] = useState(false);
  const [hover, setHover] = useState(false);
  const Icon = TYPE_ICONS[node.type];
  // 实例行的子级 = 解析视图（id 已重编为 "实例id/内部id"，选中/编辑走覆盖写路径）；坏引用无可展开
  const kids: DesignNode[] =
    node.type === "instance" ? instanceView(store.doc, node as InstanceNode) ?? [] : "children" in node ? node.children : [];
  const hasKids = kids.length > 0 && (node.type === "frame" || node.type === "group" || node.type === "instance");
  const expanded = !collapsed.has(node.id);
  const hidden = node.visible === false;
  const flagBtn = (tip: string, icon: FC<{ size?: number }>, on: () => void, lit: boolean) => {
    const I = icon;
    return (
      <button
        type="button"
        title={tip}
        onClick={(e) => {
          e.stopPropagation();
          on();
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]"
        style={{ color: lit ? "var(--foreground)" : "var(--muted-foreground)" }}
      >
        <I size={13} />
      </button>
    );
  };
  return (
    <>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={pick(node)}
        onContextMenu={(e) => {
          e.preventDefault();
          onRowMenu(e, node);
        }}
        className="flex h-7 cursor-default items-center gap-1 rounded-md pr-1"
        style={{
          paddingLeft: 6 + depth * 14,
          background: selected
            ? "color-mix(in srgb, var(--foreground) 8%, transparent)"
            : hover
              ? "color-mix(in srgb, var(--foreground) 4%, transparent)"
              : "transparent",
          opacity: hidden ? 0.45 : 1,
        }}
      >
        {hasKids ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle(node.id);
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]"
            style={{ color: "var(--muted-foreground)" }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="shrink-0" style={{ color: selected ? "var(--foreground)" : "var(--muted-foreground)" }}>
          <Icon size={13} />
        </span>
        {node.mask && (
          <span title="蒙版：裁剪上方图层" className="shrink-0 rounded px-0.5 text-[9px] font-bold leading-[14px]" style={{ background: "var(--secondary)", color: "var(--muted-foreground)" }}>
            M
          </span>
        )}
        {editing ? (
          <span className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
            <InlineEdit
              value={node.name}
              onCommit={(v) => {
                store.renameNode(node.id, v.trim() || TYPE_LABELS[node.type] || "未命名");
                setEditing(false);
              }}
            />
          </span>
        ) : (
          <span
            title={`${TYPE_LABELS[node.type] ?? node.type} · 双击重命名`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="min-w-0 flex-1 truncate text-[12px]"
            style={{ color: "var(--foreground)", fontWeight: selected ? 500 : 400 }}
          >
            {node.name}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-0.5" style={{ visibility: hover || node.locked || hidden ? "visible" : "hidden" }}>
          {flagBtn(hidden ? "显示" : "隐藏", hidden ? EyeOff : Eye, () => store.toggleFlag(node.id, "visible"), hidden)}
          {flagBtn(node.locked ? "解锁" : "锁定", node.locked ? Lock : LockOpen, () => store.toggleFlag(node.id, "locked"), !!node.locked)}
        </span>
        <span style={{ visibility: hover ? "visible" : "hidden" }}>
          <Menu
            align="end"
            trigger={
              <button
                type="button"
                title="更多操作"
                onClick={(e) => e.stopPropagation()}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]"
                style={{ color: "var(--muted-foreground)" }}
              >
                <MoreHorizontal size={13} />
              </button>
            }
          >
            <MenuItem icon={<Copy size={13} />} onClick={() => store.duplicateSelected()}>
              复制
            </MenuItem>
            {hasKids && selHasGroup(store, node) && (
              <MenuItem icon={<Ungroup size={13} />} onClick={() => store.ungroupSelected()}>
                取消成组
              </MenuItem>
            )}
            <MenuItem onClick={() => store.reorderSelected("front")}>置顶</MenuItem>
            <MenuItem onClick={() => store.reorderSelected("up")}>上移一层</MenuItem>
            <MenuItem onClick={() => store.reorderSelected("down")}>下移一层</MenuItem>
            <MenuItem onClick={() => store.reorderSelected("back")}>置底</MenuItem>
            <MenuItem icon={<Trash2 size={13} />} danger onClick={() => store.deleteSelected()}>
              删除
            </MenuItem>
          </Menu>
        </span>
      </div>
      {hasKids &&
        expanded &&
        [...kids].reverse().map((c) => (
          <TreeRow
            key={c.id}
            store={store}
            node={c}
            depth={depth + 1}
            selected={store.selIds.includes(c.id)}
            collapsed={collapsed}
            toggle={toggle}
            pick={pick}
            onRowMenu={onRowMenu}
          />
        ))}
    </>
  );
};

const selHasGroup = (store: DesignStore, node: DesignNode) =>
  store.selIds.includes(node.id) && (node.type === "group" || node.type === "frame");

export const LayersPanel: FC<{ store: DesignStore }> = ({ store }) => {
  const { doc, page, selIds, setSel } = store;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"layers" | "stencils" | "variables">("layers");
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pick = (node: DesignNode) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSel(selIds.includes(node.id) ? selIds.filter((i) => i !== node.id) : [...selIds, node.id]);
    } else if (e.shiftKey) {
      if (!selIds.includes(node.id)) setSel([...selIds, node.id]);
    } else {
      setSel([node.id]);
    }
  };
  /** 行右键菜单（屏幕坐标；条目渲染时按最新 store 现算） */
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const onRowMenu = (e: MouseEvent, node: DesignNode) => {
    if (!selIds.includes(node.id)) setSel([node.id]);
    setCtx({ x: e.clientX, y: e.clientY });
  };
  return (
    <div
      className="pointer-events-auto flex h-full w-full flex-col"
      style={{ borderColor: "var(--border)", background: "var(--background)" }}
    >
      <div className="flex h-11 shrink-0 items-center px-2">
        <Menu
          trigger={
            <button
              type="button"
              className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]"
              style={{ color: "var(--foreground)" }}
            >
              <span className="truncate">{page.name}</span>
              <ChevronDown size={12} style={{ color: "var(--muted-foreground)" }} />
            </button>
          }
        >
          {doc.pages.map((p) => (
            <MenuItem key={p.id} selected={p.id === doc.activePage} onClick={() => store.switchPage(p.id)}>
              {p.name}
            </MenuItem>
          ))}
          <MenuItem icon={<Plus size={13} />} onClick={() => store.addPage()}>
            新建页面
          </MenuItem>
          <MenuItem
            onClick={() => {
              const name = window.prompt("页面名称", page.name);
              if (name) store.renamePage(page.id, name);
            }}
          >
            重命名当前页
          </MenuItem>
          {doc.pages.length > 1 && (
            <MenuItem
              icon={<Trash2 size={13} />}
              danger
              onClick={() => store.deletePage(page.id)}
            >
              删除当前页
            </MenuItem>
          )}
        </Menu>
      </div>
      <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-1">
        <div className="flex items-center gap-2.5">
          {([["layers", "图层"], ["stencils", "素材"], ["variables", "变量"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className="text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors"
              style={{ color: tab === key ? "var(--foreground)" : "var(--muted-foreground)" }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "variables" ? (
        <VariablesManager store={store} />
      ) : tab === "stencils" ? (
        <StencilPanel store={store} />
      ) : (
      <div className="px-1.5 pb-1 pt-0 text-[10px]" style={{ color: "var(--muted-foreground)" }} />
      )}
      {tab === "layers" ? (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {[...page.nodes].reverse().map((n) => (
          <TreeRow
            key={n.id}
            store={store}
            node={n}
            depth={0}
            selected={selIds.includes(n.id)}
            collapsed={collapsed}
            toggle={toggle}
            pick={pick}
            onRowMenu={onRowMenu}
          />
        ))}
        {page.nodes.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            当前页还没有元素，用底部工具栏画一个吧
          </div>
        )}
      </div>
      ) : null}
      {selIds.length > 1 && (
        <div className="flex h-11 shrink-0 items-center gap-2 px-3" style={{ boxShadow: "inset 0 1px 0 var(--border)" }}>
          <button
            type="button"
            onClick={() => store.groupSelected()}
            className="h-7 rounded-full px-3 text-[11px] font-medium transition-transform hover:-translate-y-px"
            style={{ background: "var(--accent)", color: "var(--accent-foreground)", boxShadow: "var(--sh-elev)" }}
          >
            成组（⌘G）
          </button>
          <span className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            已选 {selIds.length} 项
          </span>
        </div>
      )}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={nodeMenu(store, store.selIds)} onClose={() => setCtx(null)} />}
    </div>
  );
};
