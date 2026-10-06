"use client";

/**
 * 工作流剧本(设置 → 智能体 → 工作流剧本)。
 *
 * 剧本 = 可参数化重放的编排资产:从一次成功运行「存为剧本」(运行卡按钮),
 * 或由模型拟好剧本后保存。事实源在 sidecar 的 hostdb(pi.workflow.playbooks),
 * 本页只渲染 listPlaybooksNow 的快照并发起变更命令。
 *
 * 两个 tab(对齐 ZCode 剧本详情页的形态):
 * - 剧本库:每条剧本的名称/说明/使用时机/参数表/步骤概览;参数可填,「运行」按
 *   参数发起一次运行(该线程会切到工作流档,回聊天即见运行卡)
 * - 运行历史:.kova/workflows 目录的摘要投影(全部运行,不限剧本)
 */
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ChevronDownIcon,
  HistoryIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  deletePlaybookNow,
  listPlaybooksNow,
  listRunsNow,
  runPlaybookNow,
} from "@/lib/pi/pi-workflow";
import type { Playbook, PlaybookArg, WorkflowRunSummary } from "pi-protocol";

const KIND_MARK: Record<string, string> = {
  synthesize: "◆",
  gate: "▣",
  verify: "◈",
  delegate: "▸",
};

const RUN_STATUS_LABEL: Record<string, string> = {
  proposing: "编排中",
  proposed: "待确认",
  running: "运行中",
  paused: "已暂停",
  complete: "已完成",
  failed: "失败",
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatWhen(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 参数值收集:按声明类型把输入串转成值(number 解析失败即报错拦住) */
function collectArgs(
  decls: PlaybookArg[],
  inputs: Record<string, string>,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const values: Record<string, unknown> = {};
  for (const decl of decls) {
    const raw = (inputs[decl.name] ?? "").trim();
    if (!raw) {
      if (decl.required) return { ok: false, error: `「${decl.name}」是必填参数` };
      if (decl.default !== undefined) values[decl.name] = decl.default;
      continue;
    }
    if (decl.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `「${decl.name}」需要数字` };
      values[decl.name] = n;
    } else if (decl.type === "boolean") {
      values[decl.name] = raw === "true" || raw === "1";
    } else {
      values[decl.name] = raw;
    }
  }
  return { ok: true, values };
}

const PlaybookRow: FC<{
  playbook: Playbook;
  threadId: string | undefined;
}> = ({ playbook, threadId }) => {
  const [expanded, setExpanded] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const run = () => {
    if (!threadId) {
      toast.error("会话未就绪，稍后再试");
      return;
    }
    const collected = collectArgs(playbook.args, inputs);
    if (!collected.ok) {
      toast.error(collected.error);
      return;
    }
    setBusy(true);
    void runPlaybookNow(threadId, playbook.name, collected.values)
      .then(() => toast.success(`已发起「${playbook.name}」运行，回聊天查看进度`))
      .catch((err) => toast.error(`发起运行失败：${errMsg(err)}`))
      .finally(() => setBusy(false));
  };

  const remove = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    void deletePlaybookNow(playbook.name)
      .then(() => toast.success(`已删除「${playbook.name}」`))
      .catch((err) => toast.error(`删除失败：${errMsg(err)}`));
  };

  return (
    <div className="border-border/60 rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDownIcon
            className={cn("text-muted-foreground size-4 shrink-0 transition-transform", expanded && "rotate-180")}
          />
          <WorkflowIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 truncate text-sm font-medium">{playbook.name}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {playbook.steps.length} 步
          </Badge>
          {playbook.args.length > 0 && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {playbook.args.length} 参数
            </Badge>
          )}
          {playbook.source === "from-run" && (
            <span className="text-muted-foreground/70 shrink-0 text-[10px]">来自运行</span>
          )}
        </button>
        <Button size="sm" className="h-7 shrink-0 px-2.5" disabled={busy} onClick={run}>
          <PlayIcon className="size-3" />
          运行
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 shrink-0 px-2", confirmingDelete && "text-red-600 dark:text-red-400")}
          onClick={remove}
          onBlur={() => setConfirmingDelete(false)}
          title={confirmingDelete ? "再点一次确认删除" : "删除这条剧本"}
        >
          <Trash2Icon className="size-3" />
          {confirmingDelete ? "确认删除" : ""}
        </Button>
      </div>
      {expanded && (
        <div className="border-border/60 flex flex-col gap-3 border-t px-3 py-3">
          {playbook.description && (
            <p className="text-muted-foreground text-xs leading-relaxed">{playbook.description}</p>
          )}
          {playbook.whenToUse && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              <span className="text-foreground/80 font-medium">使用时机：</span>
              {playbook.whenToUse}
            </p>
          )}
          {playbook.args.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium">参数</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {playbook.args.map((arg) => (
                  <div key={arg.name} className="flex items-center gap-2">
                    <label className="text-muted-foreground w-32 shrink-0 truncate font-mono text-[11px]" title={arg.name}>
                      {arg.name}
                      {arg.required && <span className="text-red-500"> *</span>}
                    </label>
                    <Input
                      className="h-7 text-xs"
                      placeholder={arg.default !== undefined ? `默认 ${String(arg.default)}` : arg.type}
                      value={inputs[arg.name] ?? ""}
                      onChange={(e) => setInputs((v) => ({ ...v, [arg.name]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <div className="text-xs font-medium">步骤</div>
            {playbook.steps.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground shrink-0">
                  {KIND_MARK[s.kind] ?? "▸"} {s.title}
                </span>
                {s.agent && <span className="text-muted-foreground/70 shrink-0">@{s.agent}</span>}
                {s.gate && (
                  <code className="border-border/60 bg-background/70 truncate rounded border px-1 py-px font-mono text-[10px]">
                    {[s.gate.command, ...(s.gate.args ?? [])].join(" ")}
                  </code>
                )}
                {s.foreach && (
                  <span className="text-muted-foreground/70 shrink-0">按 {s.foreach.from} 逐行展开</span>
                )}
              </div>
            ))}
          </div>
          <div className="text-muted-foreground/70 text-[10px]">
            更新于 {formatWhen(playbook.updatedAt)}
          </div>
        </div>
      )}
    </div>
  );
};

export const PlaybooksSettings: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("library");

  const refreshPlaybooks = useCallback(() => {
    listPlaybooksNow()
      .then((list) => {
        setPlaybooks(list);
        setError(null);
      })
      .catch((err) => setError(errMsg(err)));
  }, []);

  useEffect(() => {
    refreshPlaybooks();
  }, [refreshPlaybooks]);

  useEffect(() => {
    if (tab !== "history" || runs !== null) return;
    listRunsNow(threadId)
      .then(setRuns)
      .catch((err) => setError(errMsg(err)));
  }, [tab, runs, threadId]);

  const headerHint = useMemo(() => {
    if (error) return "清单加载失败，可刷新重试";
    return `${playbooks.length} 条剧本 · 运行历史来自当前工作区`;
  }, [error, playbooks.length]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-7xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">工作流剧本</h1>
          <div className="flex items-center gap-2">
            <span className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
              {headerHint}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                setRuns(null);
                refreshPlaybooks();
              }}
              title="刷新"
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
        </div>

        <p className="text-muted-foreground -mt-5 text-sm leading-relaxed">
          剧本是可复用的多智能体编排:在工作流档跑成一次后点「存为剧本」入库，
          这里按参数重跑。步骤 prompt 里的 {"{{args.名称}}"} 占位符会自动变成上面的参数表；
          运行会在当前会话发起，回聊天即可看运行卡。
        </p>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="library">剧本库</TabsTrigger>
            <TabsTrigger value="history">
              <HistoryIcon className="mr-1 size-3.5" />
              运行历史
            </TabsTrigger>
          </TabsList>
          <TabsContent value="library" className="flex flex-col gap-2.5 pt-4">
            {playbooks.length === 0 ? (
              <div className="border-border/60 text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                还没有剧本。切到工作流档跑成一次任务，在运行卡上点「存为剧本」即可入库。
              </div>
            ) : (
              playbooks.map((p) => <PlaybookRow key={p.id} playbook={p} threadId={threadId} />)
            )}
          </TabsContent>
          <TabsContent value="history" className="flex flex-col gap-2 pt-4">
            {runs === null ? (
              <div className="text-muted-foreground text-sm">加载中…</div>
            ) : runs.length === 0 ? (
              <div className="border-border/60 text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                这个工作区还没有运行记录。
              </div>
            ) : (
              runs.map((r) => (
                <div key={r.runId} className="border-border/60 flex items-center gap-3 rounded-lg border px-3 py-2">
                  <span
                    className={cn(
                      "shrink-0 text-xs",
                      r.status === "running"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : r.status === "complete"
                          ? "text-muted-foreground"
                          : "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {RUN_STATUS_LABEL[r.status] ?? r.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm" title={r.objective}>
                    {r.title || r.objective}
                  </span>
                  {r.playbookName && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {r.playbookName}
                    </Badge>
                  )}
                  <span className="text-muted-foreground/70 shrink-0 text-[11px] tabular-nums">
                    {r.doneCount}/{r.stepCount} 步 · {formatTokens(r.tokensUsed)} token · {formatWhen(r.updatedAt)}
                  </span>
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};
