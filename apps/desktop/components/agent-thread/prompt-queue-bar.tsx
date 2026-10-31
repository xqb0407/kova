"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { usePiController, usePiQueue, restoreQueueItemsToComposer } from "@/lib/pi/pi-runtime";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ImageIcon,
  MergeIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FC } from "react";
import {
  DirectiveText,
  directiveChipVariants,
} from "@/components/assistant-ui/elements/directive-text.aui";
import { cn } from "cn";

// DirectiveText 运行时签名就是 ({ text })（memo 导出被放宽成 TextMessagePartComponent
// 才要求 part），排队条只有纯文本无 part，收窄回真实签名
const QueueDirectiveText = DirectiveText as unknown as FC<{ text: string }>;

/**
 * prompt 排队条（composer 上方）——迁移 4a：数据源 = react-pi state.queue
 * （sidecar queue_update 事件驱动，条目 id = 真实 reqId）。扁平样式：单块
 * 浅色面板 = 可折叠头部（「N 条排队中 ⌄」）+ 纯文本条目行（无卡片边框/
 * 序号，hover 出逐项操作），参考 2026-10-31 用户给的样式稿。
 *
 * 头部操作：
 *  - 折叠/展开（⌄）：只收起条目列表，头部常驻（暂停/清空随时可用）；
 *    视图偏好在会话内保留，不随线程切换重置
 *  - 暂停/继续（v3.1）：冻结/解冻自动派发——当前轮自然跑完，之后不开下一轮；
 *    恢复由 sidecar 原生接力接棒（kickQueueDrain 补工人槽，顺序与队列一致）。
 *    状态随 queue_update/快照回流，暂停中刷新后仍保持
 *  - 清空（垃圾桶）：取消全部排队项，不回填（与单条删除同语义）
 * 条目操作（hover 显示）：
 *  - 上移/下移（v3.1）：调整派发顺序（sidecar moveEntry，队首/队尾自动隐藏）
 *  - 编辑（v3.1）：从队列移除并把内容（文本+图片）退回输入框，在 composer
 *    里改完重新发送（重发走正常排队车道，排到队尾——位置让位给简单可靠）
 *  - 并入当前回复（steer）：注入活跃轮，不中止本轮；成功后条目从队列消失，
 *    内容随本轮回复呈现（v3.1 移除「已并入」徽标折叠条——反馈由条目消失承担）
 *  - 立即发送（promote）：中止当前轮、该项插队马上执行（暂停中隐式恢复）
 *  - 删除（cancel）：取消排队项，不执行不回填（想改内容走编辑）
 * 排队中的消息不进消息列表（sidecar 调度后才落盘转录）——react-pi 原生满足
 * 「调度前不显示气泡」，无需旧链路的 remove/reveal 信号同步。
 *
 * 刷新接力泵（收敛版）：运行轮重挂由 connect + 快照自愈承担（迁移阶段 3）；
 * 队列非空时订阅保活（见 usePiRuntime），sidecar 串行链派发的下一轮
 * agent_start 原生可见——泵只剩一种场景：sidecar 重启后无链节的孤儿队列
 * （暂停恢复不走泵：sidecar 原生接力补槽派发，链节在场时泵被
 * hasPromptChain 守卫拦住，天然互不干扰）。挂载/快照恢复（队列从空变非空）
 * 与运行态下降沿时探测：线程空闲且队列非空且未暂停 → queue_pop（sidecar
 * 守卫暂停位 + isTurnBusy + hasPromptChain 三保险，链节在时绝不误弹）→
 * 弹出队首按原载荷直发重发（文本+图片附件，绕开 composer 共用车道防幽灵
 * pending）。暂停位变化也进探测键：恢复瞬间若接力槽尚未建起（事件在途），
 * 键不含 paused 的话泵不会重新探测。
 */
