/**
 * 画布右键菜单（自 App.tsx 拆出）：元素 / 页框 / 空白三处命中合一；Z_ITEMS 图层条目表供 Inspector 复用。
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
  MaximizeIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  TypeIcon,
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
import type { DeckStore } from "@/state";
import type { SelKind } from "./newEl";

/* ---------------- 画布右键菜单（四处命中合一） ---------------- */

export const Z_ITEMS: { mode: "front" | "back" | "forward" | "backward"; label: string; shortcut?: string }[] = [
  { mode: "front", label: "置于顶层", shortcut: "⇧⌘]" },
  { mode: "forward", label: "上移一层", shortcut: "⌘]" },
  { mode: "backward", label: "下移一层", shortcut: "⌘[" },
  { mode: "back", label: "置于底层", shortcut: "⇧⌘[" },
];

export const CanvasContextMenu: FC<{
  store: DeckStore;
  hit: ContextHit | null;
  insert: (kind: SelKind) => void;
  askAI: () => void;
  zoomApi: { current: ZoomApi | null };
  /** deck 才有页框概念：artboard 命中与插页/删页条目只在幻灯片模式出现 */
  deck: boolean;
}> = ({ store, hit, insert, askAI, zoomApi, deck }) => {
  const hasSel = !!store.sel && store.sel.elIds.length > 0;
  const hasGroup = store.selectedEls().some((e) => e.groupId);
  const frame = hit && hit.kind !== "canvas" ? store.doc.frames.find((f) => f.id === hit.containerId) : undefined;
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
          <ContextMenuItem className="text-ink" onSelect={askAI}>
            <SparklesIcon className="size-3.5" /> 问 AI 修改此元素
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => store.deleteSelected()}>
            <Trash2Icon className="size-3.5" /> 删除 <span className="ml-auto opacity-60">Del</span>
          </ContextMenuItem>
        </>
      )}
      {hit?.kind === "artboard" && frame && deck && (
        <>
          <ContextMenuLabel>幻灯片 · 第 {store.doc.frames.findIndex((f) => f.id === frame.id) + 1} 页</ContextMenuLabel>
          <ContextMenuItem onSelect={() => insert("text")}>
            <TypeIcon className="size-3.5" /> 添加文本
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => insert("rect")}>
            <SquareIcon className="size-3.5" /> 添加矩形
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => store.duplicateFrame(frame.id)}>
            <CopyIcon className="size-3.5" /> 复制页
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => store.removeFrame(frame.id)}>
            <Trash2Icon className="size-3.5" /> 删除页
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => zoomApi.current?.focusFrame(frame.id)}>
            <FrameIcon className="size-3.5" /> 缩放至此页
          </ContextMenuItem>
        </>
      )}
      {(!hit || hit.kind === "canvas") && (
        <>
          <ContextMenuItem onSelect={() => store.pasteClipboard()}>
            <ClipboardPasteIcon className="size-3.5" /> 粘贴 <span className="ml-auto opacity-60">⌘V</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => store.selectAllInContainer()}>
            {deck ? "全选当前页" : "全选白板元素"} <span className="ml-auto opacity-60">⌘A</span>
          </ContextMenuItem>
          {deck && (
            <ContextMenuItem onSelect={() => store.addFrame()}>
              <PlusIcon className="size-3.5" /> 插入幻灯片页
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => zoomApi.current?.fitAll()}>
            <MaximizeIcon className="size-3.5" /> {deck ? "适配当前页" : "适配全部元素"} <span className="ml-auto opacity-60">⌘0</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => zoomApi.current?.zoom100()}>
            <FrameIcon className="size-3.5" /> 缩放 100% <span className="ml-auto opacity-60">⌘1</span>
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
};
