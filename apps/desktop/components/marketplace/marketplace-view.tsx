"use client";

import { useState, type FC } from "react";
import dynamic from "next/dynamic";
import {
  ChevronLeftIcon,
  Loader2Icon,
  PackageOpenIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/custom-ui/segmented";
import { useWorkspace } from "@/lib/workspace-store";
import { useSkills } from "@/lib/skills";
import { useMcpServers } from "@/lib/mcp";

/**
 * 插件市场（侧边栏「插件市场」主区视图）。
 * 市场页 = 发现目录（远程源暂未开放，占位空态；本地已安装项不在这里展示）；
 * 右上角「管理」进入管理页——原设置 → 智能体的 MCP / 技能两页整体迁移至此：
 * 插件页签渲染 MCP 管理、技能页签渲染技能管理（完整能力），应用授权暂为空态。
 */

function ViewSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
    </div>
  );
}

// 与设置页共用同一实现；CodeMirror（JSON 编辑器）等重依赖随 chunk 按需拉取
const McpSettings = dynamic(
  () =>
    import("@/components/settings/components/mcp-settings").then((m) => ({
      default: m.McpSettings,
    })),
  { ssr: false, loading: () => <ViewSpinner /> },
);
const SkillsSettings = dynamic(
  () =>
    import("@/components/settings/components/skills-settings").then((m) => ({
      default: m.SkillsSettings,
    })),
  { ssr: false, loading: () => <ViewSpinner /> },
);

/** 管理页分段器选项 */
type ManageTab = "plugins" | "skills" | "apps";

export const MarketplaceView: FC = () => {
  const workspace = useWorkspace();
  // 管理页分段器的计数；清单数据由迁移进来的管理组件自取
  const skillsSnap = useSkills(workspace);
  const mcpSnap = useMcpServers(workspace);

  const [page, setPage] = useState<"market" | "manage">("market");
  const [manageTab, setManageTab] = useState<ManageTab>("plugins");

  if (page === "manage") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* 顶部条：与下方设置内容同宽同轴（max-w-5xl 居中列），返回 + 分段器（带计数） */}
        <div className="mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between px-8 pt-6">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2 gap-1"
            onClick={() => setPage("market")}
          >
            <ChevronLeftIcon className="size-4" />
            返回市场
          </Button>
          <Segmented
            value={manageTab}
            onChange={setManageTab}
            options={[
              { value: "plugins", label: `插件 ${mcpSnap.servers.length}` },
              { value: "skills", label: `技能 ${skillsSnap.skills.length}` },
              { value: "apps", label: "应用授权 0" },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1">
          {manageTab === "plugins" && <McpSettings />}
          {manageTab === "skills" && <SkillsSettings />}
          {manageTab === "apps" && (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              暂无应用授权
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-8 py-8 lg:px-12">
        {/* 页头 */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">插件市场</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              发现并安装插件、技能等扩展，拓展 Agent 的能力。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setPage("manage")}
          >
            <SlidersHorizontalIcon className="size-3.5" />
            管理
          </Button>
        </div>

        {/* 市场目录空态：远程源未开放；本地已安装项只在「管理」页展示 */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-16">
          <div className="bg-muted/50 text-muted-foreground grid size-12 place-items-center rounded-2xl border">
            <PackageOpenIcon className="size-6" />
          </div>
          <p className="text-sm font-medium">市场目录即将上线</p>
          <p className="text-muted-foreground text-sm">
            本地已安装的插件与技能，点右上角「管理」查看。
          </p>
        </div>
      </div>
    </div>
  );
};
