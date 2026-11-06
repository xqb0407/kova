"use client";

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { ImagePartCard } from "@/components/assistant-ui/elements/image-data";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { MessageTiming } from "@/components/assistant-ui/elements/message-timing.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  toolCategory,
  type ToolCategory,
} from "@/components/assistant-ui/elements/tool-category";
import { QuestionToolRow } from "./question-tool-row";
import { PlanExitToolRow } from "./plan-exit-tool-row";
import {
  resolveToolUI,
  ToolGroupCategoryProvider,
} from "@/components/assistant-ui/elements/tool-row.aui";
import {
  ToolCallMetaProvider,
  toolCallMetaFromPart,
} from "@/components/assistant-ui/elements/tool-call-meta";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import {
  AuiIf,
  type AssistantState,
  MessagePrimitive,
  ActionBarPrimitive,
  ErrorPrimitive,
  useAuiState,
  ActionBarMorePrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { RetryMarker, useRetryState } from "./retry-marker";
import { StoppedMarker, isStoppedMessageState } from "./stopped-marker";
import {
  TruncationStoppedMarker,
  isTruncationStoppedMessageState,
} from "./truncation-marker";
import {
  collectProcessTexts,
  isTurnEndMessage,
  packTurnSlot,
  parseTurnSlot,
} from "@/lib/panels/message-turns";
import { MessageArtifacts } from "./agent-panel/artifact-card";
import { MessageSources } from "./message-sources";
import { MessageCheckpoint } from "./checkpoint-card";
import { MessageSelectToggle } from "./share/message-select-toggle";
import { cn } from "cn";
import type { PiImagePartData } from "@/lib/pi/pi-bridge";
import { enterShareMode } from "@/lib/share/share-store";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GitBranchIcon,
  GlobeIcon,
  MoreHorizontalIcon,
  NotebookPenIcon,
  PencilLineIcon,
  RefreshCwIcon,
  SearchIcon,
  Share2Icon,
  SquareTerminalIcon,
} from "lucide-react";
import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { randomLoadingPhrase } from "@/lib/panels/loading";
import { requestOpenSession } from "@/lib/pi/open-session";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { saveNoteFromText } from "@/lib/workspace/library-save-note";
import {
  forkPiSession,
  piSessionCwdMap,
  piSessionIdForThread,
  piSessionProjectMap,
} from "@/lib/pi/pi-thread-adapter";
import { toast } from "@/components/ui/toast";

/**
 * 交互面在别处、消息列表不再渲染的工具：
 * todo 的进度在右侧面板「计划」标签呈现——挂 ToolFallback 只是倾倒原始 JSON 噪音。
 * Question 不在此列：提问当下由 composer 卡片交互（question-card.tsx），
 * 回答后在列表里以折叠条目留痕（question-tool-row.tsx）。
 */
const HIDDEN_TOOL_NAMES = new Set(["todo"]);

/**
 * 折叠组头图标：与类别代表工具的单行图标同形（bash=终端、检索=放大镜、编辑=铅笔）
 * 类别判定见 tool-category.ts（browser_* 按前缀归组）
 */
const CATEGORY_ICON: Record<ToolCategory, ReactNode> = {
  terminal: <SquareTerminalIcon className="size-4 shrink-0" />,
  inspect: <SearchIcon className="size-4 shrink-0" />,
  modify: <PencilLineIcon className="size-4 shrink-0" />,
  browser: <GlobeIcon className="size-4 shrink-0" />,
};

