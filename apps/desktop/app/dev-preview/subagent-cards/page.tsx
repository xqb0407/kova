"use client";

/**
 * 【校对页】子智能体委派卡片（先看形态，不接 sidecar）：
 * /dev-preview/subagent-cards
 *
 * 跑法：cd apps/desktop && bun run dev →
 *      http://localhost:3000/dev-preview/subagent-cards
 *
 * 校对点：
 * - 单卡：32px 头像块 / agent 名 / 模型 / 状态胶囊 / 工具图标 + 两行任务
 *   描述 / 底部「$0.08 · 4s」的层次与留白；
 * - 并行组：左侧导轨 + 横向肘线是否读得出「同一轮派出的多个子任务」；
 * - 状态色：运行中（蓝）、已完成（绿）、失败（红）、轮次超限（琥珀）、
 *   中止/停止/中断（灰）、启动失败（红框 + 原因）；
 * - 参考图形状：顶部 orchestrator + 下方三张子卡（仅预览，不用于消息流）。
 */

import { useEffect, useState, type FC, type ReactNode } from "react";
import {
  DelegationCardView,
  DelegationGroup,
  DelegationMotionStyle,
  type DelegationCardStatus,
} from "@/components/assistant-ui/elements/delegation-card.aui";

const Section: FC<{
  title: string;
  hint?: string;
  children: ReactNode;
}> = ({ title, hint, children }) => (
  <section className="flex flex-col gap-3">
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint ? (
        <p className="text-muted-foreground mt-0.5 text-xs leading-5">{hint}</p>
      ) : null}
    </div>
    {children}
  </section>
);

const STATUS_CASES: {
  status: DelegationCardStatus;
  agentName: string;
  description: string;
}[] = [
  { status: "starting", agentName: "Planner", description: "拆解需求并列出验收标准" },
  { status: "running", agentName: "Researcher", description: "对比六家竞品的年费折扣" },
  { status: "completed", agentName: "Writer", description: "起草开关文案与三条 FAQ" },
  { status: "failed", agentName: "Scraper", description: "抓取三家定价页" },
  { status: "truncated", agentName: "Analyst", description: "归档 140 条支持工单" },
  { status: "aborted", agentName: "Coder", description: "把年付价格接入结算页" },
  { status: "stopped", agentName: "Tester", description: "跑两个计费周期的结账测试" },
  { status: "interrupted", agentName: "Reviewer", description: "审查计费开关的回归风险" },
  { status: "dispatched", agentName: "Explorer", description: "探索消息与工具渲染管线" },
  { status: "expired", agentName: "Archivist", description: "整理历史运行记录" },
];

