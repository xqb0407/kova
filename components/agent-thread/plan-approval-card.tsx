"use client";

import { useState, type FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import {
  CheckIcon,
  ClipboardListIcon,
  TargetIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  approveSessionPlan,
  rejectSessionPlan,
  useSessionMode,
} from "@/lib/pi-session-mode";

/**
 * 计划/目标审批卡片：SubmitPlan/SubmitGoal 后（awaiting_approval）显示在 composer 上方。
 * 批准 → approve_plan 回 agent 模式并自动发批准消息开始实施；
 * 拒绝 → 留在契约模式，用户输入反馈后模型重新提交。
 */

const APPROVE_TEXT: Record<"plan" | "goal", string> = {
  plan: "计划已批准，请按计划开始实施。",
  goal: "目标已批准，请开始自主执行并逐项验证验收标准。",
};

export const PlanApprovalCard: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const aui = useAui();
  const snap = useSessionMode(threadId);
  const [busy, setBusy] = useState(false);

  if (!threadId || snap.planning !== "awaiting_approval" || !snap.proposal) {
    return null;
  }
  const { kind, title, markdown, question, filePath } = snap.proposal;
  const Icon = kind === "goal" ? TargetIcon : ClipboardListIcon;

  const approve = () => {
    setBusy(true);
    approveSessionPlan(threadId)
      .then(() => {
        aui.thread.append({
          content: [{ type: "text", text: APPROVE_TEXT[kind] }],
          runConfig: aui.composer.getState().runConfig,
        });
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const reject = () => {
    setBusy(true);
    rejectSessionPlan(threadId)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <div
      data-slot="aui-plan-approval-card"
      className="border-border/60 bg-card overflow-hidden rounded-xl border shadow-sm"
    >
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Icon className="size-4 shrink-0" />
        <span className="truncate text-sm font-medium">
          {title || (kind === "goal" ? "目标待批准" : "计划待批准")}
        </span>
        <span className="bg-muted text-muted-foreground ml-auto rounded-full px-2 py-0.5 text-xs whitespace-nowrap">
          {kind === "goal" ? "Goal" : "Plan"}
        </span>
      </div>
      <div className="scrollbar-thin max-h-72 overflow-y-auto px-4 py-3">
        <div className="text-sm">
          <Streamdown plugins={{ code, cjk }}>{markdown}</Streamdown>
        </div>
        {question && (
          <p className="text-muted-foreground mt-3 border-t pt-3 text-sm">
            {question}
          </p>
        )}
        {filePath && (
          <p
            className="text-muted-foreground/80 mt-2 truncate font-mono text-xs"
            title={filePath}
          >
            已保存到 {filePath}
          </p>
        )}
      </div>
      <div className={cn("flex justify-end gap-2 border-t px-4 py-2.5")}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={reject}
          className="h-8 rounded-full px-3.5"
        >
          <XIcon className="size-3.5" />
          拒绝
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={approve}
          className="h-8 rounded-full px-3.5"
        >
          <CheckIcon className="size-3.5" />
          批准
        </Button>
      </div>
    </div>
  );
};
