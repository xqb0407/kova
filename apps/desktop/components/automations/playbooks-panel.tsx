"use client";

/**
 * 工作流剧本面板(自动化页「工作流」段;形态参考 ZCode 的 自动化→工作流 页)。
 *
 * 与 ZCode 的对应关系:
 * - 卡片直排操作(运行 / ⋯删除) + 描述 + 底部「最近运行状态 + 参数 chips」
 * - 分组:「全局(对所有项目可见)」= hostdb 剧本库;工作区 YAML 层(设计文档 §5.2)
 *   落地后接第二个分组
 * - 空态引导「通过对话创建」:回到聊天并切到工作流档(与定时任务的会话创建同款)
 * - 「运行」带参数时先弹参数表单,填好再跑(复用了设置页版的参数表语义)
 *
 * 事实源在 sidecar:listPlaybooksNow / runPlaybookNow / deletePlaybookNow。
 * 运行历史与剧本按 playbookName 关联(运行记录里记了来源剧本)。
 */
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  HistoryIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setSessionMode } from "@/lib/pi/pi-session-mode";
import {
  deletePlaybookNow,
  listPlaybooksNow,
  listRunsNow,
  runPlaybookNow,
} from "@/lib/pi/pi-workflow";
import type { Playbook, PlaybookArg, WorkflowRunSummary } from "pi-protocol";

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

