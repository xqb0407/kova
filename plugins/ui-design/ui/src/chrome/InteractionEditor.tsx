/**
 * 原型交互编辑器（Inspector 的「原型」区）。
 *
 * 一行 = 一条交互：触发方式 / 动作 / 目标 / 转场（+ 浮层停靠位）。
 * 目标下拉按动作切换数据集——跳转与浮层只能选**顶层画板**，滚动到/显隐只能选
 * **本屏内节点**；这样用户不可能在下拉里选出一个死链。
 * 存储只写作者显式设置的字段，缺省转场留给渲染期（prototype.ts）推导，
 * 所以下拉里的「自动」= 不落字段。
 */
import { type FC } from "react";
import { Plus, Play, Trash2 } from "lucide-react";
import {
  INTERACTION_ACTIONS,
  INTERACTION_TRIGGERS,
  OVERLAY_POSITIONS,
  PROTOTYPE_TRANSITIONS,
  allFrames,
  nodeInteractions,
  type DesignNode,
  type Interaction,
  type InteractionAction,
  type InteractionTrigger,
  type OverlayPosition,
  type PrototypeTransition,
} from "../doc";
import { ACTION_LABELS, POSITION_LABELS, TRANSITION_LABELS, TRIGGER_LABELS, topLevelFrameOf } from "../prototype";
import type { DesignStore } from "../state";
import { IconBtn, MiniSelect, Section } from "./ui";

type Member = { id: string; name: string; depth: number };

/** 本屏内可作目标的节点（含嵌套，深度封顶 4 层；跳过画板自身与不可见支） */
function membersOf(frame: ReturnType<typeof topLevelFrameOf>): Member[] {
  if (!frame) return [];
  const out: Member[] = [];
  const walk = (list: DesignNode[], depth: number) => {
    if (depth > 4) return;
    for (const n of list) {
      if (n.visible === false) continue;
      out.push({ id: n.id, name: n.name, depth });
      if ("children" in n) walk(n.children, depth + 1);
    }
  };
  walk(frame.children, 0);
  return out.slice(0, 200);
}

const NEEDS_SCREEN: InteractionAction[] = ["navigate", "overlay"];
const NEEDS_NODE: InteractionAction[] = ["scrollTo", "toggleVisible"];

