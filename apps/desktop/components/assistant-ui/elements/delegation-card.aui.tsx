"use client";

/**
 * 子智能体委派卡片（消息流里 Task 调用的新外观）。
 *
 * 纯展示层：所有数据经 props 传入，方便 dev-preview 用夹具校对；
 * 真实接线（运行 store / 模型目录 / 打开面板）见 task-delegation-card.aui。
 *
 * 形态对齐参考图：圆角卡片 + 32px 头像 + agent 名/模型 + 状态胶囊，
 * 正文是任务描述（两行截断），底部是轮次 · 用时。
 * 连线是灰色底轨 + 蓝色覆盖层：派活时蓝线从主 agent 沿主干/母线/分支画到子卡。
 * 多个并行委派由 DelegationGroup 加左侧母线；单张自动退化成单卡。
 */
import {
  Children,
  Fragment,
  isValidElement,
  useRef,
  useState,
  useLayoutEffect,
  type ComponentType,
  type FC,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  ClockIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  Repeat2Icon,
  SendIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useScrollLock } from "@/hooks/use-scroll-lock";
import { SubagentAvatar } from "@/components/custom-ui/subagent-avatar";
import { NumberTicker } from "@/components/custom-ui/number-ticker";
import { cn } from "@/lib/utils";

export type DelegationCardStatus =
  | "starting"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "truncated"
  | "aborted"
  | "stopped"
  | "interrupted"
  | "dispatched"
  | "expired";

type StatusMeta = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** 非环状指示器时的图标颜色 */
  tone: string;
};

const STATUS_META: Record<DelegationCardStatus, StatusMeta> = {
  starting: {
    label: "启动中",
    icon: ClockIcon,
    tone: "text-muted-foreground",
  },
  queued: {
    label: "排队中",
    icon: ClockIcon,
    tone: "text-muted-foreground",
  },
  running: {
    label: "运行中",
    icon: LoaderCircleIcon,
    tone: "text-blue-500",
  },
  completed: {
    label: "已完成",
    icon: CheckIcon,
    tone: "text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    label: "失败",
    icon: XIcon,
    tone: "text-rose-600 dark:text-rose-400",
  },
  truncated: {
    label: "轮次超限",
    icon: TriangleAlertIcon,
    tone: "text-amber-600 dark:text-amber-400",
  },
  aborted: {
    label: "已中止",
    icon: CircleSlashIcon,
    tone: "text-muted-foreground",
  },
  stopped: {
    label: "已停止",
    icon: CircleSlashIcon,
    tone: "text-muted-foreground",
  },
  interrupted: {
    label: "已中断",
    icon: CircleSlashIcon,
    tone: "text-muted-foreground",
  },
  dispatched: {
    label: "已派发",
    icon: SendIcon,
    tone: "text-muted-foreground",
  },
  expired: {
    label: "记录不可用",
    icon: CircleSlashIcon,
    tone: "text-rose-600 dark:text-rose-400",
  },
};

/**
 * 连线入场动效：灰色底轨常驻，蓝色覆盖层从主 agent 往子卡方向「画」过去。
 * 竖向 fill 从 top 生长，横向 fill 从 left 生长，母线从中心向两侧；
 * 用 CSS keyframes 而不是动画库——消息列表是热路径，不额外拉 motion runtime。
 * 所有动画都在 prefers-reduced-motion 下关闭（关闭后直接显示完成态）。
 */
const DELEGATION_MOTION_CSS = `
@keyframes aui-delegation-card-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes aui-delegation-fill-y {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}
@keyframes aui-delegation-fill-x {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
@keyframes aui-delegation-ring {
  0% { stroke-dashoffset: 22; }
  50% { stroke-dashoffset: 6; }
  100% { stroke-dashoffset: 22; }
}
.aui-delegation-card-in {
  animation: aui-delegation-card-in 360ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
.aui-delegation-fill-y {
  transform-origin: top;
  animation: aui-delegation-fill-y 460ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
.aui-delegation-fill-x {
  transform-origin: left;
  animation: aui-delegation-fill-x 420ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
.aui-delegation-fill-x-center {
  transform-origin: center;
  animation: aui-delegation-fill-x 460ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
.aui-delegation-ring {
  animation: aui-delegation-ring 1.6s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .aui-delegation-card-in,
  .aui-delegation-fill-y,
  .aui-delegation-fill-x,
  .aui-delegation-fill-x-center,
  .aui-delegation-ring {
    animation: none;
  }
  .aui-delegation-ring {
    stroke-dashoffset: 12;
  }
}
`;

/** 在页面/消息组里渲染一次即可（React 会按 href 去重） */
export const DelegationMotionStyle = () => (
  <style href="aui-delegation-motion" precedence="low">
    {DELEGATION_MOTION_CSS}
  </style>
);

