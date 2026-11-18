"use client";

/**
 * 设置页的「工作区范围」选择器：只列项目/工作区，不再让用户挑任意目录。
 *
 * MCP / 子智能体 / 技能 / 记忆 / 命令的工作区级配置最终都落在项目主目录的
 * `.kova/` 下，因此这里用项目实体作为唯一入口；附加目录只是代码上下文，
 * 不单独成为配置作用域。交互对齐自动化编辑器的任务工作空间选择：
 * 搜索框 + 项目列表（当前项打勾）+ 当前值兜底；旧数据里已经指向非项目
 * 目录的 override 仍会以「历史目录」显示，避免编辑旧配置时看不到当前值。
 */
import { useMemo, useState, type FC, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import { useT } from "@/lib/i18n";
import {
  projectDisplayName,
  projectPrimaryPath,
  sameProjectPath,
  useProjectRegistry,
  useProjectWorkspaceDir,
} from "@/lib/pi/pi-projects";
import {
  pathBasename,
  useWorkspaceProjectId,
} from "@/lib/workspace/workspace-store";

export type ProjectScopeOption = {
  id: string;
  label: string;
  primary: string;
  isCurrent: boolean;
};

/** 工作区范围候选：当前项目优先，其余按名称排序；已移除项目仅在仍是当前
 *  工作区时保留，避免设置页打开后选择器突然变空。 */
export function useProjectScopeOptions(): {
  options: ProjectScopeOption[];
  currentDir: string | null;
  optionForCwd: (cwd: string | null | undefined) => ProjectScopeOption | undefined;
} {
  const registry = useProjectRegistry();
  const currentDir = useProjectWorkspaceDir();
  const currentProjectId = useWorkspaceProjectId();
  const options = useMemo(
    () =>
      registry
        .filter(
          (project) =>
            !project.archived &&
            (!project.hiddenFromSidebar || project.id === currentProjectId),
        )
        .map((project) => {
          const primary = projectPrimaryPath(project);
          return {
            id: project.id,
            label: projectDisplayName(project),
            primary,
            isCurrent: Boolean(
              currentDir && sameProjectPath(primary, currentDir),
            ),
          };
        })
        .filter((option) => Boolean(option.primary))
        .sort(
          (a, b) =>
            Number(b.isCurrent) - Number(a.isCurrent) ||
            a.label.localeCompare(b.label, "zh"),
        ),
    [registry, currentProjectId, currentDir],
  );
  const optionForCwd = (cwd: string | null | undefined) =>
    cwd
      ? options.find((option) => sameProjectPath(option.primary, cwd))
      : undefined;
  return { options, currentDir, optionForCwd };
}

/** 路径提示：取末两段（父目录/目录名），与自动化工作空间菜单同口径 */
function dirHint(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).slice(-2).join("/");
}