export default function SubagentCardsDevPreview() {
  // 重播：整块内容重挂载，连线重新生长、数字重新从 0 滚到目标值
  const [replay, setReplay] = useState(0);
  // 实时卡片：用时每秒 +1；每 4 秒再加一轮，观察数字持续滚动
  const [liveSeconds, setLiveSeconds] = useState(3);
  const [liveTurns, setLiveTurns] = useState(2);
  useEffect(() => {
    let tick = 0;
    const timer = window.setInterval(() => {
      tick += 1;
      setLiveSeconds((s) => s + 1);
      if (tick % 4 === 0) setLiveTurns((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <main className="bg-background text-foreground min-h-screen">
      <DelegationMotionStyle />
      <div key={replay} className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-10">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-lg font-semibold">子智能体委派卡片</h1>
            <p className="text-muted-foreground text-sm leading-6">
              消息流里 <code className="font-mono text-xs">Task</code>{" "}
              委派的新外观。当前页只用夹具，不读运行 store，也不改真实消息流。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReplay((v) => v + 1)}
            className="border-border/60 bg-background hover:bg-muted/40 focus-visible:ring-ring/40 shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            重播动效
          </button>
        </header>

        <Section
          title="单张卡片"
          hint="完整数据：模型、迭代轮次、任务描述、运行用时。"
        >
          <DelegationCardView
            className="w-full max-w-sm"
            agentName="Researcher"
            modelLabel="Claude Sonnet 4"
            description="Compare annual discounts across six rivals"
            status="running"
            turns={3}
            elapsedSeconds={3}
          />
        </Section>

        <Section
          title="数字实时滚动"
          hint="用时每秒 +1；每 4 秒再加一轮迭代。观察「3 轮 · 12s」逐位滚动到新值。"
        >
          <DelegationCardView
            className="w-full max-w-sm"
            agentName="Analyst"
            modelLabel="Claude Sonnet 4"
            description="Group 140 support tickets that mention billing"
            status="running"
            turns={liveTurns}
            elapsedSeconds={liveSeconds}
          />
        </Section>

        <Section
          title="并行委派组"
          hint="同一轮相邻的多个 Task 聚成一组：左侧母线 + 每张卡一条分支。灰色底轨常驻；派活时蓝线从母线送进各卡，不沿兄弟卡上下串联（子代理不能互相调用）。"
        >
          <DelegationGroup className="max-w-sm" defaultOpen>
            <DelegationCardView
              agentName="Researcher"
              modelLabel="Claude Sonnet 4"
              description="Compare annual discounts across six rivals"
              status="running"
              turns={3}
              elapsedSeconds={3}
            />
            <DelegationCardView
              agentName="Writer"
              modelLabel="GPT-5 mini"
              description="Draft the toggle copy and three FAQ answers"
              status="completed"
              turns={2}
              elapsedSeconds={8}
            />
            <DelegationCardView
              agentName="Coder"
              modelLabel="Kimi K2"
              description="Add the toggle and yearly prices to checkout"
              status="queued"
              turns={0}
              elapsedSeconds={0}
            />
          </DelegationGroup>
        </Section>

        <Section
          title="只派出一个 Agent"
          hint="消息流里只有一个 Task 时不成组、不画母线，只有一张卡；树形视图里是一条从主卡到子卡的竖线。"
        >
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-xs">消息流形态</span>
              <DelegationGroup className="max-w-sm" defaultOpen>
                <DelegationCardView
                  agentName="Researcher"
                  modelLabel="Claude Sonnet 4"
                  description="Compare annual discounts across six rivals"
                  status="running"
                  turns={3}
                  elapsedSeconds={3}
                />
              </DelegationGroup>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-xs">树形形态</span>
              <div className="flex flex-col items-center">
                <div
                  className="aui-delegation-card-in w-full max-w-xs"
                  style={{ animationDelay: "0ms" }}
                >
                  <DelegationCardView
                    agentName="Orchestrator"
                    modelLabel="Atlas 4"
                    description="Ship the annual billing toggle this week"
                    status="running"
                    turns={4}
                    elapsedSeconds={4}
                  />
                </div>
                <div
                  aria-hidden
                  className="relative h-8 w-2 overflow-hidden"
                >
                  <span className="bg-border absolute inset-y-0 left-1/2 w-px -translate-x-1/2" />
                  <span
                    className="aui-delegation-fill-y bg-blue-500 absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
                    style={{ animationDelay: "120ms" }}
                  />
                </div>
                <div
                  className="aui-delegation-card-in w-full max-w-xs"
                  style={{ animationDelay: "260ms" }}
                >
                  <DelegationCardView
                    agentName="Researcher"
                    modelLabel="Nimbus Pro"
                    description="Compare annual discounts across six rivals"
                    status="running"
                    turns={3}
                    elapsedSeconds={3}
                  />
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="状态全览"
          hint="运行中/已完成/失败之外，中止、停止、中断都走中性灰；轮次超限走琥珀。"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {STATUS_CASES.map((item) => (
              <DelegationCardView
                key={item.status}
                agentName={item.agentName}
                modelLabel="Claude Sonnet 4"
                description={item.description}
                status={item.status}
                turns={item.status === "starting" ? 0 : 3}
                elapsedSeconds={item.status === "starting" ? 0 : 12}
              />
            ))}
          </div>
        </Section>

        <Section
          title="启动失败"
          hint="sidecar 返回原因文本（无 delegationId）时：红色状态胶囊 + 卡内原因，不可点开面板。"
        >
          <DelegationCardView
            className="w-full max-w-sm"
            agentName="Explore"
            modelLabel="继承会话模型"
            description="探索消息与工具渲染管线"
            status="failed"
            turns={2}
            errorText={
              "3 subagent(s) are running (limit 3). Wait for some with TaskWait or stop them with TaskStop before delegating more."
            }
          />
        </Section>

        <Section
          title="参考图形状（仅预览）"
          hint="灰色底轨常驻；派活时蓝线从主卡沿主干、母线、分支画到子卡。真实消息流不会画 orchestrator 卡，这里只用于比较布局。"
        >
          <div className="flex flex-col items-center">
            <div
              className="aui-delegation-card-in w-full max-w-xs"
              style={{ animationDelay: "0ms" }}
            >
              <DelegationCardView
                agentName="Orchestrator"
                modelLabel="Atlas 4"
                description="Ship the annual billing toggle this week"
                status="running"
                turns={4}
                elapsedSeconds={4}
              />
            </div>
            <div className="relative w-full">
              {/* 主干：灰色底轨常驻，蓝线从上往下画到母线 */}
              <div
                aria-hidden
                className="absolute top-0 left-1/2 hidden h-4 w-2 -translate-x-1/2 overflow-hidden md:block"
              >
                <span className="bg-border absolute inset-y-0 left-1/2 w-px -translate-x-1/2" />
                <span
                  className="aui-delegation-fill-y bg-blue-500 absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
                  style={{ animationDelay: "120ms" }}
                />
              </div>
              {/* 横向母线：灰轨常驻，蓝线从中心向两侧画开 */}
              <span
                aria-hidden
                className="absolute top-4 hidden h-px md:block"
                style={{
                  left: "calc(16.6667% - 0.333333rem)",
                  right: "calc(16.6667% - 0.333333rem)",
                }}
              >
                <span className="bg-border absolute inset-0" />
                <span
                  className="aui-delegation-fill-x-center bg-blue-500 absolute inset-0"
                  style={{ animationDelay: "520ms" }}
                />
              </span>
              <div className="grid grid-cols-1 gap-4 pt-8 md:grid-cols-3">
                {[
                  {
                    agentName: "Researcher",
                    modelLabel: "Nimbus Pro",
                    description: "Compare annual discounts across six rivals",
                    turns: 3,
                    elapsedSeconds: 3,
                    status: "running" as const,
                  },
                  {
                    agentName: "Writer",
                    modelLabel: "Atlas 4 Mini",
                    description: "Draft the toggle copy and three FAQ answers",
                    turns: 2,
                    elapsedSeconds: 8,
                    status: "completed" as const,
                  },
                  {
                    agentName: "Coder",
                    modelLabel: "Kite Pro",
                    description: "Add the toggle and yearly prices to checkout",
                    turns: 0,
                    elapsedSeconds: 0,
                    status: "queued" as const,
                  },
                ].map((item, index) => (
                  <div
                    key={item.agentName}
                    className="aui-delegation-card-in relative"
                    style={{ animationDelay: `${280 + index * 70}ms` }}
                  >
                    {/* 分支：灰轨常驻，蓝线自上而下画到子卡 */}
                    <div
                      aria-hidden
                      className="absolute -top-4 left-1/2 hidden h-4 w-2 -translate-x-1/2 overflow-hidden md:block"
                    >
                      <span className="bg-border absolute inset-y-0 left-1/2 w-px -translate-x-1/2" />
                      <span
                        className="aui-delegation-fill-y bg-blue-500 absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
                        style={{ animationDelay: `${820 + index * 160}ms` }}
                      />
                    </div>
                    <DelegationCardView {...item} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <footer className="text-muted-foreground/70 border-t pt-4 text-xs leading-5">
          校对完这版形态后，再把 <code className="font-mono">TaskToolUI</code>{" "}
          换成卡片、并补 sidecar 的 modelId 下发。
        </footer>
      </div>
    </main>
  );
}
