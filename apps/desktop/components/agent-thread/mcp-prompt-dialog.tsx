"use client";

/**
 * MCP Prompt 参数弹窗：`/` 菜单选中 prompt 后由 composer 打开。
 *
 * 只负责收集参数、调用 sidecar、把渲染后的文本插入输入框——不自动发送。
 * Prompt 内容按用户内容处理，来源服务器只在弹窗里标注，不进入 system prompt。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { getMcpPrompt } from "@/lib/mcp/mcp";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { insertIntoComposer } from "@/components/agent-thread/cm-composer-input";
import { useT } from "@/lib/i18n";

const MCP_PROMPT_EVENT = "kova:open-mcp-prompt";

export type McpPromptInfo = {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type McpPromptRequest = {
  server: string;
  prompt: McpPromptInfo;
};

/** 从 `/` 菜单触发参数弹窗（composer 宿主监听） */
export function requestMcpPrompt(request: McpPromptRequest): void {
  window.dispatchEvent(new CustomEvent<McpPromptRequest>(MCP_PROMPT_EVENT, { detail: request }));
}

export const McpPromptDialog: FC = () => {
  const t = useT();
  const workspace = useWorkspace();
  const [request, setRequest] = useState<McpPromptRequest | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<McpPromptRequest>).detail;
      if (!detail?.server || !detail.prompt?.name) return;
      const initial: Record<string, string> = {};
      for (const arg of detail.prompt.arguments ?? []) initial[arg.name] = "";
      setValues(initial);
      setError(null);
      setBusy(false);
      setRequest(detail);
    };
    window.addEventListener(MCP_PROMPT_EVENT, handler);
    return () => window.removeEventListener(MCP_PROMPT_EVENT, handler);
  }, []);

  const args = useMemo(() => request?.prompt.arguments ?? [], [request]);
  const missing = args.filter((arg) => arg.required && !(values[arg.name] ?? "").trim());

  if (!request) return null;

  const close = () => {
    if (busy) return;
    setRequest(null);
    setError(null);
  };

  const submit = async () => {
    if (busy || missing.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getMcpPrompt(request.server, request.prompt.name, values, workspace);
      if (!insertIntoComposer(res.text)) {
        throw new Error(t("chat.mcpPrompt.composerUnavailable"));
      }
      setRequest(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogTitle>{request.prompt.title || request.prompt.name}</DialogTitle>
        <DialogDescription>
          {request.prompt.description || t("chat.mcpPrompt.noDescription")}
          <span className="text-muted-foreground mt-1 block font-mono text-3xs">
            {request.server} / {request.prompt.name}
          </span>
        </DialogDescription>

        <div className="flex flex-col gap-3 py-1">
          {args.map((arg) => (
            <label key={arg.name} className="flex flex-col gap-1">
              <span className="text-ui leading-5 font-medium">
                {arg.name}
                {arg.required ? <span className="text-destructive ml-0.5">*</span> : null}
              </span>
              {arg.description ? (
                <span className="text-muted-foreground text-3xs leading-4">{arg.description}</span>
              ) : null}
              <Input
                value={values[arg.name] ?? ""}
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, [arg.name]: event.target.value }))
                }
                disabled={busy}
                autoFocus={args[0]?.name === arg.name}
              />
            </label>
          ))}
          {args.length === 0 ? (
            <p className="text-muted-foreground text-ui leading-5">
              {t("chat.mcpPrompt.noArgs")}
            </p>
          ) : null}
          {error ? (
            <p className="text-destructive text-ui leading-5">{error}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("chat.mcpPrompt.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || missing.length > 0}>
            {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {t("chat.mcpPrompt.insert")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
