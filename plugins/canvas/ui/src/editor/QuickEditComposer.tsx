/**
 * QuickEdit 底部浮窗（参考 codex-canvas 的 quick-edit-composer）：单选一个元素时，
 * 在底部浮出「对选中元素说要求」输入条 —— 可直接打字要求，也可先开标注模式
 * （画箭头/画笔/文字指向目标），提交时把要求 + 标注批次归一化给 agent。
 *   - 仅单选（selectedEl 非空）时显示；无标注且没打字 → 提示不提交；
 *   - 提交后复位标注会话（turnOffAnnotate），浮窗输入自清；
 *   - 底部用 flex-wrap 整行（缩放簇同排，过窄自动换行居中，不互撞）。
 */
import { useMemo, useState, type FC } from "react";
import { MessageSquarePlusIcon, SendIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import type { CanvasStore } from "@/state";
import type { El } from "@/doc";

export const QuickEditComposer: FC<{
  store: CanvasStore;
  selectedEl: El;
  /** 标注模式（与左工具条「标注」同一开关） */
  annotate: boolean;
  onAnnotate: () => void;
  onSubmit: (req: string) => void;
}> = ({ store, selectedEl, annotate, onAnnotate, onSubmit }) => {
  const [text, setText] = useState("");

  const markCount = useMemo(
    () => store.doc.objects.filter((e) => e.annotate?.targetId === selectedEl.id && e.id !== selectedEl.id).length,
    [store.doc.objects, selectedEl.id],
  );

  const canSubmit = text.trim().length > 0 || markCount > 0;

  const submit = () => {
    if (!canSubmit) {
      store.notifyLater("先填一句要求，或先给目标画几笔标注");
      return;
    }
    onSubmit(text);
    setText("");
  };

  return (
    <div className="sc-float pointer-events-auto mx-auto flex min-w-[300px] max-w-[min(560px,calc(100vw-360px))] flex-1 flex-col gap-1 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <SparklesIcon className="text-ink size-4 shrink-0 opacity-70" />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation(); // 外层全局快捷键（Enter/Delete 等）不抢
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="对选中的元素说要求（可先画几笔标注，再提交）"
          className="h-9 min-w-0 flex-1 border-transparent bg-transparent text-xs shadow-none focus-visible:border-border focus-visible:ring-0"
          aria-label="对选中元素说要求"
        />
        <Hint label={annotate ? "标注模式已开：画的箭头/画笔/文字会指向该元素（Esc 退出）" : "标注模式：先开，再画箭头/画笔/文字指向想改的位置"}>
          <Button variant={annotate ? "default" : "ghost"} size="icon-sm" className="sc-tool" aria-pressed={annotate} aria-label="标注" onClick={onAnnotate}>
            <MessageSquarePlusIcon className="size-4" />
          </Button>
        </Hint>
        <Button size="sm" className="h-9 shrink-0" disabled={!canSubmit} onClick={submit}>
          <SendIcon className="size-3.5" /> 提交
        </Button>
      </div>
      {markCount > 0 && (
        <p className="text-muted-foreground text-xs leading-none">
          已画 {markCount} 处标注指向该元素，会随要求一起发给 AI
        </p>
      )}
    </div>
  );
};
