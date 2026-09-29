"use client";

import { useCallback, useEffect, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/tauri";
import {
  openWorkspacePicker,
  pathBasename,
  useWorkspace,
} from "@/lib/workspace/workspace-store";
import { useOnboarding } from "../onboarding-flow";
import { Notice, StepFooter, StepHeading } from "./step-parts";
import { FolderOpenIcon } from "lucide-react";

/**
 * 工作目录：agent 的读代码、跑命令、查 git 都发生在这里。
 * 选完立刻写 workspace-store（SQLite kv），与顶栏目录胶囊同一份状态；
 * 没选也能继续——开新会话时还能在顶栏换。
 */
export const WorkspaceStep: FC = () => {
  const { next, back, patch } = useOnboarding();
  const workspace = useWorkspace();
  const [picking, setPicking] = useState(false);

  const pick = useCallback(async () => {
    if (picking) return;
    setPicking(true);
    const dir = await openWorkspacePicker();
    setPicking(false);
    if (dir) patch("workspace", { done: true, summary: pathBasename(dir) });
  }, [patch, picking]);

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
        title="选择工作目录"
        desc="Kova 读代码、跑命令、看 git 改动都发生在这个目录里。选一个你最近要动的项目就行，之后随时能在顶栏换。"
      />

      {!isTauri() ? (
        <Notice>当前不是桌面环境，无法选择本地目录。客户端里可以随时在顶栏切换。</Notice>
      ) : (
        <div className="bg-muted/50 flex items-center gap-3 rounded-2xl p-4">
          <div className="bg-background flex size-9 shrink-0 items-center justify-center rounded-xl">
            <FolderOpenIcon className="text-muted-foreground size-4" />
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
                还没有选择目录
              </div>
            )}
          </div>
          <Button
            variant="outline"
            disabled={picking}
            onClick={() => void pick()}
          >
            {workspace ? "换一个" : "浏览"}
          </Button>
        </div>
      )}

      <StepFooter
        onBack={back}
        // 网页端选不了目录，这一节就不能设成必填，否则下一步永远灰着、向导走不完
        onSkip={!isTauri() ? next : undefined}
      >
        <Button disabled={isTauri() && !workspace} onClick={next}>
          下一步
        </Button>
      </StepFooter>
    </div>
  );
};