const StatusGlyph: FC<{ status: DelegationCardStatus }> = ({ status }) => {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  // 参考图的「环」：running 走动态弧，queued/starting 走一小段静态弧，
  // 终态用图标（完成勾/失败叉/超限感叹号…）。
  if (status === "running" || status === "queued" || status === "starting") {
    const live = status === "running";
    return (
      <svg aria-hidden viewBox="0 0 12 12" className="size-3 -rotate-90">
        <circle
          cx="6"
          cy="6"
          r="5"
          fill="none"
          className="stroke-border"
          strokeWidth="2"
        />
        <circle
          cx="6"
          cy="6"
          r="5"
          fill="none"
          className={cn(
            live ? "stroke-blue-500 aui-delegation-ring" : "stroke-muted-foreground/70",
          )}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="31.4159"
          strokeDashoffset={live ? undefined : 27}
        />
      </svg>
    );
  }
  return <Icon className={cn("size-3", meta.tone)} />;
};

const StatusPill: FC<{ status: DelegationCardStatus }> = ({ status }) => (
  <span
    data-slot="delegation-status"
    data-status={status}
    className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border px-2 text-xs whitespace-nowrap text-foreground"
  >
    <StatusGlyph status={status} />
    <span>{STATUS_META[status].label}</span>
  </span>
);

export type DelegationCardViewProps = {
  agentName: string;
  /** 模型展示名（目录解析后的 name；缺省不画这一行） */
  modelLabel?: string;
  /** 任务说明：优先 description，回退 task brief */
  description?: string;
  status: DelegationCardStatus;
  /** 已迭代轮次（run.turns）；0/缺省不显示 */
  turns?: number;
  elapsedSeconds?: number;
  /** 启动失败等错误原因（渲染成卡片内的红框，代替描述下方留白） */
  errorText?: string;
  avatar?: string;
  /** 有目标时整卡可点（打开子智能体运行过程 tab） */
  onOpen?: () => void;
  className?: string;
};

