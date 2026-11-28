"use client";

/**
 * 【校对页】真实消息流里的 Task 委派卡：/dev-preview/task-cards
 *
 * 跑法：cd apps/desktop && bun run dev →
 *      http://localhost:3000/dev-preview/task-cards
 *
 * 与 /dev-preview/subagent-cards 的区别：这里走真正的 AssistantMessage →
 * GroupedParts → resolveToolUI 链路，验证 Task 卡在消息里的实际排版：
 * - 并行两个 Task：相邻聚成「并行委派 · 2」，左侧母线 + 分支蓝线；
 * - 只派一个：DelegationGroup 退化成单卡，无组头/母线；
 * - 启动失败：Task 结果没有 delegationId，红色错误卡 + 卡内原因。
 *
 * 没有 sidecar 通道，所以卡片状态停在「已派发」、模型行不显示；真实运行时会
 * 由 data-subagentDelegation 补上 modelId/活动流。
 */
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useLocalRuntime,
} from "@assistant-ui/react";
import type { ChatModelAdapter, ThreadMessageLike } from "@assistant-ui/react";
import { AssistantMessage } from "@/components/agent-thread/assistant-message";
import { UserMessage } from "@/components/agent-thread/user-message";

const now = Date.now();

const text = (t: string) => ({ type: "text" as const, text: t });
const task = (
  id: string,
  agent: string,
  description: string,
  result: string,
) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: "Task",
  args: {
    agent,
    description,
    task: `${description}。请给出结论与来源。`,
  },
  argsText: JSON.stringify({ agent, description }),
  result,
});

const MESSAGES: readonly ThreadMessageLike[] = [
  {
    id: "u1",
    role: "user",
    content: [text("让两个子代理并行整理竞品年费和开关文案")],
    createdAt: new Date(now - 90_000),
  },
  {
    id: "a1",
    role: "assistant",
    content: [
      text("我先派两个子任务并行处理。"),
      task(
        "t1",
        "Researcher",
        "对比六家竞品的年费折扣",
        "Delegation deadbeef started",
      ),
      task(
        "t2",
        "Writer",
        "起草开关文案与三条 FAQ",
        "Delegation cafebabe started",
      ),
      text("两个子任务已经派出去了。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  {
    id: "u2",
    role: "user",
    content: [text("只派一个子代理确认下 checkout 里的价格")],
    createdAt: new Date(now - 60_000),
  },
  {
    id: "a2",
    role: "assistant",
    content: [
      text("好，只派一个。"),
      task(
        "t3",
        "Coder",
        "确认 checkout 里年付价格的位置",
        "Delegation feedface started",
      ),
      text("已派出。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  {
    id: "u3",
    role: "user",
    content: [text("再试一次超过并发上限的委派")],
    createdAt: new Date(now - 30_000),
  },
  {
    id: "a3",
    role: "assistant",
    content: [
      text("这次会被 sidecar 拒绝。"),
      task(
        "t4",
        "Explore",
        "探索消息与工具渲染管线",
        "3 subagent(s) are running (limit 3). Wait for some with TaskWait or stop them with TaskStop before delegating more.",
      ),
      text("sidecar 返回了错误原因。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
];

const noopChatModel: ChatModelAdapter = {
  async *run() {
    /* 校对页不跑真实对话 */
  },
};

export default function TaskCardsDevPreview() {
  const runtime = useLocalRuntime(noopChatModel, {
    initialMessages: [...MESSAGES],
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="bg-background text-foreground flex h-screen flex-col">
        <div className="text-muted-foreground border-b px-3 py-1.5 text-xs">
          Task 委派卡 · 真实消息流 harness
        </div>
        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            turnAnchor="top"
            className="relative flex flex-1 flex-col overflow-x-clip overflow-y-scroll px-4 pt-4"
          >
            <div className="mx-auto mb-14 flex w-full max-w-3xl flex-col gap-y-6">
              <ThreadPrimitive.Messages>
                {({ message }) =>
                  message.role === "user" ? <UserMessage /> : <AssistantMessage />
                }
              </ThreadPrimitive.Messages>
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}