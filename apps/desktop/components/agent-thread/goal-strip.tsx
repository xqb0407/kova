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
  confirmGoalCriteriaNow,
  fetchGoalState,
  isGoalAwaitingConfirmation,
  isGoalNegotiating,
  rejectGoalCriteriaNow,
  resumeGoalNow,
  setGoalLimitNow,
  setGoalObjectiveNow,
  skipGoalCriteriaNow,
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
  if (r.startsWith("no acceptance criteria proposed"))
    return "连续几轮都没提出验收标准，已停下等你";
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

/**
 * 条上显示的状态：不能只读 goal.status。
 *
 * 「待确认验收标准」时 goal.status 仍是 active（循环没跑，只是停着等人），
 * 按 status 渲染会把「等你确认」写成「进行中」——条上说在跑、实际什么都没跑，
 * 正是这条最该避免的一类谎报。
 */
function displayState(goal: GoalSnapshot): {
  label: string;
  className: string;
  /** 显示运行中的呼吸点（协商轮也算在跑：那一轮确实在勘察与提议） */
  live: boolean;
  /** 显示「继续」按钮 */
  resumable: boolean;
} {
  if (isGoalAwaitingConfirmation(goal)) {
    return {
      label: "待确认标准",
      className: "text-amber-600 dark:text-amber-400",
      live: false,
      resumable: false,
    };
  }
  if (isGoalNegotiating(goal) && goal.status === "active") {
    return {
      label: "拟定标准中",
      className: STATUS_CLASS.active,
      live: true,
      resumable: false,
    };
  }
  return {
    label: STATUS_LABEL[goal.status],
    className: STATUS_CLASS[goal.status],
    live: goal.status === "active",
    resumable: goal.status !== "complete",
  };
}

/** 确认卡片上的权限档（与 sidecar 的 ApprovalLevel 同值） */
const APPROVAL_LEVELS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: "ask", label: "每次确认", hint: "每条 write/edit/bash 都问一次（最保守）" },
  { value: "workspace-write", label: "工作区免确认", hint: "工作区内的写入免问，bash 仍问" },
  { value: "auto-edit", label: "编辑免确认", hint: "改文件免问，bash 仍问" },
  { value: "auto", label: "完全访问", hint: "全程不问（适合放手跑完的目标）" },
];

/**
 * 目标原文编辑器（点条上的目标文字打开）。
 *
 * 为什么需要一个显式入口：协商阶段用户直接在对话里发一句「算了，改成做 Y 吧」，
 * 系统按「补充需求」处理——验收标准会照新意图提，但条上的目标原文仍是第一句话，
 * 两边对不上。靠自然语言猜「这是在补需求还是换目标」不可靠，不如给个动作。
 *
 * 改原文会让已提/已确认的标准作废重谈（sidecar 侧的规则），所以这里要说清楚，
 * 否则用户会以为只是改个措辞、标准还在。
 */
const ObjectiveEditor: FC<{
  initial: string;
  /** 当前阶段的契约会不会被这次改动作废（决定提示文案） */
  willVoidCriteria: boolean;
  onCommit: (objective: string) => void;
  onCancel: () => void;
}> = ({ initial, willVoidCriteria, onCommit, onCancel }) => {
  const [text, setText] = useState(initial);
  const trimmed = text.trim();
  const valid = trimmed.length > 0 && trimmed !== initial.trim();

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium">这条目标要做的事</div>
      <textarea
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && valid) onCommit(trimmed);
          if (e.key === "Escape") onCancel();
        }}
        className="border-border/60 bg-background w-full resize-none rounded border p-2 text-[11px] leading-relaxed outline-none"
      />
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        {willVoidCriteria
          ? "验收标准是按原目标提的，改动后它们会作废、重新协商一轮。"
          : "改动后轮次与停滞计数重新起算，产物另存一份。"}
      </p>
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="h-7 px-2.5" onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          className="h-7 px-3"
          disabled={!valid}
          onClick={() => onCommit(trimmed)}
        >
          确定
        </Button>
      </div>
    </div>
  );
};

/**
 * 条上可点的目标原文。
 *
 * 只在能改的时候可点：已完成的目标是收工记录不是待办，改它没有意义
 * （要接着做就新设一个），所以那时退化成一段纯文本。
 */
