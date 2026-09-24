/**
 * 选中浮动工具条（自 App.tsx 拆出）：对齐/分布/图层/复制/删除。
 */
import { type FC } from "react";
import {
  AlignCenterIcon,
  AlignCenterVerticalIcon,
  AlignEndVerticalIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignStartVerticalIcon,
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  CopyIcon,
  GroupIcon,
  MoveHorizontalIcon,
  MoveVerticalIcon,
  Trash2Icon,
  UngroupIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import type { DeckStore } from "@/state";

/* ---------------- 选中浮动工具条 ---------------- */

export const SelectionBar: FC<{ store: DeckStore; multi: boolean }> = ({ store, multi }) => {
  // 无限画布（board）不提供对齐组：画布无参照边，对齐语义不成立；
  // 幻灯片（deck）六向齐全。分布只在多选出现，两模式都可用。
  const board = store.surface === "board";
  const hasGroup = store.selectedEls().some((e) => e.groupId);
  return (
  <div className="glass glass-sm flex items-center gap-1 px-1.5 py-1 shadow-lg">
    {!board && (
      <>
        <Hint label="左对齐" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.alignSelected("left")} aria-label="左对齐">
            <AlignLeftIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="水平居中" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.alignSelected("hcenter")} aria-label="水平居中">
            <AlignCenterIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="右对齐" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.alignSelected("right")} aria-label="右对齐">
            <AlignRightIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="顶对齐" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.alignSelected("top")} aria-label="顶对齐">
            <AlignStartVerticalIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="垂直居中" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.alignSelected("vcenter")} aria-label="垂直居中">
            <AlignCenterVerticalIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="底对齐" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.alignSelected("bottom")} aria-label="底对齐">
            <AlignEndVerticalIcon className="size-3.5" />
          </Button>
        </Hint>
        <Separator orientation="vertical" className="mx-0.5 !h-4" />
      </>
    )}
    {multi && (
      <>
        <Separator orientation="vertical" className="mx-0.5 !h-4" />
        <Hint label="水平等间隙分布（≥3 个）" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.distributeSelected("h")} aria-label="水平分布">
            <MoveHorizontalIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="垂直等间隙分布（≥3 个）" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.distributeSelected("v")} aria-label="垂直分布">
            <MoveVerticalIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="组合 ⌘G" side="top">
          <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.groupSelected()} aria-label="组合">
            <GroupIcon className="size-3.5" />
          </Button>
        </Hint>
      </>
    )}
    {hasGroup && (
      <Hint label="解组 ⇧⌘G" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.ungroupSelected()} aria-label="解组">
          <UngroupIcon className="size-3.5" />
        </Button>
      </Hint>
    )}
    <Hint label="置于顶层 ⇧⌘]" side="top">
      <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.moveSelectedZ("front")} aria-label="置于顶层">
        <ArrowUpToLineIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="置于底层 ⇧⌘[" side="top">
      <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.moveSelectedZ("back")} aria-label="置于底层">
        <ArrowDownToLineIcon className="size-3.5" />
      </Button>
    </Hint>
    <Separator orientation="vertical" className="mx-0.5 !h-4" />
    <Hint label="复制 ⌘D" side="top">
      <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.duplicateSelected()} aria-label="复制">
        <CopyIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="删除 Del" side="top">
      <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.deleteSelected()} aria-label="删除">
        <Trash2Icon className="size-3.5" />
      </Button>
    </Hint>
  </div>
  );
};
