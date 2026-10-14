"use client";

/**
 * 【临时验证页，验证后删除】
 * 自动化页任务卡与插件页卡片并排，确认两页现在是同一套皮、灰罩同高（44px）。
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoreHorizontalIcon, PlayIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import { cn } from "@/lib/utils";

const TASKS = [
  {
    name: "每日晨报",
    desc: "每天早上汇总今日日程与待办要点",
    schedule: "每天 08:30",
    paused: true,
    stat: "上次 7 天前 · 共 2 次",
  },
  {
    name: "每日市场调研报告",
    desc: "每天 8:00 生成一份「行业痛点 × AI 解决方案」市场调研报告，输出到工作区 reports/ 目录",
    schedule: "每天 08:00",
    paused: false,
    stat: "从未运行",
  },
];

/** 任务卡（automations-view.tsx 现状） */
function TaskCard({ t }: { t: (typeof TASKS)[number] }) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl bg-accent p-2",
        "transition-[background-color,box-shadow] duration-150",
        "hover:bg-[color-mix(in_oklab,var(--color-accent)_92%,var(--color-foreground))]",
      )}
    >
      <div className="relative flex min-w-0 items-center gap-2 px-4 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn("truncate text-sm font-medium", t.paused && "text-muted-foreground")}>
            {t.name}
          </span>
        </div>
        <div className="ml-auto flex h-6 shrink-0 items-center gap-0.5">
          <Switch size="sm" className="shrink-0" checked={!t.paused} aria-label="启用" />
          <Button variant="ghost" size="icon" className="size-6 shrink-0">
            <PlayIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6 shrink-0">
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 rounded-lg bg-background p-4">
        <p className="text-muted-foreground line-clamp-2 min-w-0 text-xs leading-relaxed">{t.desc}</p>
        <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 tabular-nums",
              t.paused ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
            )}
          >
            {t.schedule}
          </span>
          {t.paused && <span className="bg-muted rounded-full px-2 py-0.5">已暂停</span>}
          <span className="text-muted-foreground/70 ml-auto shrink-0 tabular-nums">{t.stat}</span>
        </div>
      </div>
    </div>
  );
}

/** 插件页市场目录卡（marketplace-view.tsx 现状） */
const PluginCard = () => (
  <div className="bg-accent hover:bg-[color-mix(in_oklab,var(--color-accent)_92%,var(--color-foreground))] flex cursor-pointer flex-col rounded-2xl p-2 transition-colors">
    <div className="flex min-w-0 items-center gap-3 px-4 py-1.5">
      <div className="bg-background grid size-6 shrink-0 place-items-center overflow-hidden rounded-xl">
        <PluginIcon src={undefined} name="hello-pack" />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-sm font-medium">hello-pack</span>
        <Badge variant="outline" className="shrink-0 px-1.5 font-mono text-[11px] font-normal">
          v1.0.0
        </Badge>
        <span className="text-muted-foreground min-w-0 truncate text-xs">演示</span>
      </div>
    </div>
    <div className="flex flex-1 flex-col rounded-lg bg-background p-4">
      <p className="text-muted-foreground line-clamp-2 flex-1 text-xs">
        四件套演示插件：技能 + MCP 服务器 + 生命周期钩子 + 子智能体，装完即可验证插件系统全链路。
      </p>
      <div className="mt-3 flex items-center justify-end">
        <Button size="sm" className="h-7 gap-1 text-xs">
          安装
        </Button>
      </div>
    </div>
  </div>
);

function Board({ dark }: { dark?: boolean }) {
  return (
    <div data-board={dark ? "dark" : "light"} className={dark ? "dark" : undefined}>
      <div className="bg-muted/40 rounded-xl p-2 pl-0">
        <div className="bg-background border-border/60 relative flex flex-col rounded-xl border">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-8 py-6">
            <div className="text-muted-foreground font-mono text-xs">
              {dark ? "dark" : "light"} · 任务卡 2 张 / 插件卡 1 张 / 骨架 1 块
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <TaskCard t={TASKS[0]} />
              <TaskCard t={TASKS[1]} />
              <PluginCard />
              <Skeleton className="h-40 rounded-2xl" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Board />
      <Board dark />
    </div>
  );
}