const ObjectiveText: FC<{
  goal: GoalSnapshot;
  disabled?: boolean;
  onCommit: (objective: string) => void;
}> = ({ goal, disabled, onCommit }) => {
  const [open, setOpen] = useState(false);
  const editable = goal.status !== "complete";
  const voids =
    goal.acceptance?.status === "proposed" || goal.acceptance?.status === "confirmed";

  if (!editable) {
    return (
      <span className="min-w-0 flex-1 truncate" title={goal.objective}>
        {goal.objective}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            title="点这里改目标原文"
            className="hover:text-foreground focus-visible:ring-ring min-w-0 flex-1 truncate rounded text-left transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50"
          >
            {goal.objective}
          </button>
        }
      />
      <PopoverContent align="start" className="w-96 p-3">
        {open && (
          <ObjectiveEditor
            initial={goal.objective}
            willVoidCriteria={voids}
            onCommit={(objective) => {
              setOpen(false);
              onCommit(objective);
            }}
            onCancel={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
};

/**
 * 验收标准待确认卡片。
 *
 * 为什么在这里选权限档：默认档下每条 write/bash 都要弹审批卡，而目标要跑几十
 * 上百轮——用户在「确认这份契约」的时刻顺带定下这条目标跑在哪个档，比跑到第 30
 * 轮才发现要一条条点确认强。这个值落的是会话级审批偏好，不是目标字段。
 */
const CriteriaConfirmCard: FC<{
  goal: GoalSnapshot;
  busy: boolean;
  onConfirm: (approvalLevel: string) => void;
  onReject: (feedback: string) => void;
  onSkip: () => void;
}> = ({ goal, busy, onConfirm, onReject, onSkip }) => {
  const [approvalLevel, setApprovalLevel] = useState("auto-edit");
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const items = goal.acceptance?.items ?? [];
  // 上一版为什么被退回（用户自己的意见 / 目标被改过）：sidecar 让这条意见跨过一次
  // 重提（见 Acceptance.proposed），所以模型改完再提交时这里还看得到——用户复审
  // 新版标准时最需要的就是「我提的那点它真改了吗」
  const previousFeedback = goal.acceptance?.feedback;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium">验收标准（确认后开始执行）</div>
      {previousFeedback && (
        <div className="border-border/60 text-muted-foreground rounded border border-dashed p-2 text-[11px] leading-relaxed">
          上一版为什么被退回：{previousFeedback}
        </div>
      )}
      <ol className="flex flex-col gap-1">
        {items.map((c) => (
          <li key={c.id} className="flex gap-1.5 text-[11px] leading-relaxed">
            <span className="text-muted-foreground shrink-0 tabular-nums">{c.id}</span>
            <span className="min-w-0">{c.text}</span>
          </li>
        ))}
      </ol>

      {!rejecting && (
        <>
          <div className="text-muted-foreground mt-1 text-[11px]">
            这条目标跑在这些操作上的确认档
          </div>
          <div className="grid grid-cols-2 gap-1">
            {APPROVAL_LEVELS.map((l) => (
              <button
                key={l.value}
                type="button"
                title={l.hint}
                onClick={() => setApprovalLevel(l.value)}
                className={cn(
                  "rounded border px-1.5 py-1 text-[11px] transition-colors",
                  approvalLevel === l.value
                    ? "border-foreground/30 bg-foreground/5 font-medium"
                    : "border-border/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-[11px] leading-relaxed">
            按这个标准完成时，模型必须逐条给出证据；有标准没达标就不算完成。
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              驳回
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5"
              disabled={busy}
              title="不要验收标准，直接开始干活"
              onClick={() => onSkip()}
            >
              跳过
            </Button>
            <Button
              size="sm"
              className="h-7 px-3"
              disabled={busy}
              onClick={() => onConfirm(approvalLevel)}
            >
              确认并开始
            </Button>
          </div>
        </>
      )}

      {rejecting && (
        <>
          <textarea
            autoFocus
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="哪里不对？模型下一轮会按这段意见重提（留空也能提交，但它只能靠猜）"
            className="border-border/60 bg-background w-full resize-none rounded border p-2 text-[11px] leading-relaxed outline-none"
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5"
              onClick={() => setRejecting(false)}
            >
              返回
            </Button>
            <Button
              size="sm"
              className="h-7 px-3"
              disabled={busy}
              onClick={() => onReject(feedback)}
            >
              提交意见
            </Button>
          </div>
        </>
      )}
    </div>
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
  const view = displayState(goal);
  const running = view.live;
  const awaiting = isGoalAwaitingConfirmation(goal);
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
          view.className,
        )}
      />
      <ObjectiveText
        goal={goal}
        disabled={busy}
        onCommit={(objective) => act((id) => setGoalObjectiveNow(id, objective))}
      />
      <span className="text-muted-foreground flex shrink-0 items-center gap-2">
        <span className={cn("shrink-0", view.className)}>{view.label}</span>
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
      {/* 待确认标准：这是整条目标的契约，不能只给个图标——清单与三个决定
          （确认/驳回/跳过）都在这张卡里，条上那个按钮只是它的入口 */}
      {awaiting && (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="sm"
                className="h-6 shrink-0 px-2 text-[11px]"
                disabled={busy}
                title="查看并确认验收标准"
              >
                确认标准
                {goal.acceptance?.items.length
                  ? `（${goal.acceptance.items.length} 条）`
                  : ""}
              </Button>
            }
          />
          <PopoverContent align="end" className="w-80 p-3">
            <CriteriaConfirmCard
              goal={goal}
              busy={busy}
              onConfirm={(level) => act((id) => confirmGoalCriteriaNow(id, level))}
              onReject={(text) => act((id) => rejectGoalCriteriaNow(id, text))}
              onSkip={() => act(skipGoalCriteriaNow)}
            />
          </PopoverContent>
        </Popover>
      )}
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
      {!running && view.resumable && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => act(resumeGoalNow)}
          // 不在目标档时，「继续」会顺手把档位切回目标模式（sidecar 的 ensureGoalMode：
          // 目标只在 goal 档跑）。按钮上直说这件事，别让用户发现自己的档位被换了
          title={
            mode === "goal"
              ? "继续这个目标（轮次与停滞计数重新起算）"
              : "继续这个目标（会切回目标模式——它只在这一档跑）"
          }
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