export const ProjectScopeMenu: FC<{
  value: string | null;
  following: boolean;
  followLabel?: string | null;
  onChange: (cwd: string, projectId: string) => void;
  onFollowCurrent: () => void;
  /** 允许清除当前选择（IM 渠道等工作区可留空） */
  onClear?: () => void;
  /** 选中后关闭菜单（默认保持展开：设置页有「当前项打勾」的速览诉求；
   *  IM 工作目录选择后要弹确认对话框，菜单必须收起） */
  closeOnSelect?: boolean;
  align?: "start" | "end";
  variant?: "ghost" | "outline";
  icon?: ReactNode;
}> = ({
  value,
  following,
  followLabel,
  onChange,
  onFollowCurrent,
  onClear,
  closeOnSelect = false,
  align = "end",
  variant = "ghost",
  icon,
}) => {
  const t = useT();
  const { options, currentDir, optionForCwd } = useProjectScopeOptions();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = optionForCwd(value);
  const legacyValue = value && !selected ? value : null;
  const followName =
    followLabel ??
    (currentDir
      ? (optionForCwd(currentDir)?.label ?? pathBasename(currentDir))
      : null);
  const needle = query.trim().toLocaleLowerCase();
  const visibleOptions = needle
    ? options.filter(
        (option) =>
          option.label.toLocaleLowerCase().includes(needle) ||
          option.primary.toLocaleLowerCase().includes(needle),
      )
    : options;
  const triggerClass =
    variant === "outline"
      ? "border-border bg-background hover:bg-muted inline-flex h-8 min-w-48 items-center justify-between gap-2 rounded-lg border px-3 text-sm font-normal transition-colors"
      : "text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] leading-5 transition-colors";

  const selectOption = (option: ProjectScopeOption) => {
    onChange(option.primary, option.id);
    if (closeOnSelect) setOpen(false);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={value ?? t("settings.projectScope.select")}
            className={triggerClass}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {icon ?? <FolderOpenIcon className="size-3.5 shrink-0" />}
              <span className="max-w-44 truncate">
                {selected
                  ? selected.label
                  : legacyValue
                    ? pathBasename(legacyValue)
                    : t("settings.projectScope.select")}
              </span>
            </span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
          </button>
        }
      />
      <DropdownMenuContent align={align} className="w-[21rem] p-0">
        <DropdownMenuGroup className="p-0">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") event.stopPropagation();
              }}
              placeholder={t("settings.projectScope.search")}
              className="h-9 border-0 bg-transparent ps-8 focus-visible:ring-0"
            />
          </div>
          <DropdownMenuSeparator className="mt-0" />
          <div className="max-h-72 overflow-y-auto px-1 pb-1">
            {visibleOptions.map((option) => {
              const active = selected?.id === option.id;
              return (
                <DropdownMenuItem
                  key={option.id}
                  closeOnClick={false}
                  title={option.primary}
                  onClick={() => selectOption(option)}
                  className="gap-2 pe-2"
                >
                  {active ? (
                    <CheckIcon className="text-primary size-3.5 shrink-0" />
                  ) : (
                    <FolderGit2Icon className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                  <span className="text-muted-foreground max-w-40 shrink-0 truncate text-end font-mono text-3xs">
                    {option.isCurrent
                      ? t("settings.projectScope.current")
                      : dirHint(option.primary)}
                  </span>
                </DropdownMenuItem>
              );
            })}
            {legacyValue ? (
              <DropdownMenuItem
                disabled
                title={legacyValue}
                className="gap-2 pe-2"
              >
                <CheckIcon className="text-primary size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {pathBasename(legacyValue)}
                </span>
                <span className="text-muted-foreground shrink-0 text-2xs">
                  {t("settings.projectScope.legacy")}
                </span>
              </DropdownMenuItem>
            ) : null}
            {visibleOptions.length === 0 && !legacyValue ? (
              <div className="text-muted-foreground px-2 py-3 text-center text-[13px] leading-5">
                {t("settings.projectScope.empty")}
              </div>
            ) : null}
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-1 pb-1">
          {value && onClear ? (
            <DropdownMenuItem
              onClick={() => {
                onClear();
                if (closeOnSelect) setOpen(false);
              }}
            >
              <XIcon className="text-muted-foreground size-3.5 shrink-0" />
              {t("settings.projectScope.clear")}
            </DropdownMenuItem>
          ) : null}
          {!following && followName ? (
            <DropdownMenuItem
              onClick={() => {
                onFollowCurrent();
                if (closeOnSelect) setOpen(false);
              }}
            >
              <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
              {t("settings.projectScope.followCurrent", { name: followName })}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
            {t("settings.projectScope.newWorkspace")}
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>

      <WorkspaceCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        selectAfterCreate={false}
        onCreated={(project) => {
          const primary = projectPrimaryPath(project);
          if (primary) {
            onChange(primary, project.id);
            if (closeOnSelect) setOpen(false);
          }
        }}
      />
    </DropdownMenu>
  );
};