/** 工具分组：计数剔除隐藏的工具卡，全组都被隐藏时整组不渲染 */
const ToolGroupSection: FC<{
  indices: readonly number[];
  active: boolean;
  category?: ToolCategory;
  children: ReactNode;
}> = ({ indices, active, category, children }) => {
  // "可见数|文件数|检索数"打包成一个字符串选择器：
  // 值不变时 Object.is 相等，流式期间不会因新对象身份反复重渲
  const summary = useAuiState((s) => {
    let n = 0;
    let files = 0;
    let searches = 0;
    for (const i of indices) {
      const p = s.message.content[i];
      if (!p) continue;
      if (p.type === "tool-call" && HIDDEN_TOOL_NAMES.has(p.toolName)) continue;
      n += 1;
      if (p.type === "tool-call") {
        if (p.toolName === "read") files += 1;
        else if (
          p.toolName === "glob" ||
          p.toolName === "grep" ||
          p.toolName === "WebFetch" ||
          p.toolName === "WebSearch" ||
          p.toolName === "memory_search"
        )
          searches += 1;
      }
    }
    return `${n}|${files}|${searches}`;
  });
  const [count, fileCount, searchCount] = summary.split("|").map(Number);
  if (count === 0) return null;
  // 只有一条时不套折叠组（对齐 Codex：≥2 连续调用才合并）——直接平铺该行，
  // 少一次点击才能看到内容；组标签的计数语义也要求 ≥2 才成立。
  if (count === 1) return <>{children}</>;
  // 类别分组出中文标签；通用分组保持默认 "N tool calls"
  const label =
    category === "terminal"
      ? "终端"
      : category === "modify"
        ? `编辑 · ${count} 文件`
        : category === "browser"
          ? `浏览器 · ${count} 次`
          : category === "inspect"
            ? (() => {
                const seg: string[] = [];
                if (searchCount) seg.push(`${searchCount} 搜索`);
                if (fileCount) seg.push(`${fileCount} 文件`);
                return seg.length ? `查阅 · ${seg.join(", ")}` : "查阅";
              })()
            : undefined;
  return (
    <ToolGroupRoot
      variant="ghost"
      // 终端组运行中摊开（组内 bash 行自带实时输出视口），整组收尾自动收拢；
      // 其余类别保持默认收起——行里没有可看的实时输出，摊开只是噪音
      streaming={active && category === "terminal"}
    >
      <ToolGroupTrigger
        count={count}
        active={active}
        label={label}
        icon={category ? CATEGORY_ICON[category] : undefined}
      />
      <ToolGroupContent>
        {category ? (
          <ToolGroupCategoryProvider value={category}>
            {children}
          </ToolGroupCategoryProvider>
        ) : (
          children
        )}
      </ToolGroupContent>
    </ToolGroupRoot>
  );
};

/**
 * §8 错误归因：transport 把 sidecar error chunk 的结构化归因（分类器换算
 * 的 {code, source, retryable, statusCode?}）转成 data-errorAttribution part
 * 落在本条消息上（error chunk 的未知字段可能被 AI SDK 处理时丢弃，part 桥
 * 与 data-retry 同款）。可重试错误（网络/限流/5xx）在错误卡上给「重试」——
 * Reload = 重发末条用户消息，与操作栏重载同源。
 */
function isRetryableErrorState(s: AssistantState): boolean {
  const parts = s.message.content;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type === "data" && p.name === "errorAttribution") {
      return (p.data as { retryable?: boolean } | undefined)?.retryable === true;
    }
  }
  return false;
}