export const DelegationCardView: FC<DelegationCardViewProps> = ({
  agentName,
  modelLabel,
  description,
  status,
  turns: turnsProp,
  elapsedSeconds,
  errorText,
  avatar,
  onOpen,
  className,
}) => {
  // 迭代轮次：0/缺省不占位（刚派发时还没开始第一轮）
  const turns =
    typeof turnsProp === "number"
      ? Math.max(0, Math.round(turnsProp))
      : 0;
  const hasTurns = turns > 0;
  const durationSeconds =
    typeof elapsedSeconds === "number"
      ? Math.max(0, Math.round(elapsedSeconds))
      : undefined;
  const hasFooter = hasTurns || durationSeconds !== undefined;
  const descriptionText = description?.trim() || "未填写任务说明";
  const danger = status === "failed" || status === "expired";
  const warning = status === "truncated";
  const interactive = !!onOpen;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onOpen?.();
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    // 整卡是面板入口：别让点击冒泡到消息级（选中/分享等）处理器
    event.stopPropagation();
    onOpen?.();
  };

  return (
    <div
      data-slot="delegation-card"
      data-status={status}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `查看 ${agentName} 子智能体运行过程` : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        "group/card flex min-w-0 flex-col rounded-2xl border p-3 transition-colors",
        danger
          ? "border-rose-500/30 bg-rose-500/[0.03]"
          : warning
            ? "border-amber-500/30 bg-amber-500/[0.03]"
            : "border-border bg-background",
        interactive &&
          "hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-ring/40 cursor-pointer outline-none focus-visible:ring-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SubagentAvatar
          name={agentName}
          avatar={avatar}
          className="size-7 rounded-full"
        />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="max-w-[60%] min-w-0 truncate text-sm leading-5 font-medium">
            {agentName}
          </span>
          {modelLabel ? (
            <>
              <span aria-hidden className="text-muted-foreground/40 shrink-0">
                ·
              </span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs leading-4">
                {modelLabel}
              </span>
            </>
          ) : null}
        </div>
        <StatusPill status={status} />
      </div>

      <div className="mt-2 flex min-w-0 items-end gap-2">
        <p className="text-muted-foreground line-clamp-2 min-w-0 flex-1 text-sm leading-5 text-pretty">
          {descriptionText}
        </p>
        {hasFooter ? (
          <div className="text-muted-foreground flex shrink-0 items-center gap-1.5 pb-0.5 text-xs tabular-nums">
            {hasTurns ? (
              <span
                className="inline-flex items-center gap-1"
                title={`已迭代 ${turns} 轮`}
              >
                <Repeat2Icon className="size-3 shrink-0" />
                <NumberTicker value={turns} duration={0.45} stagger={0.02} />
                <span>轮</span>
              </span>
            ) : null}
            {hasTurns && durationSeconds !== undefined ? (
              <span aria-hidden className="opacity-50">
                ·
              </span>
            ) : null}
            {durationSeconds !== undefined ? (
              <NumberTicker
                value={durationSeconds}
                suffix="s"
                duration={0.45}
                stagger={0.02}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {errorText ? (
        <div className="mt-2 max-h-40 overflow-auto rounded-md border border-rose-500/20 bg-rose-500/5 px-2.5 py-2 font-mono text-[11px] leading-4 break-words whitespace-pre-wrap text-rose-600 dark:text-rose-400">
          {errorText}
        </div>
      ) : null}
    </div>
  );
};

/**
 * GroupedParts 把组的子树包在一个 Fragment 里传进来；Children.toArray 会把
 * 这个 Fragment 当成单个节点，导致有两个 Task 时仍然走「单卡退化」分支。
 * 这里把单层 Fragment 拆开再计数（Task 组是平铺的，不需要递归嵌套组）。
 */
function delegationItems(children: ReactNode): ReactNode[] {
  const nodes = Children.toArray(children);
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (isValidElement(only) && only.type === Fragment) {
    return Children.toArray(
      (only.props as { children?: ReactNode }).children,
    );
  }
  return nodes;
}

/**
 * 同一轮相邻多个 Task 的编排容器：左侧竖向导轨 + 每张卡的横向肘线。
 * 单张不成组（直接返回 children），与消息流里普通工具行的节奏一致。
 */
export const DelegationGroup: FC<{
  children: ReactNode;
  /** 有任一派在跑：默认展开；全部跑完自动收起（用户手动开合后不再自动） */
  running?: boolean;
  /** 刚派发、运行条目还没到：保持展开，但不显示运行转圈 */
  pending?: boolean;
  /** 静态预览：初始展开 */
  defaultOpen?: boolean;
  className?: string;
}> = ({
  children,
  running = false,
  pending = false,
  defaultOpen = false,
  className,
}) => {
  const items = delegationItems(children);
  const groupRef = useRef<HTMLDivElement>(null);
  const initialOpenRef = useRef(defaultOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lockScroll = useScrollLock(groupRef, 220);
  // 运行起落自动开合时钉住视口，避免组高度变化把消息区顶走；手动开合也锁
  const prevLive = useRef(running || pending);
  useLayoutEffect(() => {
    const live = running || pending;
    if (prevLive.current !== live && userOpen === null) lockScroll();
    prevLive.current = live;
  }, [running, pending, userOpen, lockScroll]);

  // 单张不成组，但调用方给的宽度约束仍要生效（消息流里单卡也是 max-w-sm）
  if (items.length <= 1) {
    return className ? (
      <div className={cn("min-w-0", className)}>{children}</div>
    ) : (
      <>{children}</>
    );
  }

  const open = userOpen ?? (running || pending ? true : initialOpenRef.current);

  return (
    <Collapsible
      ref={groupRef}
      data-slot="delegation-group"
      open={open}
      onOpenChange={(next) => {
        lockScroll();
        setUserOpen(next);
      }}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <DelegationMotionStyle />
      <CollapsibleTrigger className="group/trigger text-muted-foreground hover:text-foreground flex origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale]">
        <GitBranchIcon className="size-4 shrink-0" />
        <span className="inline-block leading-none tabular-nums">
          并行委派 · {items.length}
        </span>
        {running ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-blue-500" />
        ) : null}
        <ChevronDownIcon className="mt-0.5 size-4 shrink-0 -rotate-90 opacity-0 transition-[transform,opacity] duration-200 group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100 group-data-panel-open/trigger:rotate-0 group-data-panel-open/trigger:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "relative overflow-hidden outline-none",
          "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards data-closed:pointer-events-none",
          "[--tw-duration:220ms]",
        )}
      >
        <div className="relative flex flex-col gap-2 pl-7">
          {/* 左侧母线：灰色底轨常驻，派活时蓝线从上往下画过去 */}
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-1.5 w-2 -translate-x-1/2 overflow-hidden"
          >
            <span className="bg-border absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2" />
            <span
              className="aui-delegation-fill-y bg-blue-500 absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2"
              style={{ animationDelay: "100ms" }}
            />
          </span>
          {items.map((child, index) => (
            <div
              key={index}
              className="aui-delegation-card-in relative min-w-0"
              style={{ animationDelay: `${120 + index * 80}ms` }}
            >
              {/* 横向分支：灰色底轨 + 蓝线从母线往右送进这张卡，逐卡错峰 */}
              <span
                aria-hidden
                className="absolute top-6 -left-[22px] h-2 w-[22px] overflow-hidden"
              >
                <span className="bg-border absolute top-1/2 left-0 h-px w-full -translate-y-1/2" />
                <span
                  className="aui-delegation-fill-x bg-blue-500 absolute top-1/2 left-0 h-px w-full -translate-y-1/2"
                  style={{ animationDelay: `${650 + index * 170}ms` }}
                />
              </span>
              {child}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
