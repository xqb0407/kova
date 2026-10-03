"use client";

import { useEffect, useState, type FC, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Loader2Icon, PlayIcon, TargetIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useSessionMode } from "@/lib/pi/pi-session-mode";
import {
  GOAL_TURN_DRAFT_MAX,
  setGoalTurnDraft,
  useGoalTurnDraft,
} from "@/lib/pi/pi-goal-limit-draft";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  clearGoalNow,
  fetchGoalState,
  resumeGoalNow,
  setGoalLimitNow,
  useGoalState,
  type GoalSnapshot,
} from "@/lib/pi/pi-goal";

/**
 * 目标模式常驻条（composer 正上方）。
 *
 * 为什么是「常驻」而不是弹出：goal 模式的两道停机阀（轮次上限、无进展）会让自治
 * 循环**静默停下**。用户离开十分钟回来，如果它们只在一条转瞬即逝的 toast 里出现过，
 * 他看到的就只是「模型突然不干活了」——看不出是自己设的上限到点了，还是模型卡住了。
 * 条必须一直在，停下来时一直显示停在哪一档。
 *
 * 另有一态是「goal 档但还没有目标」：此时条显示建目标提示。这是目标模式唯一的
 * 建目标入口——用户在 goal 档发的第一句话就是目标（sidecar syncGoalOnUserPrompt），
 * 所以这一行文字不是装饰性引导，是功能说明。
 */

/**
 * 条的外壳：满宽（与输入框、与兄弟条同宽，别再 mx-* 缩一圈）、下间距 8px
 * （与队列条/审批卡同值）、必须有不透明底 + 背景模糊，不能只描边。
 * 它就贴在消息列表的末尾上方，透明的话滚动的消息会直接穿过条里的文字——
 * 冷不丁一长串代码从「进行中 · 第 3/300 轮」底下穿过去。底色用 --composer-bg
 * 那层半透明色（与输入框同一个变量）再叠一层模糊，滚动内容会被糊掉而不是透出来。
 */
const STRIP_SHELL =
  "bg-(--composer-bg) border-border/60 mb-2 backdrop-blur-md backdrop-saturate-110";

const STATUS_LABEL: Record<GoalSnapshot["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  complete: "已完成",
};

/** 停止态用警告色，进行中用主色，已完成转灰——一眼分出「还在跑」还是「停了」 */
const STATUS_CLASS: Record<GoalSnapshot["status"], string> = {
  active: "text-emerald-600 dark:text-emerald-400",
  paused: "text-amber-600 dark:text-amber-400",
  blocked: "text-amber-600 dark:text-amber-400",
  complete: "text-muted-foreground",
};

/** 停下来的原因从 pauseReason 翻成人话（sidecar 写的是英文判定句） */
function pauseHint(goal: GoalSnapshot): string | null {
  if (!goal.pauseReason) return null;
  const r = goal.pauseReason;
  if (r.startsWith("automatic turn limit reached")) return "已达到自动轮次上限";
  if (r.startsWith("automatic turn limit lowered"))
    return "上限调到了已跑轮数以下";
  if (r.startsWith("no progress across")) return "连续多轮没有新进展";
  if (r.startsWith("user sent a message")) return "你发了新消息，目标已让位";
  if (r.startsWith("user left goal mode")) return "你切出了目标模式";
  if (r.startsWith("sidecar restarted"))
    return "重启时目标还在跑，已停下等你确认";
  if (r.startsWith("model turn ended")) return "上一轮异常中止";
  return r;
}

/** 是不是因为撞了轮次上限停的（决定「提高上限并继续」这个入口出不出来） */
function stoppedByTurnLimit(goal: GoalSnapshot): boolean {
  const r = goal.pauseReason ?? "";
  return goal.status === "paused" && r.startsWith("automatic turn limit");
}

/**
 * 轮数上限编辑器的**主体**（两个入口共用：建目标前的预设、进行中/暂停后的读数）。
 *
 * 之前只有 Enter 能提交、没有任何可点的确认入口——用户填完 14 就卡在那儿了
 * （触发条上还显示着旧值，看起来像没生效）。现在补上显式的「确定 / 取消」：
 * Enter 等同确定，Escape 或点外面等同取消。两处共用一个主体，免得下次改一处漏一处。
 *
 * @param onCommit 已规整的合法值（null = 不限）；非法输入不回调，弹层保持打开
 */
