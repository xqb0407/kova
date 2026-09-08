"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { piRequest, type PiSkillSummary, type PiModelSummary } from "@/lib/pi-bridge";
import { isTauri } from "@/lib/tauri";
import { getWorkspace } from "@/lib/workspace-store";
import {
  setSelectedModel,
  useSelectedModel,
} from "@/lib/model-settings";
import {
  BoxesIcon,
  CheckIcon,
  CircleAlertIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react";

type SettingsSection = "models" | "skills" | "general";

const SECTIONS: { id: SettingsSection; label: string; icon: FC<{ className?: string }> }[] = [
  { id: "models", label: "模型", icon: BoxesIcon },
  { id: "skills", label: "技能", icon: SparklesIcon },
  { id: "general", label: "通用", icon: SlidersHorizontalIcon },
];

export const SettingsModal: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const [section, setSection] = useState<SettingsSection>("models");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[560px] max-w-3xl gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">设置</DialogTitle>
        <DialogDescription className="sr-only">应用设置</DialogDescription>

        {/* 左侧菜单 */}
        <nav
          data-slot="settings-nav"
          className="bg-muted/40 flex w-40 shrink-0 flex-col gap-1 border-r p-3"
        >
          <div className="text-muted-foreground px-2 pt-1 pb-2 text-xs font-medium">
            设置
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              data-active={section === id}
              className={cn(
                "hover:bg-muted flex h-8 items-center gap-2 rounded-md px-2.5 text-sm",
                "data-active:bg-muted data-active:text-foreground text-muted-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        {/* 右侧内容 */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {section === "models" && <ModelSettings />}
          {section === "skills" && <SkillsSettings />}
          {section === "general" && (
            <div className="text-muted-foreground p-5 text-sm">
              暂无可配置项
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

const fmtContextWindow = (n: number): string => {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
};

/** 模型配置页：读取 pi ModelRegistry 的模型列表（含凭据状态），点击应用 */
const ModelSettings: FC = () => {
  const [models, setModels] = useState<PiModelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const selected = useSelectedModel();

  const load = useCallback(() => {
    if (!isTauri()) return;
    setError(null);
    piRequest<{
      type: "models";
      models: PiModelSummary[];
      providers: { id: string; name: string; authed: boolean }[];
    }>({ type: "list_models" })
      .then((res) => setModels(res.models))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    if (!models) return [];
    const query = search.trim().toLowerCase();
    const filtered = models.filter(
      (m) =>
        !query ||
        m.name.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query) ||
        m.providerName.toLowerCase().includes(query),
    );
    const byProvider = new Map<string, typeof filtered>();
    for (const m of filtered) {
      const bucket = byProvider.get(m.providerName);
      if (bucket) bucket.push(m);
      else byProvider.set(m.providerName, [m]);
    }
    return [...byProvider.entries()];
  }, [models, search]);

  const hasAuthedModel = models?.some((m) => m.authed) ?? false;

  // web 预览没有 Tauri 后端（pi sidecar / invoke），直接给出降级提示
  if (!isTauri()) {
    return (
      <div className="text-muted-foreground p-5 text-sm">
        模型配置依赖桌面端 pi 服务，请在 Tauri 应用中打开设置。
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5">
        <div className="text-destructive text-sm">加载模型列表失败：{error}</div>
        <Button variant="outline" size="sm" className="mt-3" onClick={load}>
          重试
        </Button>
      </div>
    );
  }

  if (!models) {
    return (
      <div className="flex flex-col gap-2 p-5">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="bg-background sticky top-0 z-10 border-b p-4">
        <div className="relative">
          <SearchIcon className="text-muted-foreground absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索模型"
            className="h-9 ps-8"
          />
        </div>
        {!hasAuthedModel && (
          <div className="text-muted-foreground mt-3 flex items-start gap-1.5 text-xs">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            尚未配置任何凭据：请在终端运行 pi，执行 /login 登录，或设置对应
            Provider 的 API Key 环境变量，然后重试。
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 p-4">
        {groups.map(([providerName, items]) => (
          <div key={providerName} data-slot="settings-model-group">
            <div className="text-muted-foreground pb-1.5 text-xs font-medium">
              {providerName}
            </div>
            <div className="flex flex-col gap-0.5">
              {items.map((m) => {
                const isSelected =
                  selected?.provider === m.provider && selected?.modelId === m.id;
                return (
                  <button
                    key={`${m.provider}/${m.id}`}
                    type="button"
                    disabled={!m.authed}
                    title={m.authed ? undefined : "未配置该 Provider 的凭据"}
                    onClick={() =>
                      setSelectedModel({ provider: m.provider, modelId: m.id })
                    }
                    data-selected={isSelected}
                    className={cn(
                      "hover:bg-muted flex h-10 items-center gap-2 rounded-md px-2.5 text-sm",
                      "data-selected:bg-muted",
                      !m.authed && "text-muted-foreground/60 cursor-not-allowed",
                    )}
                  >
                    <span className="w-4 shrink-0">
                      {isSelected && <CheckIcon className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-start">
                      {m.name || m.id}
                    </span>
                    {m.reasoning && (
                      <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[11px]">
                        推理
                      </span>
                    )}
                    <span className="text-muted-foreground w-12 shrink-0 text-end text-xs tabular-nums">
                      {fmtContextWindow(m.contextWindow)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="text-muted-foreground py-8 text-center text-sm">
            没有匹配的模型
          </div>
        )}
      </div>
    </div>
  );
};

const SCOPE_LABELS: Record<PiSkillSummary["scope"], string> = {
  project: "项目级",
  user: "全局",
  temporary: "临时",
};

const SKILL_DIR_HINT = "技能目录：~/.pi/agent/skills（全局）与 <工作目录>/.pi/skills（项目级），每个技能一个含 SKILL.md 的文件夹。";

/** 技能页：读取 pi 发现的技能列表（按当前 workspace + 全局目录） */
const SkillsSettings: FC = () => {
  const [skills, setSkills] = useState<PiSkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    if (!isTauri()) return;
    setError(null);
    piRequest<{ type: "skills"; skills: PiSkillSummary[] }>({
      type: "list_skills",
      cwd: getWorkspace() ?? undefined,
    })
      .then((res) => setSkills(res.skills))
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!skills) return [];
    const query = search.trim().toLowerCase();
    return skills.filter(
      (s) =>
        !query ||
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query),
    );
  }, [skills, search]);

  const groups = useMemo(() => {
    const order: PiSkillSummary["scope"][] = ["project", "user", "temporary"];
    const byScope = new Map<PiSkillSummary["scope"], PiSkillSummary[]>();
    for (const s of filtered) {
      const bucket = byScope.get(s.scope);
      if (bucket) bucket.push(s);
      else byScope.set(s.scope, [s]);
    }
    return order
      .filter((scope) => byScope.has(scope))
      .map((scope) => [scope, byScope.get(scope)!] as const);
  }, [filtered]);

  // web 预览没有 Tauri 后端，直接给出降级提示
  if (!isTauri()) {
    return (
      <div className="text-muted-foreground p-5 text-sm">
        技能列表依赖桌面端 pi 服务，请在 Tauri 应用中打开设置。
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5">
        <div className="text-destructive text-sm">加载技能列表失败：{error}</div>
        <Button variant="outline" size="sm" className="mt-3" onClick={load}>
          重试
        </Button>
      </div>
    );
  }

  if (!skills) {
    return (
      <div className="flex flex-col gap-2 p-5">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="bg-background sticky top-0 z-10 border-b p-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon className="text-muted-foreground absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索技能"
              className="h-9 ps-8"
            />
          </div>
          <Button variant="outline" size="icon" className="size-9" onClick={load} title="刷新">
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        <div className="text-muted-foreground mt-3 text-xs">{SKILL_DIR_HINT}</div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {groups.map(([scope, items]) => (
          <div key={scope} data-slot="settings-skill-group">
            <div className="text-muted-foreground pb-1.5 text-xs font-medium">
              {SCOPE_LABELS[scope]} · {items.length}
            </div>
            <div className="flex flex-col gap-0.5">
              {items.map((s) => (
                <div
                  key={s.filePath}
                  title={s.filePath}
                  className="hover:bg-muted flex flex-col gap-0.5 rounded-md px-2.5 py-2"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <SparklesIcon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate font-medium">{s.name}</span>
                  </div>
                  {s.description && (
                    <div className="text-muted-foreground line-clamp-2 ps-5.5 text-xs">
                      {s.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="text-muted-foreground py-8 text-center text-sm">
            没有找到技能
          </div>
        )}
      </div>
    </div>
  );
};
