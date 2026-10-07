"use client";

/**
 * 【临时预览页，测完可删】工作流编排图的样式检查台：
 * 用真实卡片组件 + 固定 fixture 渲染三种状态的图（提案 / 运行中 / 失败），
 * 供 Playwright 截图做视觉验收（节点配色、连线、徽标、闸门命令 chip）。
 * 不连 sidecar：卡片是纯 props 组件，点节点才会走详情 RPC（这里不点）。
 */

import { useState } from "react";
import {
  WorkflowConfirmPanel,
  WorkflowPlanCard,
  WorkflowRunCard,
  WorkflowStepDrawer,
} from "@/components/agent-thread/workflow-cards";
import type { WorkflowSnapshot, WorkflowStepState, WorkflowStepView } from "@/lib/pi/pi-workflow";
import type { WorkflowStepDetail } from "pi-protocol";

const steps: WorkflowStepView[] = [
  { key: "scope", kind: "delegate", phase: "需求", title: "明确研究对象，输出研究简报", agent: "Explorer", dependsOn: [] },
  { key: "market", kind: "delegate", phase: "调研", title: "行业与市场宏观调研", agent: "Explorer", dependsOn: ["scope"] },
  { key: "competitors", kind: "delegate", phase: "调研", title: "竞品扫描，产出竞品名单", agent: "Explorer", dependsOn: ["scope"] },
  { key: "competitor-dive", kind: "delegate", phase: "调研", title: "逐家竞品深挖", agent: "Explorer", dependsOn: ["competitors"] },
  { key: "users", kind: "delegate", phase: "调研", title: "用户与需求分析", agent: "Explorer", dependsOn: ["scope"], foreach: { from: "competitors" } },
  { key: "gate-materials", kind: "gate", phase: "质检", title: "检查调研材料是否齐备", dependsOn: [], gate: { command: "test", args: ["-f", "research/brief.md", "-a", "-f", "research/market.md", "-a", "-d", "research/competitors"] }, timeoutMs: 120_000 },
  { key: "report", kind: "delegate", phase: "撰写", title: "撰写市场调研报告初稿", agent: "Fixer", dependsOn: ["gate-materials"] },
  { key: "verify-report", kind: "verify", phase: "质检", title: "对抗性审查报告初稿", dependsOn: ["report"], verify: { reviewers: 2, threshold: 0.5 } },
  { key: "finalize", kind: "synthesize", phase: "交付", title: "汇总生成最终调研报告", dependsOn: ["scope", "market", "competitors", "competitor-dive", "users", "verify-report"] },
];

const state = (key: string, status: WorkflowStepState["status"], extra: Partial<WorkflowStepState> = {}): WorkflowStepState => ({ key, status, ...extra });

const proposed: WorkflowSnapshot = {
  id: "wf-preview-proposed",
  objective: "产出一份市场调研报告",
  status: "proposed",
  statusLine: "剧本待你确认",
  title: "市场调研报告工作流剧本",
  steps,
  stepStates: steps.map((s) => state(s.key, "pending")),
  tokensUsed: 0,
  startedAt: Date.now(),
  updatedAt: Date.now(),
};

const running: WorkflowSnapshot = {
  ...proposed,
  id: "wf-preview-running",
  status: "running",
  statusLine: "运行中 4/9 步(并发 2)",
  tokensUsed: 41_200,
  stepStates: [
    state("scope", "done", { tokens: 3200, endedAt: Date.now() - 90_000 }),
    state("market", "done", { tokens: 9800, endedAt: Date.now() - 40_000 }),
    state("competitors", "running", { startedAt: Date.now() - 42_000, delegationId: "d-1" }),
    state("competitor-dive", "running", { startedAt: Date.now() - 12_000 }),
    state("users", "running", { startedAt: Date.now() - 12_000 }),
    state("gate-materials", "pending"),
    state("report", "pending"),
    state("verify-report", "pending"),
    state("finalize", "pending"),
  ],
};

const failed: WorkflowSnapshot = {
  ...proposed,
  id: "wf-preview-failed",
  status: "failed",
  statusLine: "运行失败",
  stepStates: [
    state("scope", "interrupted", { startedAt: Date.now() - 30_000 }),
    state("gate-materials", "failed", {
      endedAt: Date.now() - 20_000,
      error: "gate command exited 1: [exit code: 1]",
    }),
    state("market", "pending"),
    state("competitors", "pending"),
    state("competitor-dive", "pending"),
    state("users", "pending"),
    state("report", "pending"),
    state("verify-report", "pending"),
    state("finalize", "pending"),
  ],
};

