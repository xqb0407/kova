"use client";

/**
 * 【校对页】子智能体编辑器（卡片式版式）：/dev-preview/subagent-editor
 *
 * 跑法：cd apps/desktop && bun run dev → http://localhost:3000/dev-preview/subagent-editor
 *
 * 技能/MCP 清单与模型目录来自 sidecar，浏览器里拿不到：技能与 MCP 的弹层
 * 会是空候选（optionsReady=false，不会闪"当前作用域不存在"的红标），模型
 * 控件用夹具复刻触发器外观。用来校对：分区卡片与虚线分隔、头像行的
 * 「随机一张」、执行配置行的左标签右控件、多选边框盒的 chip 形态、
 * 知识源行的间距。
 */
import { useState, type FC } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  SubagentEditorPage,
  type EditorTarget,
} from "@/components/settings/components/subagent-editor-page";
import type { PiSubagentEntry } from "@/lib/pi/pi-bridge";

const FIXTURE_ENTRY: PiSubagentEntry = {
  name: "code-reviewer",
  description: "审查代码质量、安全性和回归风险，给出具体问题与修改建议。",
  tools: ["read", "grep", "glob"],
  maxTurns: 40,
  prompt:
    "你是代码审查员，独立审查团队负责人指定变更的需求完整性、代码正确性和外部影响，报告值得修复的高置信度问题。",
  scope: "system",
  skills: [
    "code-review",
    "release-notes",
    "db-migration",
    "api-design",
    "test-craft",
    "perf-tuning",
    "doc-writing",
    "refactor-playbook",
    "security-audit",
    "i18n-check",
    "log-analysis",
    "chaos-drill",
  ],
  mcpServers: ["github", "linear", "sentry", "postgres"],
  knowledge: [
    { name: "团队规范", path: "./docs/conventions/**/*.md" },
    { name: "安全清单", path: "./docs/security-checklist.md" },
  ],
  memory: "private",
  avatar: "builtin:clay01",
  enabled: true,
  editable: true,
};

/** 模型控件的夹具：只复刻触发器外观（ghost 胶囊），清单来自 sidecar 拿不到 */
const FixtureModelControl: FC<{ value?: string; onChange: (v: string) => void }> = ({
  value,
}) => (
  <button
    type="button"
    className="text-muted-foreground hover:bg-muted inline-flex h-7 max-w-56 items-center gap-1 rounded-full px-2.5 text-[13px] leading-5"
  >
    <span className="truncate">{value || "跟随当前会话"}</span>
    <ChevronDownIcon className="size-3 opacity-60" />
  </button>
);

export default function Page() {
  const [target, setTarget] = useState<EditorTarget>({
    mode: "edit",
    entry: FIXTURE_ENTRY,
  });
  return (
    <div className="bg-background mx-auto h-screen max-w-4xl px-8 py-8">
      <SubagentEditorPage
        target={target}
        workspaceCwd={null}
        onBack={() => setTarget({ mode: "create", scope: "system" })}
        renderModelControl={(value, onChange) => (
          <FixtureModelControl value={value} onChange={onChange} />
        )}
      />
    </div>
  );
}
