"use client";

/**
 * 【临时验证页，验证后删除】
 * 自动化页三块组件的隔离预览（真组件 + fixture，不依赖 sidecar）：
 * 上 = 任务清单空态（AutomationEmptyState）
 * 中 = 模板卡网格（TemplateCard，含一张未登记 id 走 type 兜底的）
 * 下 = 运行记录空态（HistoryEmptyState，无筛选与带筛选两版）
 * 亮/暗两态各截一次：无头 Chrome 打开本页，点右上角切换。
 */

import { useState } from "react";
import { PlusIcon } from "lucide-react";
import type { AutomationTemplate } from "@/lib/automation/automations";
import { TemplateCard } from "@/components/automations/template-gallery";
import {
  AutomationEmptyState,
  HistoryEmptyState,
} from "@/components/automations/automation-empty";
import { Button } from "@/components/ui/button";

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
  // 未登记 id：色相与图标都按 type 落兜底，用来确认新增模板不会开天窗
  {
    id: "tpl-unregistered",
    name: "自定义周期任务",
    description: "sidecar 新增、桌面端还没登记图标的模板",
    prompt: "按周期执行的一段指令",
    type: "cron",
    schedule: "0 10 * * 1",
    toolPolicyProfile: "read-only",
  },
];

export default function Page() {
  const [dark, setDark] = useState(false);
  return (
    <div className={dark ? "dark" : undefined}>
      <div className="bg-background text-foreground min-h-screen p-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
          <header className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">自动化页组件预览</h1>
            <Button variant="outline" onClick={() => setDark((d) => !d)}>
              {dark ? "切亮色" : "切暗色"}
            </Button>
          </header>

          {/* 1. 任务清单空态：真实页面里它上面就是标题/页签/检索条，下面接模板区 */}
          <section className="flex flex-col">
            <h2 className="text-muted-foreground font-mono text-xs">任务清单空态</h2>
            <AutomationEmptyState
              action={
                <Button size="sm" variant="outline" className="gap-1.5">
                  <PlusIcon className="size-4" />
                  新建第一个任务
                </Button>
              }
            />
          </section>

          {/* 2. 模板区，与 template-gallery 同款包裹 */}
          <section className="border-border/60 border-t pt-8">
            <div className="mb-5 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold">从模板开始</h2>
              <span className="text-muted-foreground ml-auto text-xs">
                挑一个常见场景起步，表单里的内容都可以再改
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {TEMPLATES.map((t) => (
                <TemplateCard key={t.id} template={t} onPick={() => undefined} />
              ))}
            </div>
          </section>

          {/* 3. 运行记录空态：无筛选与带筛选两版 */}
          <section className="flex flex-col gap-4">
            <h2 className="text-muted-foreground font-mono text-xs">运行记录空态</h2>
            <HistoryEmptyState
              title="还没有运行记录"
              description="任务触发后，每一次执行（含排队与暂停排期）都会记在这里"
            />
            <HistoryEmptyState title="没有匹配的运行记录" />
          </section>
        </div>
      </div>
    </div>
  );
}
