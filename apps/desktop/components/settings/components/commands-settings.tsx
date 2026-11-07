"use client";

import { useEffect, useState, type FC } from "react";
import { CopyIcon, PencilIcon, PlusIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import {
  deleteCommand,
  saveCommand,
  useCustomCommands,
  type CustomCommand,
} from "@/lib/pi/pi-commands";
import { cn } from "@/lib/utils";

/**
 * 设置 → 命令（管理页「命令」分段）：自定义斜杠命令的增删改。
 * 事实源在 sidecar（.kova/commands 工作区 / ~/.kova/commands 全局 / 内置），
 * 保存/删除应答即刷新后的清单。内置命令只读 + 可「复制到工作区」改一份。
 * 前端动作命令（/plan /ask /goal…）是保留名，sidecar 保存时拒绝。
 */

type Draft = {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
  scope: "workspace" | "global";
  replaceName?: string;
};

const SOURCE_BADGE: Record<CustomCommand["source"], string> = {
  builtin: "内置",
  workspace: "工作区",
  global: "全局",
};

const emptyDraft = (scope: "workspace" | "global"): Draft => ({
  name: "",
  description: "",
  argumentHint: "",
  body: "",
  scope,
});

export const CommandsSettings: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const workspace = useWorkspace();
  const base = useCustomCommands(workspace);
  const [items, setItems] = useState<CustomCommand[]>(base);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setItems(base), [base]);

  const workspaceAvailable = Boolean(workspace);

  const startNew = () => {
    setError("");
    setDraft(emptyDraft(workspaceAvailable ? "workspace" : "global"));
  };

  const startEdit = (c: CustomCommand) => {
    setError("");
    if (c.source === "builtin") {
      // 内置命令不可改：复制一份到工作区改（scope 固定 workspace，无 replaceName）
      setDraft({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint ?? "",
        body: c.body ?? "",
        scope: "workspace",
      });
      return;
    }
    setDraft({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint ?? "",
      body: c.body ?? "",
      scope: c.source,
      replaceName: c.name,
    });
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const list = await saveCommand({
        cwd: workspace,
        scope: draft.scope,
        name: draft.name,
        description: draft.description,
        argumentHint: draft.argumentHint || undefined,
        body: draft.body,
        ...(draft.replaceName ? { replaceName: draft.replaceName } : {}),
      });
      setItems(list);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string, scope: "workspace" | "global") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const list = await deleteCommand({ cwd: workspace, scope, name });
      setItems(list);
      setConfirmName(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          自定义斜杠命令：菜单选中后展开为提示词模板（$ARGUMENTS 会被参数替换）。
          工作区命令随 git 共享，全局命令本机可用，内置 /init 可复制后改。
        </p>
        <button
          type="button"
          onClick={startNew}
          disabled={!embedded && !workspaceAvailable}
          className="hover:bg-accent flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
        >
          <PlusIcon className="size-3.5" />
          新建命令
        </button>
      </div>
      {error ? (
        <p className="text-destructive rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {draft ? (
        <div className="flex flex-col gap-2.5 rounded-xl border p-3.5">
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">命令名</span>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <span className="text-muted-foreground">/</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="my-command"
                disabled={Boolean(draft.replaceName)}
                className="w-56 rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              />
              {draft.replaceName ? (
                <span className="text-muted-foreground text-xs">
                  改名保存后移除旧文件 /{draft.replaceName}
                </span>
              ) : null}
            </div>
          </div>
          <label className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">描述</span>
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="菜单里显示的说明"
              className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <label className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">参数提示</span>
            <input
              value={draft.argumentHint}
              onChange={(e) => setDraft({ ...draft, argumentHint: e.target.value })}
              placeholder="（可选）如 &lt;文件路径&gt;"
              className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">层级</span>
            <div className="flex items-center gap-1.5">
              {(["workspace", "global"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  disabled={scope === "workspace" && !workspaceAvailable}
                  onClick={() => setDraft({ ...draft, scope })}
                  className={cn(
                    "rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40",
                    draft.scope === scope
                      ? "bg-accent border-ring text-foreground"
                      : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {scope === "workspace" ? "工作区（随 git 共享）" : "全局（本机）"}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-sm">
              模板正文（$ARGUMENTS 会被命令后的参数替换；不写占位符则参数追加在尾部）
            </span>
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={10}
              placeholder="给模型的提示词模板…"
              className="min-h-40 flex-1 rounded-lg border px-2.5 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy || !draft.name.trim()}
              className="rounded-lg bg-primary px-3.5 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="hover:bg-accent rounded-lg px-3 py-1.5 text-sm transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
          {items.length === 0 ? (
            <p className="text-muted-foreground px-3.5 py-6 text-center text-sm">
              还没有自定义命令——新建一个，或在仓库里放 .kova/commands/*.md
            </p>
          ) : (
            <ul className="flex flex-col">
              {items.map((c) => (
                <li
                  key={`${c.source}:${c.name}`}
                  className="hover:bg-muted/40 flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0"
                >
                  <ZapIcon className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">/{c.name}</span>
                      <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-px text-[11px] leading-4">
                        {SOURCE_BADGE[c.source]}
                      </span>
                    </div>
                    <p className="text-muted-foreground truncate text-xs">
                      {c.description || "自定义命令"}
                      {c.argumentHint ? ` · ${c.argumentHint}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {c.source === "builtin" ? (
                      <button
                        type="button"
                        onClick={() => startEdit(c)}
                        title="复制到工作区改一份"
                        className="hover:bg-accent flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors"
                      >
                        <CopyIcon className="size-3.5" />
                        复制
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(c)}
                          title="编辑"
                          className="hover:bg-accent rounded-lg p-1.5 transition-colors"
                        >
                          <PencilIcon className="size-3.5" />
                        </button>
                        {confirmName === `${c.source}:${c.name}` ? (
                          <button
                            type="button"
                            onClick={() => remove(c.name, c.source === "global" ? "global" : "workspace")}
                            className="text-destructive rounded-lg px-2 py-1 text-xs hover:bg-destructive/10"
                          >
                            确认删除
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmName(`${c.source}:${c.name}`)}
                            title="删除"
                            className="hover:bg-accent text-muted-foreground rounded-lg p-1.5 transition-colors hover:text-destructive"
                          >
                            <Trash2Icon className="size-3.5" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