const proposing: WorkflowSnapshot = {
  id: "wf-preview-proposing",
  objective: "产出一份市场调研报告",
  status: "proposing",
  statusLine: "编排中:正在拟剧本",
  tokensUsed: 0,
  startedAt: Date.now(),
  updatedAt: Date.now(),
};

/** 抽屉的两种典型内容:delegate(任务+产出+打开委派)与 gate(命令+判定) */
const delegateDetail: WorkflowStepDetail = {
  key: "competitors",
  kind: "delegate",
  title: "竞品扫描，产出竞品名单",
  status: "done",
  phase: "调研",
  agent: "Explorer",
  prompt:
    "先读 research/brief.md，为行业={{args.行业}}、目标市场={{args.目标市场}}选出 3-5 个最直接的竞品（按「直接竞品优先、覆盖不同定位」原则）。选择理由写入 research/competitor-list.md（含落选候选与理由）。你的最终回答只输出竞品名单：一行一个竞品名称（纯名称，不带编号），供后续逐家深挖步骤使用。",
  timeoutMs: 1_200_000,
  startedAt: Date.now() - 240_000,
  endedAt: Date.now() - 61_000,
  tokens: 9_800,
  delegationId: "d-preview-1",
  result: "1. Figma\n2. Sketch\n3. Adobe XD\n4. Penpot\n5. 即时设计",
};

const gateDetail: WorkflowStepDetail = {
  key: "gate-materials",
  kind: "gate",
  title: "检查调研材料是否齐备",
  status: "failed",
  phase: "质检",
  prompt: "校验四份调研材料是否齐备；缺任何一项则整轮调研失败。",
  gate: {
    command: "test",
    args: ["-f", "research/brief.md", "-a", "-f", "research/market.md", "-a", "-d", "research/competitors"],
  },
  timeoutMs: 120_000,
  startedAt: Date.now() - 30_000,
  endedAt: Date.now() - 20_000,
  result: "gate command exited 1: [exit code: 1]",
};

const proposedWithArgs: WorkflowSnapshot = {
  ...proposed,
  id: "wf-preview-args",
  args: [
    { name: "market", type: "string" },
    { name: "region", type: "string" },
    { name: "competitors", type: "string" },
  ],
  proposalFeedback: "把竞品那一步换成逐家深挖，另外别再爬 Twitter",
};

export default function WorkflowPreviewPage() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  void openKey;
  void setOpenKey;
  return (
    <div className="bg-background text-foreground flex flex-col gap-6 p-8">
      <section className="border-border/60 bg-card rounded-xl border p-4">
        <div className="text-muted-foreground mb-3 text-[11px] font-medium">
          提案卡(proposed,对话内只读记录)
        </div>
        <WorkflowPlanCard run={proposed} />
      </section>
      <section className="border-border/60 bg-card rounded-xl border p-4">
        <div className="text-muted-foreground mb-3 text-[11px] font-medium">
          确认面板(composer 区,审批卡形态:图在上、按钮在底)
        </div>
        <div className="w-[860px] rounded-2xl border p-4">
          <WorkflowConfirmPanel run={proposedWithArgs} busy={false} onConfirm={() => {}} onReject={() => {}} />
        </div>
      </section>
      <section className="border-border/60 bg-card rounded-xl border p-4">
        <div className="text-muted-foreground mb-3 text-[11px] font-medium">运行中(running)</div>
        <WorkflowRunCard run={running} busy={false} onPause={() => {}} onResume={() => {}} />
      </section>
      <section className="border-border/60 bg-card rounded-xl border p-4">
        <div className="text-muted-foreground mb-3 text-[11px] font-medium">失败(failed)</div>
        <WorkflowRunCard run={failed} busy={false} onPause={() => {}} onResume={() => {}} />
      </section>
      <section className="border-border/60 bg-card rounded-xl border p-4">
        <div className="text-muted-foreground mb-3 text-[11px] font-medium">编排中(proposing，无剧本)</div>
        <WorkflowRunCard run={proposing} busy={false} onPause={() => {}} onResume={() => {}} />
      </section>
      <section className="border-border/60 bg-card flex flex-col gap-4 rounded-xl border p-4">
        <div className="text-muted-foreground text-[11px] font-medium">步骤详情抽屉(delegate / gate)</div>
        <WorkflowStepDrawer
          threadId={undefined}
          step={steps[2]!}
          detail={delegateDetail}
          now={Date.now()}
          onClose={() => {}}
        />
        <WorkflowStepDrawer
          threadId={undefined}
          step={steps[5]!}
          detail={gateDetail}
          now={Date.now()}
          onClose={() => {}}
        />
      </section>
    </div>
  );
}
