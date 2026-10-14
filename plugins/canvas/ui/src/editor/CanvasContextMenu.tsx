/**
 * 画布右键菜单（自 App.tsx 拆出）：元素 / 空白两处命中合一；Z_ITEMS 图层条目表供 Inspector 复用。
 */
import { type FC } from "react";
import {
  ArrowUpIcon,
  ClipboardCopyIcon,
  ClipboardPasteIcon,
  ClipboardXIcon,
  CopyIcon,
  FrameIcon,
  GroupIcon,
  LockIcon,
  LockOpenIcon,
  MaximizeIcon,
  SparklesIcon,
  Trash2Icon,
  UngroupIcon,
} from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import type { ContextHit, ZoomApi } from "@/CanvasStage";
import type { CanvasStore } from "@/state";
import type { SelKind } from "./newEl";

/* ---------------- 画布右键菜单（两处命中合一） ---------------- */

export const Z_ITEMS: { mode: "front" | "back" | "forward" | "backward"; label: string; shortcut?: string }[] = [
  { mode: "front", label: "置于顶层", shortcut: "⇧⌘]" },
  { mode: "forward", label: "上移一层", shortcut: "⌘]" },
  { mode: "backward", label: "下移一层", shortcut: "⌘[" },
  { mode: "back", label: "置于底层", shortcut: "⇧⌘[" },
];

export const CanvasContextMenu: FC<{
  store: CanvasStore;
  hit: ContextHit | null;
  insert: (kind: SelKind) => void;
  askAI: () => void;
  zoomApi: { current: ZoomApi | null };
}> = ({ store, hit, insert, askAI, zoomApi }) => {
  const hasSel = !!store.sel && store.sel.elIds.length > 0;
  const hasGroup = store.selectedEls().some((e) => e.groupId);
  return (
    <ContextMenuContent className="w-52">
      {hit?.kind === "element" && (
        <>
          <ContextMenuLabel>元素</ContextMenuLabel>
          <ContextMenuItem disabled={!hasSel} onSelect={() => store.copySelected()}>
            <ClipboardCopyIcon className="size-3.5" /> 复制 <span className="ml-auto opacity-60">⌘C</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasSel} onSelect={() => store.cutSelected()}>
            <ClipboardXIcon className="size-3.5" /> 剪切 <span className="ml-auto opacity-60">⌘X</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => store.pasteClipboard()}>
            <ClipboardPasteIcon className="size-3.5" /> 粘贴 <span className="ml-auto opacity-60">⌘V</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => store.duplicateSelected()}>
            <CopyIcon className="size-3.5" /> 重制 <span className="ml-auto opacity-60">⌘D</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={store.sel ? store.sel.elIds.length < 2 : true} onSelect={() => store.groupSelected()}>
            <GroupIcon className="size-3.5" /> 组合 <span className="ml-auto opacity-60">⌘G</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasGroup} onSelect={() => store.ungroupSelected()}>
            <UngroupIcon className="size-3.5" /> 解组 <span className="ml-auto opacity-60">⇧⌘G</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <ArrowUpIcon className="size-3.5" /> 图层
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              {Z_ITEMS.map((z) => (
                <ContextMenuItem key={z.mode} onSelect={() => store.moveSelectedZ(z.mode)}>
                  {z.label} <span className="ml-auto opacity-60">{z.shortcut}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          {hit.el.locked ? (
            <ContextMenuItem onSelect={() => store.updateEl(hit.containerId, hit.el.id, { locked: undefined } as Partial<import("@/doc").El>)}>
              <LockOpenIcon className="size-3.5" /> 解锁 <span className="ml-auto opacity-60">可自由编辑</span>
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => store.updateEl(hit.containerId, hit.el.id, { locked: true } as Partial<import("@/doc").El>)}>
              <LockIcon className="size-3.5" /> 锁定 <span className="ml-auto opacity-60">防误拖误删</span>
            </ContextMenuItem>
          )}
          <ContextMenuItem className="text-ink" onSelect={askAI}>
            <SparklesIcon className="size-3.5" /> 问 AI 修改此元素
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => store.deleteSelected()}>
            <Trash2Icon className="size-3.5" /> 删除 <span className="ml-auto opacity-60">Del</span>
          </ContextMenuItem>
        </>
      )}
      {(!hit || hit.kind === "canvas") && (
        <>
          <ContextMenuItem onSelect={() => store.pasteClipboard()}>
            <ClipboardPasteIcon className="size-3.5" /> 粘贴 <span className="ml-auto opacity-60">⌘V</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => store.selectAllInContainer()}>
            全选画布元素 <span className="ml-auto opacity-60">⌘A</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => zoomApi.current?.fitAll()}>
            <MaximizeIcon className="size-3.5" /> 适配全部元素 <span className="ml-auto opacity-60">⌘0</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => zoomApi.current?.zoom100()}>
            <FrameIcon className="size-3.5" /> 缩放 100% <span className="ml-auto opacity-60">⌘1</span>
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
};