const TurnLimitEditor: FC<{
  initial: string;
  hint: ReactNode;
  onCommit: (value: number | null) => void;
  onCancel: () => void;
}> = ({ initial, hint, onCommit, onCancel }) => {
  const [text, setText] = useState(initial);
  const parsed = Number.parseInt(text, 10);
  const valid =
    !Number.isNaN(parsed) && parsed >= 0 && parsed <= GOAL_TURN_DRAFT_MAX;

  return (
    <div className="flex flex-col gap-2">
      <InputGroup className="bg-background">
        <InputGroupInput
          autoFocus
          type="number"
          min={0}
          max={GOAL_TURN_DRAFT_MAX}
          className="text-right tabular-nums [&::-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid)
              onCommit(parsed === 0 ? null : parsed);
          }}
        />
        <InputGroupAddon align="inline-end">轮</InputGroupAddon>
      </InputGroup>
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        {hint}
      </p>
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5"
          onClick={() => onCancel()}
        >
          取消
        </Button>
        <Button
          size="sm"
          className="h-7 px-3"
          disabled={!valid}
          onClick={() => onCommit(parsed === 0 ? null : parsed)}
        >
          确定
        </Button>
      </div>
    </div>
  );
};

/**
 * 轮次读数（分母可点）。
 *
 * 上限挂在**这条目标**上而不是全局设置里：该跑多少轮取决于任务本身，「补个 README」
 * 和「把整个鉴权重构完」差两个数量级。所以它的编辑入口就在这里——条上正显示着这个
 * 数，中途发现估少了就地点改，不必翻设置页。
 */
