"use client";

/**
 * 【临时验证页，验证后删除】
 * 自动化页插画（automation-art）的隔离预览：
 * 上 = 模板卡网格（真实 TemplateCard，fixture 数据抄自 sidecar templates.ts）
 * 中 = 两个空态插画在真实包裹里的样子
 * 亮/暗两态各截一次：node verify-automation-art.mjs
 */

import { useState } from "react";
import type { AutomationTemplate } from "@/lib/automation/automations";
import {
  AutomationEmptyArt,
  HistoryEmptyArt,
} from "@/components/automations/automation-art";
import { TemplateCard } from "@/components/automations/template-gallery";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";

const TEMPLATES: AutomationTemplate[] = [
  {
    id: "tpl-daily-briefing",
    name: "每日晨报",
    description: "每天早上汇总今日日程与待办要点",
    prompt: "汇总今天需要我关注的事项",
    type: "cron",
    schedule: "30 8 * * *",
    toolPolicyProfile: "read-only",
  },
  {
    id: "tpl-weekly-report",
    name: "每周周报草稿",
    description: "周五傍晚回顾一周工作，生成周报草稿",
    prompt: "回顾本周的会话记录",
    type: "cron",
    schedule: "0 17 * * 5",
    toolPolicyProfile: "read-only",
  },
  {
    id: "tpl-repo-check",
    name: "仓库每日体检",
    description: "跑一遍测试与构建，汇总失败项（需指定工作目录）",
    prompt: "在当前工作目录运行测试与构建",
    type: "cron",
    schedule: "0 9 * * 1-5",
    toolPolicyProfile: "workspace-write",
  },
  {
    id: "tpl-watch-scan",
    name: "定期信息巡检",
    description: "每 6 小时检索一次指定主题的最新动态",
    prompt: "检索并汇总最近 6 小时内的新动态",
    type: "interval",
    schedule: "6h",
    toolPolicyProfile: "read-only",
  },
  {
    id: "tpl-one-off",
    name: "稍后提醒",
    description: "一天后自动执行一次的一次性任务",
    prompt: "提醒我稍后做一件事",
    type: "once",
    schedule: "+1d",
    toolPolicyProfile: "read-only",
  },
];

export default function Page() {
  const [dark, setDark] = useState(false);
  return (
    <div className={dark ? "dark" : undefined}>
      <div className="bg-background text-foreground min-h-screen p-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
          <header className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">
              自动化插画预览
            </h1>
            <Button variant="outline" onClick={() => setDark((d) => !d)}>
              {dark ? "切亮色" : "切暗色"}
            </Button>
          </header>

          {/* 1. 模板区，与 template-gallery 同款包裹 */}
          <section className="border-border/60 border-t pt-8">
            <div className="mb-5 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold">从模板开始</h2>
              <span className="text-muted-foreground ml-auto text-xs">
                挑一个常见场景起步，表单里的内容都可以再改
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {TEMPLATES.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  onPick={() => undefined}
                />
              ))}
            </div>
          </section>

          {/* 2. 两个空态（真实包裹） */}
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold">空态 A：任务</h2>
            <div className="text-muted-foreground flex flex-col items-center gap-3 py-6 text-center">
              <AutomationEmptyArt className="text-primary mb-5 h-auto w-full max-w-[26rem]" />
              <p className="text-foreground text-base font-semibold tracking-[-0.011em]">
                还没有自动化任务
              </p>
              <p className="max-w-md text-sm leading-relaxed">
                从下方挑一个模板起步最快；也可以在对话里直接说
                &quot;每天早上 9 点给我发一份昨日总结&quot;，让 Agent 帮你建。
              </p>
              <Button size="sm" variant="outline" className="mt-3 gap-1.5">
                <PlusIcon className="size-4" />
                新建第一个任务
              </Button>
            </div>

            <h2 className="text-sm font-semibold">空态 B：运行记录</h2>
            <div className="border-border/60 text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
              <HistoryEmptyArt className="text-muted-foreground h-auto w-full max-w-md opacity-90" />
              <p className="text-foreground text-sm font-semibold">还没有运行记录</p>
              <p className="text-xs">
                任务触发后，每一次执行（含排队与暂停排期）都会记在这里
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
