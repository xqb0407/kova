/**
 * 多选属性区（自 Inspector 拆出）：对齐（相对组框）/ 分布 / 图层 / 复制删除。
 * LayerSection 单独导出：单选属性区复用同一套图层/成组操作（元素顶部不再有浮动工具条）。
 */
import { type FC } from "react";
import {
  AlignCenterIcon,
  AlignCenterVerticalIcon,
  AlignEndVerticalIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignStartVerticalIcon,
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
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
import type { DeckStore } from "@/state";
import { Z_ITEMS } from "../CanvasContextMenu";
import { GroupCard, SectionTitle } from "../fields";

/** 图层/成组操作区：层序四键（顶/上移/下移/底）＋组合（多选）/解组（选区含组） */
export const LayerSection: FC<{ store: DeckStore; canGroup?: boolean }> = ({ store, canGroup }) => {
  const hasGroup = store.selectedEls().some((e) => e.groupId);
  return (
    <>
      <SectionTitle>图层</SectionTitle>
      <GroupCard>
        <div className="flex gap-1">
          {Z_ITEMS.map((z) => (
            <Hint key={z.mode} label={`${z.label}${z.shortcut ? `（${z.shortcut}）` : ""}`}>
              <Button variant="ghost" size="icon-sm" onClick={() => store.moveSelectedZ(z.mode)} aria-label={z.label}>
                {z.mode === "front" ? <ArrowUpToLineIcon className="size-3.5" /> : z.mode === "back" ? <ArrowDownToLineIcon className="size-3.5" /> : z.mode === "forward" ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />}
              </Button>
            </Hint>
          ))}
          {canGroup && (
            <Hint label="组合（⌘G）">
              <Button variant="ghost" size="icon-sm" onClick={() => store.groupSelected()} aria-label="组合">
                <GroupIcon className="size-3.5" />
              </Button>
            </Hint>
          )}
          {hasGroup && (
            <Hint label="解组（⇧⌘G）">
              <Button variant="ghost" size="icon-sm" onClick={() => store.ungroupSelected()} aria-label="解组">
                <UngroupIcon className="size-3.5" />
              </Button>
            </Hint>
          )}
        </div>
      </GroupCard>
    </>
  );
};

export const MultiSection: FC<{ store: DeckStore; count: number }> = ({ store, count }) => {
  // 无限画布不提供对齐组：画布无参照边，对齐语义不成立（原浮动工具条同规则）
  const board = store.surface === "board";
  return (
    <>
      <div className="pt-2.5 text-base font-semibold">已选 {count} 个元素</div>
      <p className="text-muted-foreground mt-0.5 text-[10.5px]">拖动组框手柄可整体等比缩放。</p>
      {!board && (
        <>
          <SectionTitle>对齐（相对组框）</SectionTitle>
          <GroupCard>
            <div className="grid grid-cols-6 gap-1">
              {(
                [
                  ["left", AlignLeftIcon, "左对齐"],
                  ["hcenter", AlignCenterIcon, "水平居中"],
                  ["right", AlignRightIcon, "右对齐"],
                  ["top", AlignStartVerticalIcon, "顶对齐"],
                  ["vcenter", AlignCenterVerticalIcon, "垂直居中"],
                  ["bottom", AlignEndVerticalIcon, "底对齐"],
                ] as const
              ).map(([mode, Icon, label]) => (
                <Hint key={mode} label={label}>
                  <Button variant="ghost" size="icon-sm" onClick={() => store.alignSelected(mode)} aria-label={label}>
                    <Icon className="size-3.5" />
                  </Button>
                </Hint>
              ))}
            </div>
          </GroupCard>
        </>
      )}
      <SectionTitle>分布</SectionTitle>
      <GroupCard>
        <div className="flex gap-1">
          <Hint label="水平等间隙分布（≥3）">
            <Button variant="ghost" size="icon-sm" onClick={() => store.distributeSelected("h")} aria-label="水平分布">
              <MoveHorizontalIcon className="size-3.5" />
            </Button>
          </Hint>
          <Hint label="垂直等间隙分布（≥3）">
            <Button variant="ghost" size="icon-sm" onClick={() => store.distributeSelected("v")} aria-label="垂直分布">
              <MoveVerticalIcon className="size-3.5" />
            </Button>
          </Hint>
        </div>
      </GroupCard>
      <LayerSection store={store} canGroup />
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <Button variant="secondary" className="h-9" onClick={() => store.duplicateSelected()}>
          <CopyIcon className="size-3.5" /> 复制
        </Button>
        <Button variant="secondary" className="h-9" onClick={() => store.deleteSelected()}>
          <Trash2Icon className="size-3.5" /> 删除
        </Button>
      </div>
    </>
  );
};