/** 相对时间(历史列表与「最近运行」共用;超过一周落回日期) */
function formatRelative(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${d.getDate()}`;
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

const PlaybookCard: FC<{
  playbook: Playbook;
  lastRun: WorkflowRunSummary | undefined;
  busyName: string | null;
  onRun: (p: Playbook) => void;
  onDelete: (p: Playbook) => void;
}> = ({ playbook, lastRun, busyName, onRun, onDelete }) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const busy = busyName === playbook.name;
  return (
    <div className="border-border/60 bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={playbook.name}>
            {playbook.name}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 shrink-0 gap-1.5 px-2.5"
          disabled={busy}
          onClick={() => onRun(playbook)}
        >
          {busy ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
          运行
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" aria-label="更多操作">
                <MoreHorizontalIcon className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => onRun(playbook)}>
              <PlayIcon className="size-4" />
              运行
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                if (!confirmingDelete) {
                  setConfirmingDelete(true);
                  // 3 秒不点第二次自动回退(与批量删除同款)
                  setTimeout(() => setConfirmingDelete(false), 3000);
                  return;
                }
                setConfirmingDelete(false);
                onDelete(playbook);
              }}
            >
              <Trash2Icon className="size-4" />
              {confirmingDelete ? "确认删除" : "删除"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-muted-foreground line-clamp-2 min-h-8 text-xs leading-relaxed" title={playbook.description}>
        {playbook.whenToUse ? `${playbook.description ? `${playbook.description} · ` : ""}使用时机:${playbook.whenToUse}` : playbook.description || "—"}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground/80 shrink-0 text-[11px]">
          {lastRun
            ? `上次运行 ${formatRelative(lastRun.updatedAt)} · ${RUN_STATUS_LABEL[lastRun.status] ?? lastRun.status}`
            : "尚未运行"}
        </span>
        <span className="flex-1" />
        {playbook.args.map((a) => (
          <span
            key={a.name}
            className="border-border/60 bg-muted/50 text-muted-foreground rounded border px-1.5 py-px font-mono text-[10px]"
            title={a.description ?? `${a.name} (${a.type}${a.required ? ", 必填" : ""})`}
          >
            {a.name}
          </span>
        ))}
        {playbook.args.length === 0 && (
          <span className="text-muted-foreground/60 text-[10px]">
            {playbook.steps.length} 步 · 无参数
          </span>
        )}
      </div>
    </div>
  );
};

export const PlaybooksPanel: FC<{
  /** 空态「通过对话创建」:回到聊天并切到工作流档 */
  onBackToChat?: () => void;
}> = ({ onBackToChat }) => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const [playbooks, setPlaybooks] = useState<Playbook[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  // 参数表单:有参数的剧本先填再跑(无参数直接跑)
  const [pendingRun, setPendingRun] = useState<Playbook | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    void listPlaybooksNow()
      .then((list) => {
        setPlaybooks(list);
        setError(null);
      })
      .catch((err) => setError(errMsg(err)));
    void listRunsNow(threadId)
      .then(setRuns)
      .catch(() => {});
  }, [threadId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** 剧本 → 最近一次运行(运行记录里记了来源剧本名) */
  const lastRunByName = useMemo(() => {
    const map = new Map<string, WorkflowRunSummary>();
    for (const r of runs) {
      if (!r.playbookName || map.has(r.playbookName)) continue;
      map.set(r.playbookName, r);
    }
    return map;
  }, [runs]);

  const doRun = (playbook: Playbook, values: Record<string, unknown>) => {
    if (!threadId) {
      toast.error("会话未就绪，稍后再试");
      return;
    }
    setBusyName(playbook.name);
    void runPlaybookNow(threadId, playbook.name, values)
      .then(() => {
        toast.success(`已发起「${playbook.name}」运行，回聊天查看进度`);
        onBackToChat?.();
        refresh();
      })
      .catch((err) => toast.error(`发起运行失败：${errMsg(err)}`))
      .finally(() => setBusyName(null));
  };

  const onRun = (playbook: Playbook) => {
    if (playbook.args.length === 0) {
      doRun(playbook, {});
      return;
    }
    setInputs({});
    setPendingRun(playbook);
  };

  const onDelete = (playbook: Playbook) => {
    void deletePlaybookNow(playbook.name)
      .then(() => {
        toast.success(`已删除「${playbook.name}」`);
        refresh();
      })
      .catch((err) => toast.error(`删除失败：${errMsg(err)}`));
  };

  const createViaChat = () => {
    onBackToChat?.();
    requestAnimationFrame(() => {
      // 切到工作流档 + 预填指令:与「自动化→会话创建」同款路径
      if (threadId) {
        void setSessionMode(threadId, "workflow").catch(() => {});
      }
      // 祈使式:让这句读起来是「去拟剧本」而不是「聊一个设计」——实机反馈里
      // 「帮我设计一个工作流」被模型当成了设计咨询,回了整篇 prose
      aui.composer.setText("把这件事编排成工作流剧本（我确认后执行）：");
    });
  };

  const submitPendingRun = () => {
    if (!pendingRun) return;
    const collected = collectArgs(pendingRun.args, inputs);
    if (!collected.ok) {
      toast.error(collected.error);
      return;
    }
    const playbook = pendingRun;
    setPendingRun(null);
    doRun(playbook, collected.values);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 分组:全局(hostdb 剧本库,对所有项目可见)。工作区 YAML 层落地后接第二组 */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">已保存的剧本</span>
        <Badge variant="secondary" className="text-[10px]">
          全局 · 对所有项目可见
        </Badge>
        <span className="text-muted-foreground text-xs">
          {playbooks === null ? "" : playbooks.length}
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={refresh}
          title="刷新"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {error && (
        <div className="text-red-500 bg-red-500/5 border-red-500/20 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={refresh}>
            重试
          </Button>
        </div>
      )}

      {playbooks === null ? (
        <div className="text-muted-foreground text-sm">加载中…</div>
      ) : playbooks.length === 0 ? (
        <div className="border-border/60 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
          <WorkflowIcon className="text-muted-foreground size-8 opacity-60" />
          <p className="text-foreground text-sm font-semibold">还没有保存的剧本</p>
          <p className="text-muted-foreground max-w-md text-xs leading-relaxed">
            在工作流档把一个任务跑通，运行卡上点「存为剧本」就会出现在这里；
            剧本可以带参数，之后填好参数就能再跑一次。
          </p>
          <Button size="sm" className="gap-1.5" onClick={createViaChat}>
            <PlusIcon className="size-4" />
            通过对话创建
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {playbooks.map((p) => (
            <PlaybookCard
              key={p.id}
              playbook={p}
              lastRun={lastRunByName.get(p.name)}
              busyName={busyName}
              onRun={onRun}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {/* 运行历史:与剧本按 playbookName 关联;卡片上的「上次运行」也来自这份 */}
      {runs.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <HistoryIcon className="text-muted-foreground size-4" />
            <span className="text-sm font-medium">运行历史</span>
            <span className="text-muted-foreground text-xs">{runs.length}</span>
          </div>
          {runs.slice(0, 20).map((r) => (
            <div
              key={r.runId}
              className="border-border/60 flex items-center gap-3 rounded-lg border px-3 py-2"
            >
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
                {r.doneCount}/{r.stepCount} 步 · {formatTokens(r.tokensUsed)} token ·{" "}
                {formatRelative(r.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 参数表单(有参数的剧本):与设置页同款校验,填好再跑 */}
      <Dialog open={pendingRun !== null} onOpenChange={(open) => !open && setPendingRun(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>运行「{pendingRun?.name}」</DialogTitle>
            <DialogDescription>填好参数后发起运行；留空且带默认值的参数会用默认值。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {pendingRun?.args.map((arg) => (
              <div key={arg.name} className="flex flex-col gap-1">
                <label className="text-muted-foreground font-mono text-xs">
                  {arg.name}
                  {arg.required && <span className="text-red-500"> *</span>}
                  <span className="text-muted-foreground/60 ml-1 font-sans">({arg.type})</span>
                </label>
                <Input
                  className="h-8 text-sm"
                  placeholder={arg.default !== undefined ? `默认 ${String(arg.default)}` : arg.type}
                  value={inputs[arg.name] ?? ""}
                  onChange={(e) => setInputs((v) => ({ ...v, [arg.name]: e.target.value }))}
                />
                {arg.description && (
                  <span className="text-muted-foreground/70 text-[11px]">{arg.description}</span>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingRun(null)}>
              取消
            </Button>
            <Button onClick={submitPendingRun}>开始运行</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
