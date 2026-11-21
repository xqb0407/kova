"use client";

import { useEffect, useMemo, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { isDesktop } from "@/lib/desktop-env";
import {
  pathBasename,
  setWorkspace,
  useWorkspace,
  useWorkspaceProjectId,
} from "@/lib/workspace/workspace-store";
import { useOnboarding } from "../onboarding-flow";
import { Notice, StepFooter, StepHeading } from "./step-parts";
import { ProjectFolderOpenIcon } from "@/components/icons/project-folder-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import {
  projectDisplayName,
  projectPrimaryPath,
  useProjectRegistry,
} from "@/lib/pi/pi-projects";

/**
 * 工作目录：agent 的读代码、跑命令、查 git 都发生在这里。
 * 选完立刻写 workspace-store（SQLite kv），与顶栏目录胶囊同一份状态；
 * 没选也能继续——开新会话时还能在顶栏换。
 */
export const WorkspaceStep: FC = () => {
  const { next, back, patch } = useOnboarding();
  const t = useT();
  const workspace = useWorkspace();
  const workspaceProjectId = useWorkspaceProjectId();
  const projects = useProjectRegistry();
  const activeProjects = useMemo(
    () =>
      projects.filter(
        (project) => !project.archived && !project.hiddenFromSidebar,
      ),
    [projects],
  );
  const projectItems = useMemo(
    () =>
      activeProjects.map((project) => ({
        value: project.id,
        label: projectDisplayName(project),
      })),
    [activeProjects],
  );
  const [createOpen, setCreateOpen] = useState(false);

  const selectProject = (projectId: string) => {
    const project = activeProjects.find((entry) => entry.id === projectId);
    if (!project) return;
    const primary = projectPrimaryPath(project);
    if (primary) setWorkspace(primary, "user", project.id);
  };

  // 完成清单上显示的是目录名，目录却可能在会话同步里被改掉。以 store 当前值为准
  // 持续回报，清单就不会停留在选完那一刻的旧名字。
  useEffect(() => {
    patch("workspace", {
      done: !!workspace,
      summary: workspace ? pathBasename(workspace) : null,
    });
  }, [patch, workspace]);

  return (
    <div className="flex flex-col">
      <StepHeading
        title={t("onboarding.workspace.title")}
        desc={t("onboarding.workspace.desc")}
      />

      {!isDesktop() ? (
        <Notice>{t("onboarding.workspace.noticeNotDesktop")}</Notice>
      ) : (
        <div className="bg-muted/50 flex items-center gap-3 rounded-2xl p-4">
          <div className="bg-background flex size-9 shrink-0 items-center justify-center rounded-xl">
            <ProjectFolderOpenIcon className="text-muted-foreground size-4" />
          </div>
          <div className="min-w-0 flex-1">
            {workspace ? (
              <>
                <div className="truncate text-sm font-medium">
                  {pathBasename(workspace)}
                </div>
                <div className="text-muted-foreground truncate text-xs">
                  {workspace}
                </div>
              </>
            ) : (
              <div className="text-muted-foreground text-sm">
                {t("onboarding.workspace.empty")}
              </div>
            )}
          </div>
          {activeProjects.length > 0 ? (
            <Select
              value={workspaceProjectId ?? undefined}
              items={projectItems}
              onValueChange={(value) => {
                if (value) selectProject(value);
              }}
            >
              <SelectTrigger className="h-8 w-36 shrink-0">
                <SelectValue
                  placeholder={t("onboarding.workspace.select")}
                />
              </SelectTrigger>
              <SelectContent>
                {activeProjects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {projectDisplayName(project)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => setCreateOpen(true)}
          >
            {t("onboarding.workspace.newWorkspace")}
          </Button>
        </div>
      )}

      {/* 目录是可选项：不选时 sidecar 会回落到按会话隔离的临时目录（resolve.ts），
          功能不受影响，所以不设必填门槛，避免把没想好的人卡死在这一步 */}
      <StepFooter onBack={back}>
        <Button onClick={next}>{t("common.action.next")}</Button>
      </StepFooter>

      <WorkspaceCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
};