const MessageError: FC = () => {
  const retryable = useAuiState(isRetryableErrorState);
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md  p-2 text-sm dark:text-red-200">
        <div className="flex items-center justify-between gap-2">
          <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2 min-w-0" />
          {retryable && (
            <ActionBarPrimitive.Reload asChild>
              <button
                type="button"
                className="hover:bg-destructive/15 inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-0.5 text-xs transition-colors"
              >
                <RefreshCwIcon size="1em" />
                重试
              </button>
            </ActionBarPrimitive.Reload>
          )}
        </div>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/**
 * data-errorAttribution 占位卡（sidecar transcript.ts / pi-transport 同名 part）。
 * 崩溃轮次里助手消息可能一个内容块都没有——只有错误。此时若 part 无人渲染，
 * 消息实体仍在但输出为空 div，折叠面也展不出东西，用户看到的就是「消息丢了」。
 * 这里给它一块常显的红色卡：正文、source 归因、retryable 时的重试出口。
 * 复刻 MessageError 的配色与按钮，但**不套** MessagePrimitive.Error ——
 * 那条只在框架拿到 error chunk 时才存在，崩溃轮常常没有。
 */
const TurnErrorCard: FC<{ data: unknown }> = ({ data }) => {
  const p = (data ?? {}) as { message?: unknown; source?: unknown; retryable?: unknown };
  const message = typeof p.message === "string" && p.message ? p.message : "本回合因错误中断";
  const source = typeof p.source === "string" ? p.source : "runtime";
  const retryable = p.retryable === true;
  return (
    <div
      data-slot="aui-turn-error"
      className="border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 dark:text-red-200 mt-2 rounded-md border p-2 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="line-clamp-2 min-w-0" title={message}>
          {message}
        </span>
        {retryable && (
          <ActionBarPrimitive.Reload asChild>
            <button
              type="button"
              className="hover:bg-destructive/15 inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-0.5 text-xs transition-colors"
            >
              <RefreshCwIcon size="1em" />
              重试
            </button>
          </ActionBarPrimitive.Reload>
        )}
      </div>
      <div className="text-destructive/70 dark:text-red-200/70 mt-1 text-xs">
        错误来源：{source}
      </div>
    </div>
  );
};

/**
 * 等待行（连接中）：发送后回复尚未落地时的统一外观。
 *
 * 高度固定 30px（h-7.5），与思考触发行（py-1.5 + 16px 图标 + chevron 的
 * mt-0.5）等高。这一行在首 token 前会被替换两次——线程级占位（还没有
 * 回复消息）→ 消息级占位（消息已建、内容为空）→ 思考触发行。三者必须
 * 同高、同左边界（都在 max-width 内缩进 8px），否则每次替换都会让下面的
 * 内容上下跳一下（发送后「连接中 → 思考」的跳动即此）。
 * 线程级占位与消息级占位共用本组件，连点阵状态和文案都一致，替换时
 * 视觉上是原地切换而不是「一闪而过换了一行」。
 */
export const WaitingRow: FC = () => (
  <span
    data-slot="aui_waiting-row"
    className="text-muted-foreground inline-flex h-7.5 items-center gap-2 align-middle"
  >
    <DotMatrix state="connecting" aria-hidden />
    <span className="text-muted-foreground text-sm">连接中...</span>
  </span>
);

const AssistantWorkingIndicator: FC = () => {
  const isEmpty = useAuiState((s) => s.message.content.length === 0);
  // 随机加载文案：挂载时定一条、每 5 秒换一条。绝不能在 render 里现摇——
  // 父组件 AssistantMessage 未 memo，工具进度/排队数变化都会让它重渲染，
  // 现摇会让这行文案每帧跳字，扫光扫到一半换字观感更糊。
  const [phrase, setPhrase] = useState(randomLoadingPhrase);
  useEffect(() => {
    const t = setInterval(() => setPhrase(randomLoadingPhrase()), 5000);
    return () => clearInterval(t);
  }, []);
  // 重试进行中时不显示（RetryMarker 顶替这条状态行，参照示例 base.tsx）
  if (useRetryState()) return null;
  // 内容为空走等待行（与线程级占位同款，见 WaitingRow 注释）
  if (isEmpty) return <WaitingRow />;
  return (
    <span
      data-slot="aui_assistant-message-indicator"
      className="text-muted-foreground inline-flex h-7.5 items-center gap-2 align-middle"
    >
      {/* 已有内容但模型/工具间隙：加载态点阵 */}
      <DotMatrix state="loading" aria-hidden />
      <span className="text-muted-foreground text-sm">{phrase}</span>
    </span>
  );
};

/**
 * 消息的三种渲染面（折叠用）：
 *  - full（默认）：整条消息——直播、最新轮、展开态都是这一面
 *  - answer：只要「回答」——最后一次动手（工具调用 / 思考）之后的正文（外加
 *    错误占位、产物卡、检查点、停止标记、操作栏）；更早步骤的过程叙述、工具行、
 *    工具成图与压缩/模型切换分隔线都归过程面，不在这里渲染
 *  - process：只要「过程」——工具组/思考/data/成图加上更早步骤的过程叙述
 *    （收起后外面只剩最终回答的由来），不带操作栏，也不带
 *    assistant-message-content 槽位（否则会污染刻度条的预览取值）
 * 折叠轮把轮末消息拆成 process（收进过程面板）+ answer（可见）：投影把一整轮
 * 合并成一条消息，消息里夹着每一步的叙述正文——切分要按「最后一次动手」划界
 * （见 collectProcessTexts），否则收起后摊出的是整轮的过程叙述而不是最终回答。
 * 工具成图归过程面：收起即随过程整块卸载（长轮里的截图很重，折叠态不该解码）。
 */
export type AssistantMessageVariant = "full" | "answer" | "process";

/**
 * 并发成图画廊的组成员宽松形状：画廊按 GroupedParts 的 indices 回查
 * message.parts 成员。联合类型逐字段窄化代价高，这里只碰
 * generate_image / data-image 两类成员实际用到的字段。
 */
type StripMember = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
  data?: PiImagePartData;
  status?: { type?: string };
};