const TurnReadout: FC<{
  goal: GoalSnapshot;
  onCommit: (value: number | null) => void;
  disabled?: boolean;
  /** 因撞轮次上限而停：此时提交等于「提高上限并继续」，会顺手恢复目标 */
  raiseAndResume?: boolean;
}> = ({ goal, onCommit, disabled, raiseAndResume }) => {
  const [open, setOpen] = useState(false);
  const unlimited = goal.maxAutoTurns === null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            title="点这里改这条目标的轮数上限（0 = 不限）"
            className="hover:text-foreground focus-visible:ring-ring shrink-0 rounded tabular-nums transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50"
          >
            {raiseAndResume
              ? "提高上限并继续"
              : unlimited
                ? `第 ${goal.turnCount} 轮`
                : `第 ${goal.turnCount}/${goal.maxAutoTurns} 轮`}
          </button>
        }
      />
      <PopoverContent align="end" className="w-56 p-3">
        <div className="mb-2 text-xs font-medium">这条目标的轮数上限</div>
        {open && (
          <TurnLimitEditor
            initial={unlimited ? "0" : String(goal.maxAutoTurns)}
            hint={
              raiseAndResume
                ? "这条目标已跑满上限停在这儿。改成一个更大的数（或 0 = 不限）后会自动继续。"
                : "撞上上限会暂停，届时可再调大。填 0 表示不限轮次（一直跑到完成或卡住）。"
            }
            onCommit={(value) => {
              setOpen(false);
              onCommit(value);
            }}
            onCancel={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 建目标前的上限预设（0 = 不限）；随第一条消息带给 sidecar */
const TurnLimitDraftPicker: FC<{ threadId: string }> = ({ threadId }) => {
  const draft = useGoalTurnDraft(threadId);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="这条目标的轮数上限（0 = 不限），随你的第一句话生效"
            className="hover:text-foreground focus-visible:ring-ring shrink-0 rounded tabular-nums transition-colors focus-visible:ring-1 focus-visible:outline-none"
          >
            {draft === 0 ? "不限轮次" : `上限 ${draft} 轮`}
          </button>
        }
      />
      <PopoverContent align="end" className="w-60 p-3">
        <div className="mb-2 text-xs font-medium">轮数上限</div>
        {open && (
          <TurnLimitEditor
            initial={String(draft)}
            hint="按任务估：小改动几十轮够，大重构可以几百。填 0 表示不限。"
            onCommit={(value) => {
              setOpen(false);
              setGoalTurnDraft(value === null ? 0 : value, threadId);
            }}
            onCancel={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
};

export const GoalStrip: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const { mode } = useSessionMode(threadId);
  const { goal } = useGoalState(threadId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [busy, setBusy] = useState(false);

  // 挂载/换线程时水合（刷新后本地 store 为空，sidecar 的 goal_state 行才是事实源）
  useEffect(() => {
    if (!threadId) return;
    fetchGoalState(threadId).catch(() => {});
  }, [threadId]);

  // goal 档下即使还没有目标也要挂：这一行提示是目标模式唯一的建目标入口
  if (!threadId || (mode !== "goal" && !goal)) return null;

  const act = (fn: (id: string) => Promise<void>) => {
    setBusy(true);
    fn(threadId)
      .catch((err) => console.error("goal action failed:", err))
      .finally(() => setBusy(false));
  };

  if (!goal) {
    return (
      <div
        data-slot="aui-goal-strip"
        className={cn(
          STRIP_SHELL,
          "flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs",
        )}
      >
        <TargetIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 text-muted-foreground">
          描述你要完成的目标，我跨轮把它做完；撞上轮次上限或原地打转会自己停下。
        </span>
        {/* 目标还没建立时也要能定上限：第一句话即将成为目标，这个数就跟着它定下来 */}
        <span className="text-muted-foreground shrink-0">
          <TurnLimitDraftPicker threadId={threadId} />
        </span>
      </div>
    );
  }

  const hint = pauseHint(goal);
  const running = goal.status === "active";
  // 目标停了但这一轮仍在跑（用户刚发消息接管、队列里还有排队的轮次）：
  // 两个事实同时成立，条上要同时说，否则「已暂停」会被读成「什么都没在跑」
  const turnBusy = isRunning && !running;

  return (
    <div
      data-slot="aui-goal-strip"
      className={cn(
        STRIP_SHELL,
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
      )}
    >
      <TargetIcon
        className={cn(
          "size-3.5 shrink-0",
          running ? STATUS_CLASS.active : STATUS_CLASS[goal.status],
        )}
      />
      <span className="min-w-0 flex-1 truncate" title={goal.objective}>
        {goal.objective}
      </span>
      <span className="text-muted-foreground flex shrink-0 items-center gap-2">
        <span className={cn("shrink-0", STATUS_CLASS[goal.status])}>
          {STATUS_LABEL[goal.status]}
        </span>
        <span className="hidden shrink-0 sm:inline">
          <TurnReadout
            goal={goal}
            disabled={busy}
            raiseAndResume={stoppedByTurnLimit(goal)}
            onCommit={(value) =>
              act(async (id) => {
                await setGoalLimitNow(id, value);
                // 「提高上限并继续」是一件事：改完上限直接恢复，不用再点一次继续
                if (stoppedByTurnLimit(goal)) await resumeGoalNow(id);
              })
            }
          />
        </span>
        <span
          className="text-muted-foreground/70 hidden shrink-0 tabular-nums md:inline"
          title="本目标消耗的 token，含子代理与工具往返（仅供参考，不参与停机判定）"
        >
          {formatTokens(goal.tokensUsed)} token
        </span>
      </span>
      {turnBusy ? (
        <span className="text-muted-foreground/80 hidden shrink-0 md:inline">
          正在处理这条消息
        </span>
      ) : (
        hint &&
        !running && (
          <span className="text-muted-foreground hidden shrink-0 lg:inline">
            {hint}
          </span>
        )
      )}
      {!running && goal.status !== "complete" && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => act(resumeGoalNow)}
          title="继续这个目标（轮次与停滞计数重新起算）"
          className="h-6 shrink-0 px-2"
        >
          {busy ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <PlayIcon className="size-3" />
          )}
          <span className="sr-only">继续</span>
        </Button>
      )}
      {running && (
        // 这里原来是一个 PauseIcon——结果是「进行中」旁边挂着一个暂停符号，
        // 窄窗口下状态文字被 hidden 掉、只剩这个图标，读起来就是「已暂停，
        // 但对话还在跑」。运行中的指示点必须长得像「在跑」：实心圆点 + 呼吸。
        <span title="目标自治循环进行中" className="flex shrink-0 items-center">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => act(clearGoalNow)}
        title="清除目标（不影响已写到工作区的改动）"
        className="h-6 shrink-0 px-2"
      >
        <XIcon className="size-3" />
        <span className="sr-only">清除</span>
      </Button>
    </div>
  );
};