export const InteractionEditor: FC<{ store: DesignStore; node: DesignNode; onPreview?: () => void }> = ({
  store,
  node,
  onPreview,
}) => {
  const { doc, updateNode } = store;
  const list = nodeInteractions(node);
  const frame = topLevelFrameOf(doc, node.id);
  const members = NEEDS_NODE.some((a) => list.some((it) => it.action === a)) || true ? membersOf(frame) : [];

  /** 写回交互表；空表则连旧式 onTap 一起清掉（两条路径并存会让"到底跳哪儿"有歧义） */
  const write = (next: Interaction[]) =>
    updateNode(node.id, (m) => {
      const c = { ...m } as DesignNode & { interactions?: Interaction[]; onTap?: unknown };
      if (next.length) c.interactions = next;
      else {
        delete c.interactions;
        delete c.onTap;
      }
      return c;
    });

  const patchOne = (i: number, patch: Partial<Interaction>) =>
    write(list.map((it, k) => (k === i ? ({ ...it, ...patch } as Interaction) : it)));

  const setAction = (i: number, action: InteractionAction) => {
    // 换动作后旧目标多半不再适用（画板 id / 节点 id 语义不同）：清掉让用户重选
    const keepTarget = NEEDS_SCREEN.includes(action) === NEEDS_SCREEN.includes(list[i]!.action) && !!list[i]!.to;
    const next: Interaction = { trigger: list[i]!.trigger, action };
    if (!keepTarget) return write(list.map((it, k) => (k === i ? next : it)));
    if (list[i]!.to) next.to = list[i]!.to;
    if (action === "overlay" && list[i]!.position) next.position = list[i]!.position;
    if (list[i]!.transition) next.transition = list[i]!.transition;
    return write(list.map((it, k) => (k === i ? next : it)));
  };

  const screenOptions = [
    { value: "", label: "选择目标画板…" },
    ...allFrames(doc).map(({ pageId, frame: f }) => ({
      value: f.id,
      label: `${doc.pages.find((p) => p.id === pageId)?.name ?? "?"} / ${f.name}`,
    })),
  ];
  const memberOptions = [
    { value: "", label: "选择本屏内节点…" },
    ...members.map((m) => ({ value: m.id, label: `${"\u00a0\u00a0".repeat(m.depth)}${m.name}` })),
  ];
  const transitionOptions = [
    { value: "", label: "自动" },
    ...PROTOTYPE_TRANSITIONS.map((t) => ({ value: t, label: TRANSITION_LABELS[t] })),
  ];
  const positionOptions = OVERLAY_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] }));

  return (
    <Section
      title="原型"
      right={
        <button
          type="button"
          title="添加一条交互"
          onClick={() => write([...list, { trigger: "tap", action: "navigate" }])}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors hover:bg-[var(--secondary)]"
          style={{ color: "var(--muted-foreground)" }}
        >
          <Plus size={11} /> 添加
        </button>
      }
    >
      <div className="space-y-2">
        {list.length === 0 && (
          <div className="text-[11px] leading-5" style={{ color: "var(--muted-foreground)" }}>
            还没有交互。加一条「单击 → 跳转画板」就能把它接进流程；浮层做法：另做一块画板，用
            <span style={{ color: "var(--foreground)" }}> 打开浮层 </span>+ 停靠位。
          </div>
        )}

        {list.map((it, i) => {
          const needsScreen = NEEDS_SCREEN.includes(it.action);
          const needsNode = NEEDS_NODE.includes(it.action);
          const broken =
            (needsScreen || needsNode) &&
            (!it.to || (needsScreen ? !allFrames(doc).some((f) => f.frame.id === it.to) : !members.some((m) => m.id === it.to)));
          return (
            <div key={i} className="rounded-lg p-1.5" style={{ background: "var(--secondary)" }}>
              <div className="flex items-center gap-1">
                <MiniSelect
                  value={it.trigger}
                  options={INTERACTION_TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABELS[t] }))}
                  onChange={(v) => patchOne(i, { trigger: v as InteractionTrigger })}
                  title="触发方式"
                />
                <MiniSelect
                  value={it.action}
                  options={INTERACTION_ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] }))}
                  onChange={(v) => setAction(i, v as InteractionAction)}
                  title="动作"
                />
                <IconBtn tip="删除这条交互" size={22} onClick={() => write(list.filter((_, k) => k !== i))}>
                  <Trash2 size={12} />
                </IconBtn>
              </div>

              {(needsScreen || needsNode) && (
                <div className="mt-1">
                  <MiniSelect
                    value={it.to ?? ""}
                    options={needsScreen ? screenOptions : memberOptions}
                    onChange={(v) => patchOne(i, { to: v || undefined })}
                    title={needsScreen ? "目标画板（跳转/浮层都指向一块顶层画板）" : "本屏内节点"}
                  />
                  {broken && (
                    <div className="mt-1 text-[10px]" style={{ color: "var(--destructive)" }}>
                      {it.to ? "目标已删除或类型不符，预览里点了不会有反应" : "还没选目标"}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-1 flex items-center gap-1">
                <MiniSelect
                  value={it.transition ?? ""}
                  options={transitionOptions}
                  onChange={(v) => patchOne(i, { transition: (v || undefined) as PrototypeTransition | undefined })}
                  title="转场动画（自动 = 按动作与停靠位推导）"
                />
                {it.action === "overlay" && (
                  <MiniSelect
                    value={it.position ?? "center"}
                    options={positionOptions}
                    onChange={(v) => patchOne(i, { position: v as OverlayPosition })}
                    title="浮层停靠位"
                  />
                )}
              </div>
            </div>
          );
        })}

        {onPreview && (
          <button
            type="button"
            onClick={onPreview}
            className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-all hover:brightness-95"
            style={{ background: "var(--secondary)", color: "var(--foreground)" }}
          >
            <Play size={12} /> 预览原型（P）
          </button>
        )}
      </div>
    </Section>
  );
};