/** 画廊列数：一排最多 5 张，再多则均分两行（6→3+3、7→4+3、9→5+4） */
const imageStripCols = (count: number): number => {
  const rows = Math.ceil(count / 5);
  return rows > 1 ? Math.ceil(count / rows) : count;
};

export const AssistantMessage: FC<{ variant?: AssistantMessageVariant }> = ({
  variant = "full",
}) => {
  // 「已停止」消息（data-stopped part 存在，直播/历史重建同构）：分隔线渲染
  // 在操作栏之下（ActionBar 外面），part 本身不就地渲染
  const stopped = useAuiState(isStoppedMessageState);
  // 「连续输出截断，任务已中止」（data-truncation-stopped part，同款机制）：
  // 自动续跑预算烧到头的截断回复，任务实际停在半路而非正常完成
  const truncationStopped = useAuiState(isTruncationStoppedMessageState);
  const onlyAnswer = variant === "answer";
  const onlyProcess = variant === "process";
  // 尾部分隔线只在答案副本渲染：轮末拆分把同一条消息渲染成 process + answer
  // 两份，process 副本在折叠态本来就不可见，展开后却会和 answer 副本各画一条
  // 「已停止/已截断」。answer（或 full）面画一次即可。
  const showStoppedMarker = stopped && !onlyProcess;
  const showTruncationMarker = truncationStopped && !onlyProcess;
  // 成图画廊按组 indices 回查成员 part：与 GroupedParts 同源取 parts
  // （content 的增强态，带 status/result/data）
  const msgParts = useAuiState((s) => s.message.parts);
  // 本消息是否还在流式（思考块"是否还在进行"要用它，见 group-reasoning）
  const selfRunning = useAuiState((s) => s.message.status?.type === "running");
  // 折叠面切分（full 面不过滤）：更早步骤的过程叙述归过程面，答案面只留
  // 最后一次动手之后的正文。见 collectProcessTexts 的注释。
  const processTexts = useMemo(
    () => (variant === "full" ? null : collectProcessTexts(msgParts)),
    [variant, msgParts],
  );

  const content = (
    <div
      data-slot={
        // process 面刻意不占 assistant-message-content：刻度条的锚点与悬停预览
        // 都按这个槽位取，过程面是不完整内容，占了会把预览取空
        onlyProcess
          ? "aui_assistant-process-content"
          : "aui_assistant-message-content"
      }
      // gap-2 是消息正文**唯一**的 part 间距来源：工具行 / 思考 / 工具组
      // 各自不再带 my-*、工具组内容不再带 gap-*，否则同一个屏里会同时存在
      // 「文字→工具行」和「工具行→工具行」两套距离（实测 33px vs 55px），
      // 节奏全乱。改节奏只改这里一处。
      className="text-foreground flex flex-col gap-2 px-2 leading-relaxed wrap-break-word"
    >
      {/* 重试状态行：只渲染一次，attempt 原地更新（data part 本身就地不渲染） */}
      <MessagePrimitive.GroupedParts
        groupBy={(part) => {
          // 并发成图画廊：generate_image 结果行与其投影的 data-image part
          // （顺序契约恒相邻）并进同一组，成图 ≥2 张时平铺成排。
          // 成图与工具行同属过程面：收起即随过程整块卸载；answer 面不分组
          // （非正文 part 在那一面直接不渲染，分组容器会留下空标题）。
          if (
            !onlyAnswer &&
            part.type === "data" &&
            (part as { name?: string }).name === "image"
          )
            return ["group-images"];
          if (
            !onlyAnswer &&
            part.type === "tool-call" &&
            part.toolName === "generate_image"
          )
            return ["group-images"];
          // answer 面不分组：非正文 part 直接不渲染，分组容器会留下空标题
          if (onlyAnswer) return [];
          if (part.type === "reasoning")
            return ["group-chainOfThought", "group-reasoning"];
          if (part.type === "tool-call") {
            // Task 委派行独立成行，不并入工具折叠组（并行多个各一行）；
            // generate_image 运行中是占位卡片，折叠组装不下大卡
            if (part.toolName === "Task" || part.toolName === "generate_image")
              return [];
            const cat = toolCategory(part.toolName);
            return [
              "group-chainOfThought",
              cat ? `group-tool-${cat}` : "group-tool",
            ];
          }
          return [];
        }}
      >
        {({ part, children }) => {
          // 轮末拆分时的归属：正文归 answer 面；工具成图（data-image）与工具组
          // 同属过程面——收起即随过程整块卸载（长轮里的截图很重，折叠态不该
          // 解码）。错误占位（data-errorAttribution）仍归 answer 面——它是崩溃轮
          // 唯一的内容，归过程面就等于收起后彻底看不见，正是「消息丢了」的观感；
          // 过程面跳过这类，避免展开态出现两份
          const dataName =
            part.type === "data" ? (part as { name?: string }).name : undefined;
          // 压缩分隔线归过程面（不在此列）：它属于「这一轮被压过」的过程记录，
          // 收起态一律不露在外部，展开后在它发生的位置可见（轮末那条同理，
          // 纯分隔线消息不走轮末拆分，见 turn-summary.tsx 的 dividerOnly 分支）
          const onAnswerSide =
            part.type === "text" || dataName === "errorAttribution";
          // 过程叙述（更早步骤里的正文）：归过程面——收起后外层只剩最终回答，
          // 叙述随工具行/思考一起收进过程区。只有正文与错误占位参与 answer 面
          // 的归属判断（见上）
          const foldedText =
            processTexts !== null && part.type === "text" && processTexts.has(part);
          // 显式返回空 fragment：`return null` 会落到 DefaultPartFallback，
          // 把注册的数据 UI（compaction 横幅 / 工具成图）又渲染回来——两个面
          // 就各出现一份。这里要的是「这一面确实不画」
          if (onlyProcess && onAnswerSide && !foldedText) return <></>;
          // answer 面只保留回答正文与错误占位；工具/思考/成图/其他 data 归过程面
          if (onlyAnswer && (!onAnswerSide || foldedText)) return <></>;
          switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
              case "group-tool-terminal":
              case "group-tool-inspect":
              case "group-tool-modify":
              case "group-tool-browser":
                return (
                  <ToolGroupSection
                    indices={part.indices}
                    active={part.status.type === "running"}
                    category={
                      part.type === "group-tool-terminal"
                        ? "terminal"
                        : part.type === "group-tool-inspect"
                          ? "inspect"
                          : part.type === "group-tool-modify"
                            ? "modify"
                            : part.type === "group-tool-browser"
                              ? "browser"
                              : undefined
                    }
                  >
                    {children}
                  </ToolGroupSection>
                );
              case "group-reasoning": {
                // 思考是否还在进行：三个信号取合取，任一说"已结束"就收拢——
                //  1) 组状态：思考 part 还在跑（库按"是否消息最后一个 part"折算）；
                //  2) 结构：思考组之后是否已有新内容落地（新 part 一出现即思考结束）；
                //  3) 本消息是否还在流式（回合收尾/中止时也要收回）。
                // 只信组状态不够：折算链上任一环不新鲜（状态数组、分组聚合），块就会
                // 一直挂着不折叠——2026-10 实测反馈「思考完了没折起来」即此形。
                const running = part.status.type === "running";
                const lastIndex = part.indices[part.indices.length - 1] ?? -1;
                const trailing = lastIndex === msgParts.length - 1;
                const streaming = running && trailing && selfRunning;
                return (
                  // streaming：思考进行中保持展开（正文底部吸附，跟最新一句），
                  // 思考结束自动收拢；用户手动开合过则永久接管（ReasoningRoot
                  // 内部语义）。不传 defaultOpen——静止态必须收起，否则收不回来
                  <ReasoningRoot variant="ghost" streaming={streaming}>
                    <ReasoningTrigger active={streaming} />
                    <ReasoningContent aria-busy={streaming}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "group-images": {
                const members = part.indices
                  .map((i) => msgParts[i] as unknown as StripMember | undefined)
                  .filter((m): m is StripMember => m != null);
                const imgMembers = members.filter((m) => m.type === "data");
                // 生成中的占位行（并发/批量调用的对等面）：结果未回即生成中。
                // "生成前后都能并排"：图没出来时多个占位卡也平铺成排
                const runningOf = (m: StripMember) =>
                  m.type === "tool-call" &&
                  m.result === undefined &&
                  m.status?.type !== "incomplete";
                const runningCount = members.filter(runningOf).length;
                // 单张不成廊且没有两三个占位可对：原样平铺（结果行 + 图卡竖排，
                // 保留展开保存路径的入口）
                if (imgMembers.length < 2 && runningCount < 2)
                  return <>{children}</>;
                // 配对不能靠相邻：直播里 tool part 按发起顺序占位、图按完成顺序
                // 追加，并发时交错（[行A,行B,图A,图B]）；结果行 ↔ 成图按
                // PiImagePartData.toolCallId 认亲
                const rowById = new Map<string, StripMember>();
                const imgCallIds = new Set<string>();
                const imgTotalById = new Map<string, number>();
                for (const m of members) {
                  if (m.type === "tool-call" && m.toolCallId)
                    rowById.set(m.toolCallId, m);
                  else if (m.type === "data" && m.data?.toolCallId) {
                    const id = m.data.toolCallId;
                    imgCallIds.add(id);
                    imgTotalById.set(id, (imgTotalById.get(id) ?? 0) + 1);
                  }
                }
                // 成功行收进瓦片（结果首行做题注，悬停看全文含保存路径）；
                // 婉拒/失败行独立成行竖排；生成中占位横排成组
                const extraRows: ReactNode[] = [];
                const runningRows: ReactNode[] = [];
                const cells: {
                  key: number;
                  data: PiImagePartData;
                  headline: string;
                  full?: string;
                }[] = [];
                const seqSeen = new Map<string, number>();
                members.forEach((m, j) => {
                  if (m.type === "data" && m.data) {
                    const res = m.data.toolCallId
                      ? rowById.get(m.data.toolCallId)?.result
                      : undefined;
                    const text =
                      typeof res === "string"
                        ? res
                        : res && typeof res === "object"
                          ? JSON.stringify(res)
                          : undefined;
                    let headline =
                      text?.split("\n")[0] || m.data.alt || "图片";
                    // 同一次调用（n 批量）出的多张共享同一题注：补 k/N 序号
                    const id = m.data.toolCallId;
                    const total = id ? imgTotalById.get(id) ?? 1 : 1;
                    if (id && total > 1) {
                      const k = (seqSeen.get(id) ?? 0) + 1;
                      seqSeen.set(id, k);
                      headline += ` · ${k}/${total}`;
                    }
                    cells.push({ key: j, data: m.data, headline, full: text });
                  } else if (m.type === "tool-call" && !onlyAnswer) {
                    const Row = resolveToolUI(m.toolName ?? "");
                    if (!Row) return;
                    const node = (
                      <Row
                        key={m.toolCallId ?? String(j)}
                        {...(msgParts[part.indices[j]] as ToolCallMessagePartProps)}
                      />
                    );
                    const paired =
                      !!m.toolCallId && imgCallIds.has(m.toolCallId);
                    if (runningOf(m)) runningRows.push(node);
                    // 成功成对行的题注已进瓦片，不再独立成行；
                    // 但单瓦片（批量刚回一半）时保留行，别丢展开入口
                    else if (!paired || imgMembers.length < 2)
                      extraRows.push(node);
                  }
                });
                return (
                  <>
                    {extraRows}
                    {runningRows.length > 0 && (
                      <div
                        data-slot="aui_image-strip-running"
                        className="my-1.5 flex flex-wrap items-start gap-2"
                      >
                        {runningRows}
                      </div>
                    )}
                    {cells.length > 0 && (
                      <div
                        data-slot="aui_image-strip"
                        className="my-1.5 grid gap-2"
                        style={{
                          gridTemplateColumns: `repeat(${imageStripCols(cells.length)}, minmax(0, 1fr))`,
                        }}
                      >
                        {cells.map((c) => (
                          <div key={c.key} className="min-w-0">
                            <ImagePartCard data={c.data} compact />
                            <div
                              className="text-muted-foreground truncate text-xs"
                              title={c.full}
                            >
                              {c.headline}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call": {
                // todo 不渲染；Question 已答以折叠条目留痕（提问中归 composer 卡片）；
                // plan_exit 结束后同样留痕：批准 / 拒绝理由 / 未填理由停止
                if (part.toolName === "Question") return <QuestionToolRow {...part} />;
                if (part.toolName === "plan_exit") return <PlanExitToolRow {...part} />;
                if (HIDDEN_TOOL_NAMES.has(part.toolName)) return null;
                // 内置四类工具走扁平行（点开面板）；其余保留注册 UI / 回退卡
                const Row = resolveToolUI(part.toolName);
                const rendered = Row ? (
                  <Row {...part} />
                ) : (
                  part.toolUI ?? <ToolFallback {...part} />
                );
                return (
                  <ToolCallMetaProvider value={toolCallMetaFromPart(part)}>
                    {rendered}
                  </ToolCallMetaProvider>
                );
              }
              case "indicator":
                return <AssistantWorkingIndicator />;
              case "data":
                // 崩溃轮的错误占位必须常显：它就是那条消息唯一的内容
                if ((part as { name?: string }).name === "errorAttribution")
                  return <TurnErrorCard data={(part as { data?: unknown }).data} />;
                return part.dataRendererUI;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        {/* 来源条/产物卡/检查点/错误/重试只归 answer 面（过程面重复渲染会出两套卡片） */}
        {!onlyProcess && (
          <>
            {/* 来源条：本轮 WebSearch/WebFetch 引用的 favicon 堆叠（贴正文，产物卡之前） */}
            <MessageSources />
            {/* 消息尾部产物卡：agent 用 write 产出的交付文件（HTML 报告/文档等） */}
            <MessageArtifacts />
            {/* 检查点卡：本轮 git 改动的汇总与撤销入口，隶属消息本体（操作栏之上） */}
            <MessageCheckpoint />
            <MessageError />
            <RetryMarker />
          </>
        )}
      </div>
  );

  // 过程面：不带消息根（避免同一消息出现两个 data-message-id / 重复注册
  // 顶锚点），也不带操作栏——它就是折叠轮里那块被收起的内容
  if (onlyProcess) {
    return (
      <div className="aui-assistant-message-root mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 pl-0">
        {content}
      </div>
    );
  }

  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="aui-assistant-message-root mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 pl-0 relative"
    >
      <MessageSelectToggle />
      {content}

      <div
        data-slot="aui_assistant-message-footer"
        className={cn(
          "relative ml-2 min-h-7.5 overflow-visible",
          // 常态：操作栏悬浮在消息间隙（负 margin 折叠占位）；带尾部分隔线的
          // 消息（已停止 / 连续输出截断）要给它留出真实高度，分隔线才能排到
          // 操作栏下方——漏算任一标记，分隔线就会和操作栏叠在一起
          !showStoppedMarker && !showTruncationMarker && "h-7.5 -mb-7.5",
        )}
      >
        <div className="absolute inset-x-0 top-0 flex h-7.5 items-center pt-1.5  my-4 mt-2">
          <AssistantActionBar />
        </div>
      </div>
      {showStoppedMarker && (
        <div className="ml-2">
          <StoppedMarker />
        </div>
      )}
      {showTruncationMarker && (
        <div className="ml-2">
          <TruncationStoppedMarker />
        </div>
      )}
    </MessagePrimitive.Root>
  );
};

/** 「···」菜单项共用的样式（导出/分叉同款） */
const MORE_ITEM_CLASS =
  "aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none";

/** 「分享此条」：以当前消息为唯一选中项进入分享选择模式 */
const ShareMessageItem: FC = () => {
  const messageId = useAuiState((s) => s.message.id);
  if (!messageId) return null;
  return (
    <ActionBarMorePrimitive.Item
      className={MORE_ITEM_CLASS}
      onClick={() => enterShareMode([messageId])}
    >
      <Share2Icon size="1em" className="size-4" />
      分享此条
    </ActionBarMorePrimitive.Item>
  );
};

/** 「存为笔记」：把本轮回答写进资料库（按来源项目分文件夹，带 frontmatter） */
const SaveNoteItem: FC = () => {
  const text = useAuiState((s) =>
    s.message.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n")
      .trim(),
  );
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const cwd = useWorkspace();
  const [saving, setSaving] = useState(false);
  if (!text) return null;
  const save = () => {
    // 点击时再查 map：会话摘要可能在组件首次渲染之后才到达，闭包里烘死
    // 的 cwd/project 会漏掉新会话
    const sessionId = threadId ? piSessionIdForThread(threadId) : undefined;
    const noteCwd =
      (sessionId ? piSessionCwdMap.get(sessionId) : undefined) ?? cwd;
    const noteProjectCwd = sessionId
      ? piSessionProjectMap.get(sessionId)
      : undefined;
    setSaving(true);
    void saveNoteFromText({
      text,
      cwd: noteCwd,
      projectCwd: noteProjectCwd,
      sessionId,
    }).finally(() => setSaving(false));
  };
  return (
    <ActionBarMorePrimitive.Item
      className={MORE_ITEM_CLASS}
      disabled={saving}
      onClick={() => {
        if (!saving) save();
      }}
    >
      <NotebookPenIcon size="1em" className="size-4" />
      存为笔记
    </ActionBarMorePrimitive.Item>
  );
};

/**
 * 「分叉会话」（··· 更多操作菜单）：以本条消息为锚点把会话一分为二——新
 * 会话包含到这条消息为止的历史（同回合的工具收尾行由 sidecar 延展带上），
 * 下方的后续轮次不带入。锚点取投影稳定 id `pi-msg:<seq>`：未落盘的乐观
 * 消息（下标回退/乐观前缀 id）无从定位转录行，未绑定 sidecar 会话的本地
 * 草稿同理，两种情况都不显示入口。
 */
const ForkSessionItem: FC = () => {
  const messageId = useAuiState((s) => s.message.id);
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const [forking, setForking] = useState(false);
  const remoteId = threadId ? piSessionIdForThread(threadId) : undefined;
  const anchorSeq = /^pi-msg:(\d+)$/.exec(messageId ?? "")?.[1];
  if (!remoteId || !anchorSeq) return null;
  const fork = async () => {
    if (forking) return;
    setForking(true);
    try {
      const newId = await forkPiSession(remoteId, {
        upToSeq: Number(anchorSeq),
      });
      // 走 open-session 总线：base 壳统一 reload 列表后切到新会话
      requestOpenSession(newId);
    } catch (err) {
      toast.add({
        title: "分叉会话失败",
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    } finally {
      setForking(false);
    }
  };
  return (
    <ActionBarMorePrimitive.Item
      className={MORE_ITEM_CLASS}
      disabled={forking}
      onClick={() => void fork()}
    >
      <GitBranchIcon size="1em" className="size-4" />
      分叉会话
    </ActionBarMorePrimitive.Item>
  );
};

const AssistantActionBar: FC = () => {
  // 纯分隔线消息（如历史重建的压缩分隔线）：不展示复制/重载等操作
  const dividerOnly = useAuiState(
    (s) =>
      s.message.content.length > 0 &&
      s.message.content.every((p) => p.type === "data"),
  );
  // 只隐藏「本条消息还在流式输出」的操作栏；其他 turn 在跑不影响已完成
  // 消息的 ActionBar（排队/并行场景下每条已结束的对话都是独立可操作的）
  const selfRunning = useAuiState((s) => s.message.status?.type === "running");
  // 一轮回复会被拆成多条 assistant 消息（每次工具调用后继续生成都是新的
  // 一条），autohide 只认「线程最后一条」——中间消息 hover 时仍各自冒出
  // 操作栏。这里收紧为：仅「本轮收尾」的消息（跳过尾部压缩/模型切换分隔线
  // 之后，到下一条 user 之前没有别的正文）才挂操作栏，一轮只有一个。
  // 定位走缓存索引（O(1) 查表）：选择器在流式期间每次 store 通知都会对每条
  // 消息重跑，全量 findIndex 在长会话里是 O(消息数²)/chunk 的隐形热点
  const isTurnEnd = useAuiState((s) =>
    isTurnEndMessage(s.thread.messages, String(s.message.id)),
  );
  // 最新一轮的答案常显：assistant-ui 的 autohide 只认字面最后一条，尾部有
  // 压缩/模型切换分隔线时答案不是最后一条，沿用 not-last 会退化成悬停才出。
  // 更早的轮保持 not-last（悬停显示，一轮只有一个操作栏的既有口径）。
  const isLastTurn = useAuiState((s) => {
    const slot = parseTurnSlot(
      packTurnSlot(s.thread.messages, String(s.message.id)),
    );
    return slot?.isLastTurn ?? false;
  });
  if (dividerOnly || selfRunning || !isTurnEnd) return null;
  return (
    <ActionBarPrimitive.Root
      autohide={isLastTurn ? "never" : "not-last"}
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ml-1 my-4 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon
              size="1em"
              className="animate-in zoom-in-50 fade-in duration-200 ease-out"
            />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon
              size="1em"
              className=" animate-in zoom-in-75 fade-in duration-150"
            />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="刷新">
          <RefreshCwIcon size="1em" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="更多操作"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon size="1em" />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <SaveNoteItem />
          <ForkSessionItem />
          <ShareMessageItem />
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className={MORE_ITEM_CLASS}>
              <DownloadIcon size="1em" className="size-4" />
              导出为 Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
      {/* <MessageTiming /> */}
    </ActionBarPrimitive.Root>
  );
};