export const PromptQueueBar: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  // 运行态不订阅渲染值：下降沿（泵孤儿队列）在下方订阅控制器逐次观察；
  // 泵内部自己读 aui.thread.getState().isRunning。渲染值会被 React 批处理
  // 合并，本轮收尾与下一轮立即派发同批到达时看不到 false 瞬间。
  const controller = usePiController();
  const { queue, cancel, promote, steer, pop, resend, pause, resume, move, clear } =
    usePiQueue();
  const paused = queue.paused;
  const [busy, setBusy] = useState(false);
  // 折叠态：只收条目列表，头部（暂停/清空）常驻
  const [open, setOpen] = useState(true);
  // hover 跑马灯：条目文本溢出时，hover 触发横向滚动到末端停住
  //（--queue-marquee-shift = 溢出像素，滚速 22px/s，keyframes 见 styles/animate.css）
  const [marqueeId, setMarqueeId] = useState<string | null>(null);
  const [marqueeShift, setMarqueeShift] = useState(0);
  const [marqueeDuration, setMarqueeDuration] = useState(0);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // 无活跃轮可并入等拒绝：忽略（条目原位保留，快照下一次广播对齐）
    } finally {
      setBusy(false);
    }
  };

  // 接力泵（见头注）：pumpingRef 防重入（内含 await 链）。queue_pop 的
  // sidecar 三保险让误弹不可能——暂停中/链节仍在/轮在跑时 popped 恒为 null。
  const pumpRef = useRef<() => Promise<void>>(async () => {});
  const pumpingRef = useRef(false);
  pumpRef.current = async () => {
    if (!aui || !threadId || pumpingRef.current) return;
    if (queue.paused) return;
    if (queue.steering.length === 0 && queue.followUp.length === 0) return;
    pumpingRef.current = true;
    try {
      // 在跑轮（含链节盲派发的下一轮）：订阅保活下事件原生可见，无需泵
      if (aui.thread.getState().isRunning) return;
      const popped = await pop();
      if (!popped) return;
      // 直发重发（controller.queueResend）：带原载荷图片附件，且绕开 composer
      // 共用车道——弹出后前端队列条与 sidecar 引擎可能短暂分歧（空快照事件
      // 在途），composer 车道会把重发误判进排队压出 pending 幽灵。撞竞态轮
      // （线程又忙了）时 isQueuedSend 照常接管续排队，语义不变
      await resend(popped);
    } catch (err) {
      // 通道异常：下一次下降沿/队列变化再试；留痕防"泵凭空失效"无从排查
      console.warn("[queue-pump] dispatch failed", String(err));
    } finally {
      pumpingRef.current = false;
    }
  };

  // 队列非空即探测（覆盖挂载/线程切换/快照恢复采纳孤儿队列/队列增长/暂停位
  // 翻转）；全空时 key 归零不触发。泵内部有暂停位与 sidecar 双重守卫，多触发无害
  const queueKey = `${queue.steering.length}:${queue.followUp.length}:${
    queue.followUp[0]?.id ?? ""
  }:${paused ? 1 : 0}`;
  useEffect(() => {
    if (queueKey === "0:0::0") return;
    void pumpRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  // 运行态下降沿：链节派发由订阅保活原生覆盖；泵兜孤儿队列。不比较渲染值——
  // 本轮收尾与下一轮立即派发会被 React 合并进同一次渲染，组件看不到 false
  // 瞬间；直接订阅控制器通知逐次观察状态提交，边沿不丢。
  // busy 判定与框架 thread.isRunning 同口径（isPiStateBusy）：runStatus 之外
  // 还看压缩/重试——轮前压缩时 runStatus 可能已是 idle 但轮还没真正结束。
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (!threadId) return;
    return controller.subscribe(() => {
      const s = controller.getState();
      const busy =
        s.runStatus === "running" || s.compaction.active || s.retry.active;
      const was = wasRunningRef.current;
      wasRunningRef.current = busy;
      if (was && !busy) {
        void pumpRef.current();
      }
    });
  }, [controller, threadId]);

  const items = queue.followUp;
  if (!threadId) return null;

  // 进场实测溢出量，超出才起跑马灯（scrollWidth 在 truncate 态也量到完整内容宽）
  const startMarquee =
    (id: string) => (event: React.MouseEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      const inner = viewport.firstElementChild as HTMLElement | null;
      if (!inner) return;
      const dist = inner.scrollWidth - viewport.clientWidth;
      if (dist <= 2) {
        setMarqueeId(null);
        return;
      }
      setMarqueeShift(dist);
      setMarqueeDuration(Math.min(45, Math.max(3, dist / 22)));
      setMarqueeId(id);
    };

  return (
    <div
      className="relative grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: items.length > 0 ? "1fr" : "0fr" }}
      data-slot="aui-prompt-queue-bar"
      aria-hidden={items.length === 0}
    >
      {/* 连体灰背板：向下延伸垫到 composer 卡（z-10）的圆角后面——卡片的
          上圆角缺口透出灰色，队列区与输入卡在轮廓上连成一张（样式稿）。
          top 用 calc(100%-8px) 从面板可视底部起算（容器高度含面板 mb-2 的
          外边距盒，top-full 会偏到卡片顶边、把 mb-2 的 8px 缝隙漏在背板
          外面）；高度 = 圆角 + 缝隙 8px + 4px 余量。必须挂在 grid 容器
          （relative）这一层：内层 overflow-hidden 折叠裁剪层会把超出面板
          底部的部分裁掉；空队列不渲染 */}
      {items.length > 0 && (
        <div
          aria-hidden
          className="bg-muted/80 dark:bg-muted/80 backdrop-blur-md pointer-events-none absolute inset-x-0 top-[calc(100%-8px)] h-[calc(var(--composer-radius)+12px)]"
        />
      )}
      <div className="min-h-0 overflow-hidden">
        <div
          className="bg-muted/80 dark:bg-muted/80 rounded-t-(--composer-radius) mb-2 px-3.5 pt-1.5 pb-1"
          // ComposerRoot 对非交互区域的 mousedown 会 preventDefault 抢焦点
          // （「点击输入区空白聚焦」），队列条正文因此选不中。这里阻断冒泡，
          // 保留原生选区行为（库文档给后代留的逃生口）；点击图标按钮不受影响
          onMouseDown={(event) => event.stopPropagation()}
        >
          {/* 头部：N 条排队中 ⌄（折叠/展开条目列表）｜ 暂停 · 清空 */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="text-muted-foreground/80 hover:text-foreground focus-visible:ring-ring/40 -ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm py-1 text-left text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <ChevronDownIcon
                className={cn(
                  "size-3 shrink-0 transition-transform duration-200",
                  !open && "-rotate-90",
                )}
              />
              <span className="truncate" aria-live="polite">
                {items.length} 条排队中
                {paused && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {" "}
                    · 已暂停
                  </span>
                )}
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              <QueueIconButton
                label={
                  paused
                    ? "继续排队发送"
                    : "暂停排队发送（当前回复跑完不再派发下一条）"
                }
                disabled={busy}
                onClick={() => void act(() => (paused ? resume() : pause()))}
              >
                {paused ? (
                  <PlayIcon className="size-3.5" />
                ) : (
                  <PauseIcon className="size-3.5" />
                )}
              </QueueIconButton>
              <QueueIconButton
                label="清空全部排队消息"
                disabled={busy}
                className="hover:text-destructive"
                onClick={() =>
                  void act(async () => {
                    // 整队取消（不回填，与单条删除同语义）；回执载荷弃用
                    await clear();
                  })
                }
              >
                <Trash2Icon className="size-3.5" />
              </QueueIconButton>
            </div>
          </div>
          {/* 条目列表：纯文本行（无卡片边框/序号），hover 出逐项操作；
              折叠走 grid-rows 0fr↔1fr 过渡，与外层容器同款 */}
          <div
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
            aria-hidden={!open}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex flex-col gap-0.5 py-1">
                {items.map((item, index) => {
                  // 附件随条目下发（sidecar 快照/pop 与本地乐观条目同形状）：
                  // 出缩略图，纯图条目回退成「[图片]」文案
                  const images = item.attachments ?? [];
                  const thumb = images.find((attachment) => attachment.data);
                  const label = item.content.trim()
                    ? item.content
                    : images.length > 0
                      ? `[图片${images.length > 1 ? ` ×${images.length}` : ""}]`
                      : item.content;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        // 不用负外边距通栏：高亮药丸完整浮在面板内部，两端
                        // 圆角可见（通栏会被面板边缘吃掉圆角，读不出圆角）
                        "group hover:bg-muted-foreground/10 flex items-center gap-2 rounded-lg px-2 py-1 transition-colors",
                        paused && "opacity-60",
                      )}
                    >
                      {images.length > 0 &&
                        (thumb ? (
                          <img
                            src={`data:${thumb.mimeType};base64,${thumb.data}`}
                            alt={thumb.name ?? "排队消息附图"}
                            className="border-border/50 size-5 shrink-0 rounded border object-cover"
                          />
                        ) : (
                          <ImageIcon className="text-muted-foreground/60 size-3.5 shrink-0" />
                        ))}
                      {/* 芯片渲染：内容含 :console[..]{..} 等 directive 语法时
                          渲染成与消息气泡同款芯片（DirectiveText 解析，
                          directiveChipVariants 提供蓝底徽章配色；静态态
                          truncate 出省略号）；hover 溢出内容跑马灯滚动 */}
                      <div
                        className={cn(
                          directiveChipVariants,
                          "min-w-0 flex-1 overflow-hidden text-sm text-foreground/80",
                        )}
                        onMouseEnter={startMarquee(item.id)}
                        onMouseLeave={() => setMarqueeId(null)}
                      >
                        <div
                          className={cn(
                            "items-center gap-1",
                            marqueeId === item.id ? "flex w-max" : "truncate",
                          )}
                          style={
                            marqueeId === item.id
                              ? ({
                                  "--queue-marquee-shift": `${marqueeShift}px`,
                                  animation: `queue-marquee ${marqueeDuration}s linear forwards`,
                                } as React.CSSProperties)
                              : undefined
                          }
                        >
                          <QueueDirectiveText text={item.content || label} />
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                        {index > 0 && (
                          <QueueIconButton
                            label="上移"
                            disabled={busy}
                            onClick={() => void act(() => move(item.id, index - 1))}
                          >
                            <ArrowUpIcon className="size-3.5" />
                          </QueueIconButton>
                        )}
                        {index < items.length - 1 && (
                          <QueueIconButton
                            label="下移"
                            disabled={busy}
                            onClick={() => void act(() => move(item.id, index + 1))}
                          >
                            <ArrowDownIcon className="size-3.5" />
                          </QueueIconButton>
                        )}
                        <QueueIconButton
                          label="编辑（退回输入框修改后重新发送）"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              // 对话框编辑：先取回再移除（与停止生成同序——cancel
                              // 自身不清载荷，这里直接用条目自带的文本+附件退回）
                              await cancel(item.id);
                              await restoreQueueItemsToComposer(aui, [item]);
                            })
                          }
                        >
                          <PencilIcon className="size-3.5" />
                        </QueueIconButton>
                        <QueueIconButton
                          label="并入当前回复（不中止本轮）"
                          disabled={busy}
                          onClick={() => void act(() => steer(item.id))}
                        >
                          <MergeIcon className="size-3.5" />
                        </QueueIconButton>
                        <QueueIconButton
                          label="立即发送（中止当前回复）"
                          disabled={busy}
                          onClick={() => void act(() => promote(item.id))}
                        >
                          <ZapIcon className="size-3.5" />
                        </QueueIconButton>
                        <QueueIconButton
                          label="删除"
                          disabled={busy}
                          className="hover:text-destructive"
                          onClick={() => void act(() => cancel(item.id))}
                        >
                          <XIcon className="size-3.5" />
                        </QueueIconButton>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const QueueIconButton: FC<{
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, disabled, className, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "text-muted-foreground/80 hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted-foreground/10 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
  >
    {children}
  </button>
);
