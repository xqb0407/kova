"use client";

/**
 * MCP 设置页（设置 → 智能体 → MCP）。样式骨架对齐记忆设置页：
 * 整页滚动 + 大标题（右侧状态文字）+ 作用域 Tabs（系统级/工作区级）+
 * 工具行（工作区切换/搜索/刷新/新建）+ bg-muted/50 卡片内行列表。
 *
 * 事实源在 sidecar：三层配置（系统 ~/.kova/mcp.json / 工作区 .mcp.json / 工作区
 * 覆盖 .kova/mcp.json）+ kv 里的启停开关；本页只渲染 useMcpServers 镜像并发起
 * 变更命令（清单应答自带连接状态）。工作区标准层 .mcp.json 是共享文件：
 * 条目可被覆盖层接管编辑，但不从设置页直接改写（sidecar 拒绝并解释）。
 */
import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import {
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  FlaskConicalIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/custom-ui/segmented";
import { Badge } from "@/components/ui/badge";
import { AnimatedBadge } from "@/components/custom-ui/animated-badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { JsonCodeEditor } from "@/components/code/cm-json-editor";
import { isDesktop } from "@/lib/desktop-env";
import { pathBasename, useWorkspace, useWorkspaceRecents } from "@/lib/workspace/workspace-store";
import {
  authorizeMcpServer,
  deleteMcpServer,
  fetchMcpAuditLog,
  fetchMcpServerLog,
  fetchMcpServerTools,
  reconcileMcpConnections,
  refreshMcpServers,
  revokeMcpServerAuth,
  saveMcpServer,
  setMcpAuthHandler,
  setMcpServerEnabled,
  testMcpServer,
  useMcpServers,
  type McpAuditEvent,
  type McpLogLine,
  type McpSecretEnvBinding,
  type McpServerDraft,
  type McpToolInfo,
  type McpServerEntry,
  type McpServerIcon,
} from "@/lib/mcp/mcp";
import { refreshSecrets, useSecrets } from "@/lib/secrets/secrets-store";
import { openExternal } from "@/lib/external-link";
import { useHtmlDark } from "@/lib/settings/use-html-dark";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";

type ScopeTab = "system" | "workspace";

const LIFECYCLE_LABEL: Record<"lazy" | "eager" | "keep-alive", string> = {
  lazy: "lazy（默认：空闲断开）",
  eager: "eager（保持连接）",
  "keep-alive": "keep-alive（保持连接）",
};

const STATE_LABEL: Record<McpServerEntry["status"]["state"], string> = {
  idle: "未连接",
  connecting: "连接中",
  ready: "已连接",
  backoff: "失败退避",
};

const STATE_DOT: Record<McpServerEntry["status"]["state"], string> = {
  idle: "bg-muted-foreground/40",
  connecting: "bg-amber-500 animate-pulse",
  ready: "bg-emerald-500",
  backoff: "bg-destructive",
};

/** 非 loopback 明文 HTTP 检测（与 sidecar 校验口径一致：允许但强制警示） */
export function isNonLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return false;
    return !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 编辑弹窗（表单 → sidecar 校验；错误就地展示）
// ---------------------------------------------------------------------------

type FormDraft = {
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  description: string;
  lifecycle: "lazy" | "eager" | "keep-alive";
  idleTimeoutText: string;
  callTimeoutText: string;
  approveToolsText: string;
  /** MCP stdio 的密钥注入（仅全局作用域；值不在这里，只有名字） */
  secretEnv: McpSecretEnvBinding[];
};

const EMPTY_FORM: FormDraft = {
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  envText: "",
  url: "",
  headersText: "",
  description: "",
  lifecycle: "lazy",
  idleTimeoutText: "",
  callTimeoutText: "",
  approveToolsText: "",
  secretEnv: [],
};

/** 密钥环境变量名规则（与 sidecar / 密钥库同款） */
const SECRET_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** "A=1\nB=2" → Record（忽略空行与无 = 的行） */
function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function keyValuesToText(map: Record<string, string> | undefined): string {
  if (!map) return "";
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** 与 sidecar computeConfigHash 对齐的语义签名（排序 env/headers 键序）。 */
function formConfigSignature(form: FormDraft): string {
  const stdio = form.transport === "stdio";
  const args = stdio
    ? form.argsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const mapEntries = (text: string) =>
    Object.entries(parseKeyValueLines(text)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const env = stdio ? mapEntries(form.envText) : [];
  const headers = stdio ? [] : mapEntries(form.headersText);
  return JSON.stringify({
    transport: form.transport,
    command: stdio ? form.command.trim() : null,
    args: stdio && args.length > 0 ? args : null,
    env: stdio && env.length > 0 ? env : null,
    url: stdio ? null : form.url.trim(),
    headers: headers.length > 0 ? headers : null,
  });
}

function entryToForm(entry: McpServerEntry): FormDraft {
  return {
    name: entry.name,
    transport: entry.transport,
    command: entry.command ?? "",
    argsText: (entry.args ?? []).join("\n"),
    envText: keyValuesToText(entry.env),
    url: entry.url ?? "",
    headersText: keyValuesToText(entry.headers),
    description: entry.description ?? "",
    lifecycle: entry.lifecycle ?? "lazy",
    idleTimeoutText: entry.idleTimeout !== undefined ? String(entry.idleTimeout) : "",
    callTimeoutText: entry.callTimeout !== undefined ? String(entry.callTimeout) : "",
    approveToolsText: (entry.approveTools ?? []).join(", "),
    secretEnv: (entry.secretEnv ?? []).map((b) => ({
      envName: b.envName,
      name: b.name,
      scope: "global" as const,
    })),
  };
}

/** "120000" → 120000；空 → undefined（用默认值）；非法 → 错误文案 */
function parseTimeoutText(text: string, label: string): number | string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 5_000) return `${label}需为 ≥5000 的毫秒数`;
  return Math.floor(n);
}

function formToDraft(form: FormDraft): McpServerDraft | string {
  if (form.transport === "stdio") {
    const seen = new Set<string>();
    for (const row of form.secretEnv) {
      const envName = row.envName.trim();
      if (!SECRET_ENV_NAME_RE.test(envName)) {
        return "密钥环境变量名需匹配 [A-Za-z_][A-Za-z0-9_]*";
      }
      if (!row.name) return `环境变量 ${envName} 还没有选择密钥`;
      if (seen.has(envName)) return `环境变量 ${envName} 重复绑定`;
      seen.add(envName);
    }
  }
  const idleTimeout = parseTimeoutText(form.idleTimeoutText, "空闲断开时间");
  if (typeof idleTimeout === "string") return idleTimeout;
  const callTimeout = parseTimeoutText(form.callTimeoutText, "工具调用超时");
  if (typeof callTimeout === "string") return callTimeout;
  const args = form.argsText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const approve = form.approveToolsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const env = parseKeyValueLines(form.envText);
  const headers = parseKeyValueLines(form.headersText);
  return {
    name: form.name.trim(),
    transport: form.transport,
    ...(form.transport === "stdio"
      ? {
          command: form.command.trim(),
          ...(args.length ? { args } : {}),
          ...(Object.keys(env).length ? { env } : {}),
        }
      : {
          url: form.url.trim(),
          ...(Object.keys(headers).length ? { headers } : {}),
        }),
    description: form.description.trim() || undefined,
    lifecycle: form.lifecycle,
    ...(idleTimeout !== undefined ? { idleTimeout } : {}),
    ...(callTimeout !== undefined ? { callTimeout } : {}),
    ...(approve.length ? { approveTools: approve } : {}),
  };
}

type EditorTarget =
  | { mode: "create"; layer: "system" | "workspace" }
  | { mode: "edit"; entry: McpServerEntry }
  | { mode: "json"; layer: "system" | "workspace" };

/** 可写层收窄：插件层条目不渲染任何编辑/删除/测试入口，此分支实际不可达（防御式兜底） */
const writableLayer = (l: McpServerEntry["layer"]): "system" | "workspace" =>
  l === "workspace" ? "workspace" : "system";

const McpEditorDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditorTarget | null;
  workspaceCwd: string | null;
}> = ({ open, onOpenChange, target, workspaceCwd }) => {
  // 系统层命令也要带一个「当前会话工作区」的 cwd：sidecar 变更后会按该 cwd
  // 重调连接池；不带 cwd 会把 workspace 服务器全部判为不在启用集合里而断开。
  const activeWorkspace = useWorkspace();
  const isEdit = target?.mode === "edit";
  const secrets = useSecrets();
  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 配置变更时保留原绑定的显式勾选；动密钥行会自动勾上（= 对新配置重新授权） */
  const [keepBindingsOnConfigChange, setKeepBindingsOnConfigChange] = useState(false);

  useEffect(() => {
    if (!open || !target) return;
    setForm(target.mode === "edit" ? entryToForm(target.entry) : EMPTY_FORM);
    setError(null);
    setBusy(false);
    setKeepBindingsOnConfigChange(false);
  }, [open, target]);

  useEffect(() => {
    if (open) void refreshSecrets();
  }, [open]);

  const globalSecrets = useMemo(
    () => secrets.entries.filter((e) => e.scope === "global" && e.readable),
    [secrets.entries],
  );

  if (!target || target.mode === "json") return null;
  const layer = writableLayer(target.mode === "create" ? target.layer : target.entry.layer);
  const layerNeedsCwd = layer === "workspace" && !workspaceCwd;
  const insecureHttp =
    form.transport === "http" && isNonLoopbackHttpUrl(form.url);
  const configChanged =
    isEdit && target.mode === "edit"
      ? formConfigSignature(form) !== formConfigSignature(entryToForm(target.entry))
      : false;

  const setField = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const updateSecretRow = (
    index: number,
    patch: Partial<McpSecretEnvBinding>,
  ) => {
    setKeepBindingsOnConfigChange(true);
    setForm((f) => ({
      ...f,
      secretEnv: f.secretEnv.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  };

  const addSecretRow = () => {
    setKeepBindingsOnConfigChange(true);
    setForm((f) => ({
      ...f,
      secretEnv: [
        ...f.secretEnv,
        { envName: "", name: globalSecrets[0]?.name ?? "", scope: "global" },
      ],
    }));
  };

  const removeSecretRow = (index: number) => {
    setKeepBindingsOnConfigChange(true);
    setForm((f) => ({ ...f, secretEnv: f.secretEnv.filter((_, i) => i !== index) }));
  };

  const save = async () => {
    if (busy) return;
    const draft = formToDraft(form);
    if (typeof draft === "string") {
      setError(draft);
      return;
    }
    // 配置字段变了但用户没动密钥行：默认解除旧绑定（不把旧密钥续到新命令）。
    // 勾选“保留”或实际改过密钥行（会自动勾上）= 对新配置的显式授权。
    const keepBindings = !configChanged || keepBindingsOnConfigChange;
    const submitted =
      form.transport === "stdio"
        ? form.secretEnv.map((row) => ({
            envName: row.envName.trim(),
            name: row.name,
            scope: "global" as const,
          }))
        : [];
    const secretEnv = keepBindings ? submitted : [];
    const secretBindingHash =
      isEdit && target.mode === "edit" && !(configChanged && keepBindings)
        ? target.entry.configHash
        : undefined;
    // 新建且没填密钥时不发 secretEnv：避免“新建同名工作区覆盖”顺手把
    // 系统层已有的绑定清掉；编辑总是发送（空数组 = 用户明确解除）。
    const sendSecretEnv = isEdit || secretEnv.length > 0;
    setBusy(true);
    setError(null);
    try {
      await saveMcpServer({
        layer,
        cwd:
          layer === "workspace"
            ? workspaceCwd ?? undefined
            : activeWorkspace ?? undefined,
        viewCwd: workspaceCwd,
        ...(isEdit && target.mode === "edit" ? { name: target.entry.name } : {}),
        definition: draft,
        ...(sendSecretEnv ? { secretEnv } : {}),
        ...(secretBindingHash ? { secretBindingHash } : {}),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-6rem)] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {/* 页头：协议图标 + 标题 + 保存位置（与技能编辑弹窗同款） */}
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div
            className={cn(
              "grid size-12 shrink-0 place-items-center rounded-2xl",
              form.transport === "http"
                ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                : "bg-violet-500/10 text-violet-600 dark:text-violet-400",
            )}
          >
            {form.transport === "http" ? (
              <ServerIcon className="size-6" />
            ) : (
              <SquareTerminalIcon className="size-6" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-md font-semibold tracking-tight">
              {target.mode === "create"
                ? layer === "workspace"
                  ? "新建工作区 MCP 服务器"
                  : "新建系统 MCP 服务器"
                : `编辑 ${target.entry.name}`}
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm">
              {layer === "workspace"
                ? `保存到 ${workspaceCwd ?? ""}/.kova/mcp.json · 随仓库共享`
                : "保存到 ~/.kova/mcp.json · 对本机所有工作区生效"}
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex min-w-0 flex-col gap-4">
          <div className="flex gap-3">
            <Label className="flex min-w-0 flex-1 flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-[13px] leading-5">名称</span>
              <Input
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="如 github（字母/数字/_/-，≤64）"
                className="font-mono"
              />
            </Label>
            <div className="flex shrink-0 flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-[13px] leading-5">传输</span>
              <Segmented
                value={form.transport}
                options={[
                  { value: "stdio", label: "本地进程" },
                  { value: "http", label: "HTTP" },
                ]}
                onChange={(t) => setField("transport", t)}
              />
            </div>
          </div>

          {form.transport === "stdio" ? (
            <>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-[13px] leading-5">启动命令</span>
                <Input
                  value={form.command}
                  onChange={(e) => setField("command", e.target.value)}
                  placeholder="如 npx（不含 .. 的命令名或绝对路径）"
                  className="font-mono"
                />
              </Label>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-[13px] leading-5">参数（每行一个）</span>
                <Textarea
                  value={form.argsText}
                  onChange={(e) => setField("argsText", e.target.value)}
                  rows={3}
                  className="font-mono text-[13px] leading-5"
                  placeholder={"-y\n@modelcontextprotocol/server-xxx"}
                  spellCheck={false}
                />
              </Label>
            </>
          ) : (
            <>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-[13px] leading-5">端点 URL</span>
                <Input
                  value={form.url}
                  onChange={(e) => setField("url", e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="font-mono"
                />
              </Label>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-[13px] leading-5">请求头（每行 Key=Value）</span>
                <Textarea
                  value={form.headersText}
                  onChange={(e) => setField("headersText", e.target.value)}
                  rows={3}
                  className="font-mono text-[13px] leading-5"
                  placeholder={"Authorization=Bearer ..."}
                  spellCheck={false}
                />
              </Label>
            </>
          )}

          {form.transport === "stdio" && (
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-[13px] leading-5">
                环境变量（每行 KEY=value；只有这里声明的变量会传给子进程）
              </span>
              <Textarea
                value={form.envText}
                onChange={(e) => setField("envText", e.target.value)}
                rows={3}
                className="font-mono text-[13px] leading-5"
                placeholder={"GITHUB_TOKEN=..."}
                spellCheck={false}
              />
            </Label>
          )}

          {form.transport === "stdio" && (
            <div className="bg-muted/30 flex flex-col gap-2 rounded-xl border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] leading-5 font-medium">
                    <KeyRoundIcon className="size-3.5" />
                    密钥注入
                  </span>
                  <span className="text-muted-foreground text-[13px] leading-5">
                    从密钥库选择全局密钥，握手时注入子进程；同名时覆盖上面的字面值。
                    密钥值不写入 mcp.json，绑定只保存在本机。
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[13px] leading-5"
                  onClick={addSecretRow}
                  disabled={globalSecrets.length === 0}
                  title={
                    globalSecrets.length === 0
                      ? "先在 设置 → 智能体 → 密钥 创建全局密钥"
                      : "添加一条密钥绑定"
                  }
                >
                  <PlusIcon className="size-3.5" />
                  添加
                </Button>
              </div>

              {form.secretEnv.length > 0 && (
                <div className="flex flex-col gap-2">
                  {form.secretEnv.map((row, index) => (
                    <div key={index} className="flex min-w-0 items-center gap-2">
                      <Input
                        value={row.envName}
                        onChange={(e) => updateSecretRow(index, { envName: e.target.value })}
                        placeholder="ENV_NAME"
                        className="h-8 min-w-0 flex-1 font-mono text-[13px] leading-5"
                        spellCheck={false}
                      />
                      <span className="text-muted-foreground shrink-0 text-[13px] leading-5">←</span>
                      <Select
                        value={row.name || undefined}
                        onValueChange={(value) => {
                          if (value) updateSecretRow(index, { name: value });
                        }}
                      >
                        <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 border font-mono text-[13px] leading-5">
                          <SelectValue placeholder="选择密钥" />
                        </SelectTrigger>
                        <SelectContent>
                          {globalSecrets.map((secret) => (
                            <SelectItem key={secret.name} value={secret.name}>
                              {secret.name} · {secret.masked}
                            </SelectItem>
                          ))}
                          {row.name && !globalSecrets.some((s) => s.name === row.name) && (
                            <SelectItem value={row.name}>{row.name}（不可用）</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive size-7 shrink-0"
                        onClick={() => removeSecretRow(index)}
                        title="移除这条密钥绑定"
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {configChanged && form.secretEnv.length > 0 && (
                <label className="text-muted-foreground flex cursor-pointer items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-[13px] leading-5">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-amber-600"
                    checked={keepBindingsOnConfigChange}
                    onChange={(e) => setKeepBindingsOnConfigChange(e.target.checked)}
                  />
                  <span>
                    启动配置已变更：勾选后保存会把下面这些密钥注入修改后的配置；
                    不勾选则保存时自动解除绑定。
                  </span>
                </label>
              )}

              {isEdit && target.mode === "edit" && target.entry.secretBindingStale && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-[13px] leading-5">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                  <span>
                    原密钥绑定因启动配置变化已失效，当前不会注入。重新选择密钥并保存即可恢复。
                  </span>
                </div>
              )}

              {globalSecrets.length === 0 && (
                <p className="text-muted-foreground text-[13px] leading-5">
                  密钥库里还没有可用的全局密钥；先到“设置 → 智能体 → 密钥”创建。
                </p>
              )}
            </div>
          )}

          {insecureHttp && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[13px] leading-5">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span>
                这是非环回的明文 HTTP 端点：凭证与工具调用内容可能被网络截获。保存即表示你知晓并接受该风险。
              </span>
            </div>
          )}

          <Label className="flex flex-col items-start gap-1 text-sm">
            <span className="text-muted-foreground text-[13px] leading-5">
              描述（注入系统提示词，帮助模型选择）
            </span>
            <Input
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
              placeholder="如 GitHub API：仓库、issue、PR 操作"
            />
          </Label>

          <Collapsible>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-[13px] leading-5 transition-colors">
              高级选项
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-3">
              <div className="flex gap-3">
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-[13px] leading-5">生命周期</span>
                  <Select
                    value={form.lifecycle}
                    onValueChange={(v) => setField("lifecycle", v as FormDraft["lifecycle"])}
                  >
                    <SelectTrigger size="sm" className="w-full border">
                      <SelectValue>{LIFECYCLE_LABEL[form.lifecycle]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(LIFECYCLE_LABEL) as Array<keyof typeof LIFECYCLE_LABEL>).map(
                        (v) => (
                          <SelectItem key={v} value={v}>
                            {LIFECYCLE_LABEL[v]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-[13px] leading-5">
                    免审批工具（逗号分隔 glob，如 get_*, list_*）
                  </span>
                  <Input
                    value={form.approveToolsText}
                    onChange={(e) => setField("approveToolsText", e.target.value)}
                    placeholder="留空 = 每次调用都需确认"
                    className="font-mono  text-[13px] leading-5"
                  />
                  {layer === "workspace" && (
                    // 工作区文件跟着仓库走：不能给自己授权。要免审批就在审批卡上点
                    // 「允许并记住这个工具」（记进本机 permissions.local.json）
                    <span className="text-muted-foreground text-[13px] leading-5">
                      工作区配置里的免审批名单不在本机生效（仓库不能给自己授权），只作为审批卡上的说明；
                      要免审批请在审批卡上点「允许并记住这个工具」，或把该服务器配到系统层。
                    </span>
                  )}
                </Label>
              </div>
              <div className="flex gap-3">
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-[13px] leading-5">
                    工具调用超时（毫秒；留空 = 默认 120000，即 2 分钟）
                  </span>
                  <Input
                    type="number"
                    min={5000}
                    step={1000}
                    value={form.callTimeoutText}
                    onChange={(e) => setField("callTimeoutText", e.target.value)}
                    placeholder="120000（默认 2 分钟）"
                    className=" font-mono text-[13px] leading-5 tabular-nums"
                  />
                </Label>
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-[13px] leading-5">
                    空闲断开时间（毫秒；留空 = 默认 600000，即 10 分钟）
                  </span>
                  <Input
                    type="number"
                    min={5000}
                    step={1000}
                    value={form.idleTimeoutText}
                    onChange={(e) => setField("idleTimeoutText", e.target.value)}
                    placeholder="600000（默认 10 分钟）"
                    className=" font-mono text-[13px] leading-5 tabular-nums"
                  />
                </Label>
              </div>
            </CollapsibleContent>
          </Collapsible>
          </div>
        </div>

        {/* 页脚固定：错误与作用域提示就近显示，保存键不随长表单滚走 */}
        <div className="shrink-0 px-6 py-4">
          {error && (
            <p className="text-destructive mb-2 text-[13px] leading-5" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span
              className={cn(
                "text-[13px] leading-5",
                layerNeedsCwd
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
            >
              {layerNeedsCwd
                ? "未选择工作区：先在主界面选好工作目录，或改用系统级"
                : layer === "workspace"
                  ? "工作区级 · 保存后随仓库共享"
                  : "系统级 · 保存后本机全局生效"}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={save} disabled={busy || layerNeedsCwd}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// JSON 导入弹窗（粘贴 mcpServers JSON → 本地校验预览 → 逐台 saveMcpServer）
// ---------------------------------------------------------------------------

const ENTRY_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const LIFECYCLE_VALUES = ["lazy", "eager", "keep-alive"] as const;

const JSON_IMPORT_PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"],
      "env": { "LOG_LEVEL": "info" }
    },
    "sentry": {
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}`;

/** env/headers 键值映射校验（与 sidecar stringMap 同口径：全部值必须是字符串） */
function jsonParseStringMap(
  raw: unknown,
  label: string,
): Record<string, string> | undefined | string {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${label}: 必须是键值对象`;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") return `${label}.${k}: 值必须是字符串`;
    out[k] = v;
  }
  return out;
}

/** 一个 mcpServers 条目 → 保存草稿；结构错误返回带 [name] 前缀的错误文案 */
function jsonEntryToDraft(name: string, raw: unknown): McpServerDraft | string {
  const label = `[${name}]`;
  if (!ENTRY_NAME_RE.test(name)) return `${label}: 名称需匹配字母/数字/_/-，≤64`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${label}: 必须是对象`;
  }
  const r = raw as Record<string, unknown>;
  const hasCommand = typeof r.command === "string" && r.command.trim().length > 0;
  const hasUrl = typeof r.url === "string" && r.url.trim().length > 0;
  const type = typeof r.type === "string" ? r.type.trim().toLowerCase() : "";
  let transport: "stdio" | "http" | null = null;
  if (type === "http" || type === "sse" || type === "streamable-http") transport = "http";
  else if (type === "stdio") transport = "stdio";
  else if (hasCommand && hasUrl) return `${label}: command 与 url 只能二选一`;
  else if (hasUrl) transport = "http";
  else if (hasCommand) transport = "stdio";
  else return `${label}: 缺少 command（stdio）或 url（http）`;

  const draft: McpServerDraft = { name, transport };
  if (transport === "stdio") {
    draft.command = String(r.command).trim();
    if (r.args !== undefined) {
      if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== "string")) {
        return `${label}: args 必须是字符串数组`;
      }
      draft.args = r.args as string[];
    }
    const env = jsonParseStringMap(r.env, `${label} env`);
    if (typeof env === "string") return env;
    if (env) draft.env = env;
  } else {
    draft.url = String(r.url).trim();
    const headers = jsonParseStringMap(r.headers, `${label} headers`);
    if (typeof headers === "string") return headers;
    if (headers) draft.headers = headers;
  }
  if (typeof r.description === "string" && r.description.trim()) {
    draft.description = r.description.trim();
  }
  if (r.lifecycle !== undefined) {
    if (
      typeof r.lifecycle === "string" &&
      (LIFECYCLE_VALUES as readonly string[]).includes(r.lifecycle)
    ) {
      draft.lifecycle = r.lifecycle as (typeof LIFECYCLE_VALUES)[number];
    } else {
      return `${label}: lifecycle 需为 lazy/eager/keep-alive`;
    }
  }
  if (r.idleTimeout !== undefined) {
    if (typeof r.idleTimeout === "number" && Number.isFinite(r.idleTimeout) && r.idleTimeout >= 5_000) {
      draft.idleTimeout = Math.floor(r.idleTimeout);
    } else {
      return `${label}: idleTimeout 需为 ≥5000 的毫秒数`;
    }
  }
  if (r.callTimeout !== undefined) {
    if (typeof r.callTimeout === "number" && Number.isFinite(r.callTimeout) && r.callTimeout >= 5_000) {
      draft.callTimeout = Math.floor(r.callTimeout);
    } else {
      return `${label}: callTimeout 需为 ≥5000 的毫秒数`;
    }
  }
  if (r.approveTools !== undefined) {
    if (r.approveTools === true) draft.approveTools = ["*"];
    else if (
      Array.isArray(r.approveTools) &&
      r.approveTools.every((g) => typeof g === "string" && g.trim())
    ) {
      draft.approveTools = (r.approveTools as string[]).map((g) => g.trim());
    } else {
      return `${label}: approveTools 需为 glob 字符串数组或 true`;
    }
  }
  return draft;
}

/**
 * 解析粘贴文本 → 逐台草稿 + 错误列表。支持三种形态：
 * ① { mcpServers: { name: {...} } }（生态标准）；② 裸 { name: {...} } 映射；
 * ③ 顶层即单台定义（带 name）。未知字段忽略（保存后 sidecar 记诊断）。
 */
function parseMcpJsonDrafts(text: string): {
  drafts: McpServerDraft[];
  errors: string[];
} {
  const trimmed = text.trim();
  if (!trimmed) return { drafts: [], errors: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch (err) {
    return {
      drafts: [],
      errors: [`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { drafts: [], errors: ["顶层必须是 JSON 对象"] };
  }
  const root = doc as Record<string, unknown>;
  let map: Record<string, unknown>;
  if (root.mcpServers !== undefined) {
    if (
      typeof root.mcpServers !== "object" ||
      root.mcpServers === null ||
      Array.isArray(root.mcpServers)
    ) {
      return { drafts: [], errors: ["mcpServers 必须是键值对象"] };
    }
    map = root.mcpServers as Record<string, unknown>;
  } else if (typeof root.command === "string" || typeof root.url === "string") {
    const name = typeof root.name === "string" ? root.name : "";
    if (!name) return { drafts: [], errors: ["单台定义需要 name 字段"] };
    map = { [name]: root };
  } else {
    map = root;
  }

  const drafts: McpServerDraft[] = [];
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const draft = jsonEntryToDraft(name, raw);
    if (typeof draft === "string") errors.push(draft);
    else drafts.push(draft);
  }
  if (errors.length === 0 && drafts.length === 0) {
    errors.push("未解析到任何服务器条目（每台需有 command 或 url）");
  }
  return { drafts, errors };
}

const McpJsonImportDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditorTarget | null;
  workspaceCwd: string | null;
  servers: McpServerEntry[];
}> = ({ open, onOpenChange, target, workspaceCwd, servers }) => {
  // 批量导入同样要区分「正在看的目录」和「当前会话工作区」
  const activeWorkspace = useWorkspace();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const layer = target?.mode === "json" ? target.layer : null;

  // 本地预检 + 与同层（覆盖层/系统层）已有条目撞名预检：sidecar 保存会拒绝重名，
  // 半批失败不如保存前就提示改名。标准层 .mcp.json 同名可被覆盖层接管，不算冲突。
  const { drafts, errors } = useMemo(() => {
    const res = parseMcpJsonDrafts(text);
    if (layer && res.errors.length === 0) {
      const taken = new Set(
        servers
          .filter((s) => s.layer === layer && !s.fromStandard)
          .map((s) => s.name),
      );
      for (const d of res.drafts) {
        if (taken.has(d.name)) {
          res.errors.push(`[${d.name}]: 本层已存在同名服务器，请改名后导入`);
        }
      }
    }
    return res;
  }, [text, servers, layer]);

  if (!target || !layer) return null;

  const hasInput = text.trim().length > 0;
  const canImport =
    hasInput &&
    drafts.length > 0 &&
    errors.length === 0 &&
    !(layer === "workspace" && !workspaceCwd);

  const importAll = async () => {
    if (busy || !canImport) return;
    setBusy(true);
    setError(null);
    try {
      for (const draft of drafts) {
        try {
          await saveMcpServer({
            layer,
            cwd:
              layer === "workspace"
                ? workspaceCwd ?? undefined
                : activeWorkspace ?? undefined,
            viewCwd: workspaceCwd,
            definition: draft,
          });
        } catch (err) {
          throw new Error(
            `导入「${draft.name}」失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 高度与滚动：同连接日志弹窗——弹窗限高后**只有中段滚动**，footer 永远可见；
          旧写法在 DialogContent 上挂 overflow-y-auto，footer 会随内容滚出可视区 */}
      <DialogContent className="flex h-[calc(100dvh-6rem)] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {/* 页头：与编辑弹窗同款（图标 + 标题 + 导入位置） */}
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-md font-semibold tracking-tight">
              JSON 导入 MCP 服务器
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm">
              {layer === "workspace"
                ? `导入到 ${workspaceCwd ?? ""}/.kova/mcp.json · 随仓库共享`
                : "导入到 ~/.kova/mcp.json · 对本机所有工作区生效"}
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex min-w-0 flex-col gap-4">
          <Label className="flex w-full min-w-0 flex-col items-start gap-1 text-sm">
            <span className="text-muted-foreground text-[13px] leading-5">
              mcpServers JSON（兼容 Claude Code / Cursor 导出格式，支持一次导入多台；语法错误在编辑器内画红波浪线）
            </span>
            <div className="bg-muted/60 h-72 w-full overflow-hidden rounded-lg border">
              <JsonCodeEditor
                className="h-full w-full"
                height="100%"
                value={text}
                onChange={setText}
                placeholder={JSON_IMPORT_PLACEHOLDER}
              />
            </div>
          </Label>
          {hasInput && errors.length === 0 && drafts.length > 0 && (
            <div className="bg-muted/50 flex flex-col gap-1.5 rounded-xl p-2.5">
              {drafts.map((d) => (
                <div key={d.name} className="flex min-w-0 items-center gap-2 text-[13px] leading-5">
                  {d.transport === "http" ? (
                    <ServerIcon className="text-muted-foreground size-3.5 shrink-0" />
                  ) : (
                    <SquareTerminalIcon className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  <span className="shrink-0 font-mono font-medium">{d.name}</span>
                  <Badge variant="outline" className="shrink-0 font-mono text-[13px] leading-5">
                    {d.transport}
                  </Badge>
                  <span className="text-muted-foreground min-w-0 truncate font-mono">
                    {d.command ? [d.command, ...(d.args ?? [])].join(" ") : d.url}
                  </span>
                </div>
              ))}
            </div>
          )}
          {hasInput && errors.length > 0 && (
            <ul className="text-destructive flex min-w-0 flex-col gap-0.5 break-words text-[13px] leading-5" role="alert">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          </div>
        </div>

        {/* 页脚固定：导入错误/范围提示与按钮不随 JSON 滚走 */}
        <div className="shrink-0 px-6 py-4">
          {error && (
            <p className="text-destructive mb-2 text-[13px] leading-5" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-muted-foreground text-[13px] leading-5">
              {layer === "workspace"
                ? "工作区级 · 导入到 .kova/mcp.json"
                : "系统级 · 导入到 ~/.kova/mcp.json"}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={() => void importAll()} disabled={busy || !canImport}>
                {busy
                  ? "导入中…"
                  : hasInput && drafts.length > 0 && errors.length === 0
                    ? `导入 ${drafts.length} 台`
                    : "导入"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 服务器行（bg-muted/50 卡片内；样式对齐记忆文件行：图标盒 + 名称/说明 + Switch）
// ---------------------------------------------------------------------------

/**
 * 协议自报图标（MCP 2025-11-25 serverInfo.icons，握手成功后由 sidecar 透传）：
 * 按当前深浅色挑 theme 匹配的一张，其次通用（无 theme），最后任意；
 * 外链图可能 404/超时，onError 记在 src 上回落默认图标（换 src 自动重试）。
 */
const McpProtocolIcon: FC<{ icons: McpServerIcon[] | undefined; fallback: ReactNode }> = ({
  icons,
  fallback,
}) => {
  const dark = useHtmlDark();
  const icon = useMemo(() => {
    if (!icons?.length) return null;
    const want = dark ? "dark" : "light";
    return icons.find((i) => i.theme === want) ?? icons.find((i) => !i.theme) ?? icons[0];
  }, [icons, dark]);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!icon || failedSrc === icon.src) return <>{fallback}</>;
  return (
    <img
      src={icon.src}
      alt=""
      draggable={false}
      className="size-5 shrink-0 object-contain"
      onError={() => setFailedSrc(icon.src)}
    />
  );
};

const McpRow: FC<{
  entry: McpServerEntry;
  workspaceCwd: string | null;
  testing: boolean;
  /** 最近一次「测试」的结果（null = 未测过），测试按钮旁的状态徽标 */
  testResult: "ok" | "fail" | null;
  authorizing: boolean;
  revoking: boolean;
  confirmingDelete: boolean;
  /** 插件层：定义归插件所有，只提供连接/启停/日志，不提供编辑/删除 */
  readOnly?: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onAuthorize: () => void;
  onRevoke: () => void;
  onLog: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onConfirmDelete?: () => void;
}> = ({
  entry,
  workspaceCwd,
  testing,
  testResult,
  authorizing,
  revoking,
  confirmingDelete,
  readOnly = false,
  onToggle,
  onTest,
  onAuthorize,
  onRevoke,
  onLog,
  onEdit,
  onDelete,
  onConfirmDelete,
}) => {
  const status = entry.status;
  const target = entry.transport === "http" ? entry.url : entry.command;
  // 工具清单展开（ready 行才有触发器）：首次展开才拉，行内缓存
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const toggleTools = () => {
    const next = !toolsOpen;
    setToolsOpen(next);
    if (next && tools === null && !toolsBusy) {
      setToolsBusy(true);
      setToolsError(null);
      fetchMcpServerTools(
        entry.name,
        entry.layer === "system" ? undefined : workspaceCwd,
      )
        .then(setTools)
        .catch((err) => setToolsError(err instanceof Error ? err.message : String(err)))
        .finally(() => setToolsBusy(false));
    }
  };
  return (
    <div className="group bg-background hover:border-foreground/20 hover:bg-muted/20 flex flex-col rounded-xl border transition-colors">
      <div className="relative flex items-start gap-4 px-3 py-4">
        {/* 图标盒 + 连接状态点：transport 决定底色，扫一眼区分 HTTP / stdio */}
        <div
          className={cn(
            "relative flex size-10 shrink-0 items-center justify-center rounded-xl",
            entry.transport === "http"
              ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
              : "bg-violet-500/10 text-violet-600 dark:text-violet-400",
          )}
        >
          <McpProtocolIcon
            icons={status.icons}
            fallback={
              entry.transport === "http" ? (
                <ServerIcon className="size-5" />
              ) : (
                <SquareTerminalIcon className="size-5" />
              )
            }
          />
          <span
            className={cn(
              "absolute -right-1 -bottom-1 size-2.5 rounded-full ring-2 ring-background",
              STATE_DOT[status.state],
            )}
            title={STATE_LABEL[status.state]}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="pr-10">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-base font-medium">{entry.name}</span>
            <Badge variant="outline" className="shrink-0 font-mono text-[13px] leading-5">
              {entry.transport}
            </Badge>
            {entry.layer === "plugin" && (
              <Badge
                variant="secondary"
                className="shrink-0 text-[13px] leading-5"
                title={entry.pluginId}
              >
                插件
              </Badge>
            )}
            {entry.transport === "stdio" && entry.secretEnv && entry.secretEnv.length > 0 && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 border-emerald-600/40 text-[13px] leading-5 text-emerald-700 dark:text-emerald-400"
                title={`握手时注入 ${entry.secretEnv.length} 个密钥（值不写入配置）`}
              >
                <KeyRoundIcon className="size-3" />
                {entry.secretEnv.length} 密钥
              </Badge>
            )}
            {entry.transport === "stdio" && entry.secretBindingStale && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 border-amber-600/40 text-[13px] leading-5 text-amber-700 dark:text-amber-400"
                title="启动配置已变，原密钥绑定不会注入；编辑服务器重新确认"
              >
                <TriangleAlertIcon className="size-3" />
                密钥绑定失效
              </Badge>
            )}
            {status.state === "ready" ? (
              <button
                type="button"
                onClick={toggleTools}
                className="text-emerald-600 dark:text-emerald-400 hover:underline shrink-0 cursor-pointer text-[13px] leading-5"
                title={toolsOpen ? "收起工具列表" : "展开查看全部工具"}
              >
                {status.toolCount} 个工具
                <ChevronDownIcon
                  className={cn(
                    "mb-[2px] inline size-3 transition-transform",
                    toolsOpen && "rotate-180",
                  )}
                />
              </button>
            ) : status.needsAuth ? (
              <span className="text-amber-600 dark:text-amber-400 shrink-0 text-[13px] leading-5">
                需要授权
              </span>
            ) : status.state !== "idle" ? (
              <span className="text-muted-foreground shrink-0 text-[13px] leading-5">
                {STATE_LABEL[status.state]}
              </span>
            ) : null}
          </div>

          <div className="text-muted-foreground mt-1 line-clamp-2 text-[13px] leading-5">
            {entry.description || target || "未配置目标"}
          </div>
          </div>

          <div className="mt-2 flex min-w-0 items-center gap-1.5">
            {entry.transport === "http" && (status.needsAuth || authorizing) && (
              <Button
                variant="outline"
                size="sm"
                className="text-amber-600 dark:text-amber-400 h-7 shrink-0 border-amber-600/40 px-2 text-[13px] leading-5"
                onClick={onAuthorize}
                disabled={authorizing}
                title="打开浏览器完成该服务器的 OAuth 授权"
              >
                {authorizing ? "等待浏览器授权…" : "授权"}
              </Button>
            )}
            {entry.enabled && status.state !== "ready" && !status.needsAuth && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-[13px] leading-5"
                onClick={onTest}
                disabled={testing || status.state === "connecting"}
                title={status.message ?? "强制握手并连接"}
              >
                {testing || status.state === "connecting"
                  ? "连接中…"
                  : status.state === "backoff"
                    ? "重试"
                    : "连接"}
              </Button>
            )}
            {(testing || testResult) && (
              <AnimatedBadge
                size="sm"
                status={testing ? "loading" : testResult === "ok" ? "success" : "danger"}
              >
                {testing ? "测试中" : testResult === "ok" ? "成功" : "失败"}
              </AnimatedBadge>
            )}
            {entry.source && (
              <span
                className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-3xs"
                title={entry.source}
              >
                {entry.layer === "workspace" &&
                workspaceCwd &&
                entry.source.startsWith(workspaceCwd + "/")
                  ? entry.source.slice(workspaceCwd.length + 1)
                  : entry.source}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              {entry.transport === "http" && status.oauthAuthorized && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive h-7 px-2 text-[13px] leading-5"
                  onClick={onRevoke}
                  disabled={revoking}
                  title="清除已存储的 OAuth 凭据并断开；下次连接需重新授权（不删除服务器配置）"
                >
                  {revoking ? "取消中…" : "取消授权"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onTest}
                disabled={testing}
                title="测试连接（强制重新握手并统计工具）"
              >
                <FlaskConicalIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onLog}
                title="连接日志与事件"
              >
                <FileTextIcon className="size-3.5" />
              </Button>
              {!readOnly && onEdit && (
                <Button variant="ghost" size="icon" className="size-7" onClick={onEdit} title="编辑">
                  <PencilIcon className="size-3.5" />
                </Button>
              )}
              {!readOnly &&
                !entry.fromStandard &&
                (confirmingDelete ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 px-2 text-[13px] leading-5"
                    onClick={onConfirmDelete}
                  >
                    <CheckIcon className="size-3.5" />
                    确认删除
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-7"
                    onClick={onDelete}
                    title="删除"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                ))}
            </div>
          </div>
        </div>

        <Switch
          className="absolute top-4 right-3"
          checked={entry.enabled}
          onCheckedChange={onToggle}
          aria-label={`${entry.name} 启用`}
        />
      </div>

      {toolsOpen && (
        <div className="bg-muted/40 mx-3 mb-3 rounded-xl border px-3 py-1.5">
          {toolsBusy ? (
            <p className="text-muted-foreground py-2 text-[13px] leading-5">加载工具列表…</p>
          ) : toolsError ? (
            <p className="text-destructive py-2 text-[13px] leading-5">工具列表加载失败：{toolsError}</p>
          ) : tools && tools.length > 0 ? (
            <ul className="divide-border/50 flex flex-col divide-y">
              {tools.map((t) => (
                <li key={t.name} className="flex flex-col gap-0.5 py-1.5">
                  <span className="font-mono text-[13px] leading-5 font-medium">{t.name}</span>
                  {t.description ? (
                    <span className="text-muted-foreground line-clamp-2 text-[13px] leading-5">
                      {t.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground py-2 text-[13px] leading-5">该服务器未提供工具</p>
          )}
        </div>
      )}

    </div>
  );
};

// ---------------------------------------------------------------------------
// 连接错误日志弹窗
// ---------------------------------------------------------------------------

/**
 * MCP 连接日志弹窗：拉取 sidecar 的环形缓冲（握手失败 / 传输错误，按名字跨
 * 断开保留），行内不再展示长错误文本——点「日志」在这里看。
 */
/** 审计事件种类的展示元数据：中文名 + 徽标底色 */
const AUDIT_KIND_META: Record<
  McpAuditEvent["kind"],
  { label: string; className: string }
> = {
  connect: { label: "连接", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  connect_fail: { label: "连接失败", className: "bg-destructive/15 text-destructive" },
  disconnect: { label: "断开", className: "bg-muted text-muted-foreground" },
  call: { label: "调用", className: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  truncate: { label: "截断", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  auth: { label: "授权", className: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  probe_fail: { label: "探测失败", className: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
};

const McpLogDialog: FC<{
  name: string | null;
  onOpenChange: (open: boolean) => void;
}> = ({ name, onOpenChange }) => {
  const [lines, setLines] = useState<McpLogLine[]>([]);
  const [events, setEvents] = useState<McpAuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      // 错误日志（进程内环形缓冲）与审计事件（本地 JSONL 持久）并行取
      const [log, audit] = await Promise.all([
        fetchMcpServerLog(name),
        fetchMcpAuditLog(name, 200),
      ]);
      setLines(log);
      setEvents(audit);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (name) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // 时间倒序（最近在上）：sidecar 返回升序，这里翻转
  const recentEvents = [...events].reverse();

  return (
    <Dialog open={name !== null} onOpenChange={onOpenChange}>
      {/* 高度与滚动：弹窗做成 flex 列 + overflow-hidden，只有中段滚动——
          旧写法在 DialogContent 上挂 overflow-y-auto，footer 是滚动内容的一部分，
          内容一长按钮就被顶出可视区（且 overflow-y-auto 会把 overflow-x 也算成 auto，
          长 token 撑宽内容时整块横向滚动）。中段自带 min-w-0 让换行真正生效。 */}
      <DialogContent className="flex h-[calc(100dvh-6rem)] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {/* 页头：与编辑弹窗同款（图标 + 标题 + 说明） */}
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-slate-500/10 text-slate-600 dark:text-slate-300">
            <FileTextIcon className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-xl font-semibold tracking-tight">
              连接日志
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm">
              {name} · 连接错误（最近 100 条）与持久化审计事件，点「测试」可重新握手
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {error ? (
            <p className="text-destructive min-w-0 text-sm [overflow-wrap:anywhere]">{error}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-4">
              <section className="min-w-0">
                <h4 className="mb-1.5 text-[13px] leading-5 font-medium">连接错误</h4>
                {busy && lines.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm">读取中…</p>
                ) : lines.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm">
                    暂无连接错误
                  </p>
                ) : (
                  <ul className="bg-muted/60 flex max-h-64 min-w-0 flex-col gap-1.5 overflow-y-auto rounded-lg border p-3">
                    {lines.map((l, i) => (
                      <li key={i} className="flex min-w-0 gap-2 text-[13px] leading-5">
                        <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                          {new Date(l.at).toLocaleString()}
                        </span>
                        {/* anywhere 而非 break-words：后者不降低固有宽度，长 token
                          （URL / JSON 报错）会把内容撑宽出弹窗、尾部被裁掉 */}
                        <span className="min-w-0 [overflow-wrap:anywhere]">{l.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="min-w-0">
                <h4 className="mb-1.5 text-[13px] leading-5 font-medium">
                  连接事件
                  <span className="text-muted-foreground ml-1.5 font-normal">
                    跨重启持久，只含事件与耗时，不含参数内容
                  </span>
                </h4>
                {busy && events.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm">读取中…</p>
                ) : recentEvents.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm">暂无事件</p>
                ) : (
                  <ul className="bg-muted/60 flex max-h-64 min-w-0 flex-col gap-1 overflow-y-auto rounded-lg border p-3">
                    {recentEvents.map((e, i) => {
                      const meta = AUDIT_KIND_META[e.kind] ?? AUDIT_KIND_META.disconnect;
                      return (
                        <li key={i} className="flex min-w-0 items-baseline gap-2 text-[13px] leading-5">
                          <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                            {new Date(e.at).toLocaleString()}
                          </span>
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[13px] leading-4 font-medium",
                              meta.className,
                            )}
                          >
                            {meta.label}
                            {e.ok === false && <XIcon className="size-3 shrink-0" />}
                          </span>
                          {e.detail ? (
                            <span className="min-w-0 [overflow-wrap:anywhere]">{e.detail}</span>
                          ) : null}
                          {typeof e.ms === "number" ? (
                            <span className="text-muted-foreground ml-auto shrink-0 font-mono tabular-nums">
                              {e.ms}ms
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 px-6 py-4">
          <span className="text-muted-foreground text-[13px] leading-5">
            最近 100 条连接错误 · 审计事件跨重启保留
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void load()} disabled={busy}>
              <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
              刷新
            </Button>
            <Button onClick={() => onOpenChange(false)}>关闭</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 工作区目录切换器（与记忆、子智能体管理页同款）：候选 = 手动浏览 + 当前工作区 + 最近使用 */
const WorkspaceCwdMenu: FC<{
  value: string | null;
  following: boolean;
  followLabel: string | null;
  candidates: string[];
  showBrowse: boolean;
  onChange: (dir: string) => void;
  onFollowCurrent: () => void;
  onBrowse: () => void;
}> = ({
  value,
  following,
  followLabel,
  candidates,
  showBrowse,
  onChange,
  onFollowCurrent,
  onBrowse,
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <button
          type="button"
          title={value ?? undefined}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] leading-5 transition-colors"
        >
          <FolderOpenIcon className="size-3.5 shrink-0" />
          <span className="max-w-44 truncate">
            {value ? pathBasename(value) : "未选择工作区"}
          </span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      }
    />
    <DropdownMenuContent align="end" className="w-72">
      {candidates.map((dir) => (
        <DropdownMenuCheckboxItem
          key={dir}
          checked={dir === value}
          onCheckedChange={(checked) => {
            if (checked) onChange(dir);
          }}
          title={dir}
        >
          <span className="truncate">{pathBasename(dir)}</span>
        </DropdownMenuCheckboxItem>
      ))}
      {candidates.length === 0 && (
        <div className="text-muted-foreground px-2 py-3 text-center text-[13px] leading-5">暂无记录</div>
      )}
      {!following && followLabel && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onFollowCurrent}>
            跟随当前工作区 · {followLabel}
          </DropdownMenuItem>
        </>
      )}
      {showBrowse && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onBrowse}>
            <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
            浏览其他目录…
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  </DropdownMenu>
);

export const McpSettings: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const workspace = useWorkspace();
  const recents = useWorkspaceRecents();
  const [overrideCwd, setOverrideCwd] = useState<string | null>(null);
  const viewingCwd = overrideCwd ?? workspace;
  const snap = useMcpServers(viewingCwd);
  const [scopeTab, setScopeTab] = useState<ScopeTab>("system");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; target: EditorTarget | null }>({
    open: false,
    target: null,
  });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // 各服务器最近一次「测试/连接」的进行态（按 name）。允许多台并发：
  // sidecar 的 test_mcp_server 是派活执行、不占管理队列；单字符串会让用户在
  // 一台握手期间点另一台时静默无反应。
  const [testingNames, setTestingNames] = useState<Set<string>>(
    () => new Set(),
  );
  // 各服务器最近一次「测试」结果（按 name），驱动行内状态徽标
  const [testResults, setTestResults] = useState<
    Record<string, "ok" | "fail">
  >({});
  // OAuth 授权受理中（第一阶段：等 sidecar 生成授权链接）
  const [authorizingName, setAuthorizingName] = useState<string | null>(null);
  // 授权第二阶段：用户浏览器里的批准可能几分钟，受理应答把授权链接先挂在这里
  // （含「浏览器没自动打开」的手动入口），结果帧到达即收起
  const [pendingAuth, setPendingAuth] = useState<{
    name: string;
    authUrl: string;
    browserOpened: boolean;
  } | null>(null);
  // 最近一次授权/取消授权失败的完整文案。与 snap.error 严格分离：
  // 后者只代表清单加载失败，动作失败不该错标成「清单加载失败」
  const [authorizeError, setAuthorizeError] = useState<string | null>(null);
  // 取消授权进行中（清凭据+断连很快，仅防连点）
  const [revokingName, setRevokingName] = useState<string | null>(null);
  // 连接日志弹窗的目标服务器名（null = 关闭）
  const [logName, setLogName] = useState<string | null>(null);

  const scopeServers = useMemo(
    () => snap.servers.filter((e) => e.layer === scopeTab),
    [snap.servers, scopeTab],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopeServers;
    return scopeServers.filter((e) =>
      [e.name, e.description, e.command, e.url, e.transport]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [scopeServers, query]);

  // 插件 MCP 与页签无关：跟工作区选择器一样按 query 过滤，始终单独成组
  const pluginVisible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snap.pluginServers;
    return snap.pluginServers.filter((e) =>
      [e.name, e.description, e.command, e.url, e.transport, e.pluginId]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [snap.pluginServers, query]);

  /** 变更命令的 cwd：workspace 必须指向正在看的目录；system/plugin 是全局
   *  条目，用当前会话工作区重调连接池——否则设置页浏览别的目录时一点开关就会
   *  把当前会话的 workspace 服务器判为不在启用集合而断开。 */
  const commandCwd = (entry: McpServerEntry): string | null | undefined =>
    entry.layer === "workspace" ? viewingCwd : (workspace ?? undefined);

  const toggle = (entry: McpServerEntry, enabled: boolean) => {
    void setMcpServerEnabled(
      entry.layer,
      entry.name,
      enabled,
      commandCwd(entry),
      entry.pluginId,
      viewingCwd,
    )
      .then(() => {
        // 插件详情页的组件 enabled 状态来自 plugins 镜像；从 MCP 页改的开关
        // 要反向刷新一次，否则两处显示会不一致（反向路径见 setPluginComponentEnabled）
        if (entry.layer === "plugin") {
          // 插件镜像跟随当前会话工作区，不跟设置页的「浏览其他目录」选择
          void import("@/lib/plugins/plugins")
            .then(({ refreshPlugins }) => refreshPlugins(workspace))
            .catch(() => {});
        }
      })
      .catch(() => {});
  };

  const remove = (entry: McpServerEntry) => {
    void deleteMcpServer(
      writableLayer(entry.layer),
      entry.name,
      commandCwd(entry),
      viewingCwd,
    ).catch(() => {});
    setConfirmDelete(null);
  };

  const test = async (entry: McpServerEntry) => {
    if (testingNames.has(entry.name)) return;
    setTestingNames((prev) => new Set(prev).add(entry.name));
    try {
      const status = await testMcpServer(
        entry.layer,
        entry.name,
        viewingCwd,
      );
      if (status.state === "ready") {
        setTestResults((m) => ({ ...m, [entry.name]: "ok" }));
        toast.success({
          title: `${entry.name} 已连接`,
          description: `连接正常，发现 ${status.toolCount} 个工具`,
        });
      } else {
        setTestResults((m) => ({ ...m, [entry.name]: "fail" }));
        // 连接按钮已经常显，失败必须给原因；行内「失败」徽标不够自解释
        toast.error({
          title: `${entry.name} 连接失败`,
          description: status.message ?? "服务器没有返回可用状态。",
        });
      }
    } catch (err) {
      setTestResults((m) => ({ ...m, [entry.name]: "fail" }));
      toast.error({
        title: `${entry.name} 连接失败`,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingNames((prev) => {
        const next = new Set(prev);
        next.delete(entry.name);
        return next;
      });
    }
  };

  // OAuth 授权（两段式）：第一阶段只等 sidecar 生成授权链接（秒级），拿到就把
// 链接挂在页面上；用户在浏览器里批准可能几分钟，结果经 mcp_auth_result 自发帧
// 回流——不再让一个请求占着几分钟（旧实现正是这样把 mgmt 队列堵死、全应用假死）。
  const authorize = async (entry: McpServerEntry) => {
    if (authorizingName) return;
    setAuthorizingName(entry.name);
    setAuthorizeError(null);
    try {
      const started = await authorizeMcpServer(
        entry.name,
        viewingCwd,
      );
      if (started.authUrl) {
        setPendingAuth({
          name: entry.name,
          authUrl: started.authUrl,
          browserOpened: started.browserOpened === true,
        });
      } else {
        // 握手没走到需要授权那一步（存量凭据仍有效，已直接连上）
        toast.success({
          title: `${entry.name} 已连接`,
          description: "现有凭据仍然有效，无需重新授权。",
        });
      }
    } catch (err) {
      setAuthorizeError(`授权失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAuthorizingName(null);
    }
  };

  // 授权结果帧（第二阶段）：收起「等待授权」卡片，成功刷清单、失败呈现原因。
  // 帧自带清单：cwd 一致时镜像已并入，不一致（本页在看别的目录）按本页重拉一次。
  useEffect(() => {
    setMcpAuthHandler((frame) => {
      setPendingAuth((cur) => (cur && cur.name === frame.name ? null : cur));
      if (!frame.ok) {
        setAuthorizeError(`授权失败：${frame.errorText ?? "未知原因"}`);
        return;
      }
      if (frame.workspaceCwd !== viewingCwd) void refreshMcpServers(viewingCwd);
      toast.success({ title: `${frame.name} 授权完成` });
    });
    return () => setMcpAuthHandler(null);
  }, [viewingCwd]);

  const copyAuthUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success({ title: "授权链接已复制" });
    } catch {
      toast.error({ title: "复制失败", description: "请手动选中链接复制。" });
    }
  };

  // 取消授权：清掉该 URL 的存量凭据并断开，下次握手回到「需要授权」。
  // 不删服务器配置本身
  const revoke = async (entry: McpServerEntry) => {
    if (revokingName) return;
    setRevokingName(entry.name);
    setAuthorizeError(null);
    try {
      await revokeMcpServerAuth(
        entry.name,
        commandCwd(entry),
        viewingCwd,
      );
    } catch (err) {
      setAuthorizeError(`取消授权失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRevokingName(null);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    // 当前工作区：连连接池一起重调（外部删掉 .mcp.json 后刷新即可断开旧连接）；
    // 浏览其它目录：只读清单，不能动全局池——那会把当前会话的服务器断掉。
    const run =
      viewingCwd === workspace
        ? reconcileMcpConnections(viewingCwd)
        : refreshMcpServers(viewingCwd);
    void run.finally(() => setRefreshing(false));
  };

  const openCreate = () => {
    setEditor({ open: true, target: { mode: "create", layer: scopeTab } });
  };

  const openCreateJson = () => {
    setEditor({ open: true, target: { mode: "json", layer: scopeTab } });
  };

  /** 只读浏览：弹原生目录选择器，但不改主界面工作区（与记忆、子智能体管理页同款语义） */
  const pickBrowseDir = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "浏览工作区 MCP 配置" });
      if (typeof dir === "string") setOverrideCwd(dir === workspace ? null : dir);
    } catch {
      // 非 桌面壳环境：无原生目录选择器
    }
  };

  const cwdCandidates = useMemo(
    () =>
      Array.from(
        new Set([overrideCwd, workspace, ...recents].filter((d): d is string => Boolean(d))),
      ),
    [overrideCwd, workspace, recents],
  );

  const workspaceUnavailable = scopeTab === "workspace" && !viewingCwd;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div
        className={cn(
          "flex w-full flex-col",
          embedded ? "gap-5 px-0 py-0" : "max-w-7xl gap-8 self-center px-8 py-8",
        )}
      >
        {/* 标题行：嵌入管理页时身份在应用顶栏，这里不再重复大标题（资料库同款） */}
        {!embedded && (
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-2xl font-bold tracking-tight">MCP 服务器</h1>
            <span
              className={cn("text-[13px] leading-5", snap.error ? "text-destructive" : "text-muted-foreground")}
            >
              {snap.error
                ? "清单加载失败，可刷新重试"
                : `${snap.servers.length} 个服务器（${snap.servers.filter((s) => s.enabled).length} 个启用）${
                    snap.pluginServers.length > 0
                      ? ` · ${snap.pluginServers.length} 个插件 MCP`
                      : ""
                  }`}
            </span>
          </div>
        )}

        <section className="flex flex-col gap-3">
          {/* 工具行：作用域页签 + 工作区切换 + 搜索/刷新/新建 */}
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              value={scopeTab}
              onChange={setScopeTab}
              options={[
                { value: "system", label: "系统级" },
                { value: "workspace", label: "工作区级" },
              ]}
            />
            {scopeTab === "workspace" && (
              <WorkspaceCwdMenu
                value={viewingCwd}
                following={!overrideCwd}
                followLabel={workspace ? pathBasename(workspace) : null}
                candidates={cwdCandidates}
                showBrowse={isDesktop()}
                onChange={(dir) => setOverrideCwd(dir === workspace ? null : dir)}
                onFollowCurrent={() => setOverrideCwd(null)}
                onBrowse={() => void pickBrowseDir()}
              />
            )}
            <span className="text-muted-foreground text-sm leading-relaxed">{visible.length} 个服务器</span>
            <div className="ml-auto flex items-center gap-2">
              <Input
                className="h-8 w-56 bg-muted/50"
                placeholder="搜索名称 / 描述 / 命令…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={refresh}
                disabled={refreshing}
                aria-label="刷新"
              >
                <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button className="shrink-0 h-8 gap-1.5" disabled={workspaceUnavailable} />
                  }
                >
                  <PlusIcon className="size-4" />
                  创建
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem onClick={openCreate}>
                    <SquarePenIcon className="size-4" />
                    表单创建
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openCreateJson}>
                    <BracesIcon className="size-4" />
                    JSON 创建
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>


          {/* 授权失败单独呈现：清单本身可能是好的，别借「清单加载失败」的壳 */}
          {authorizeError ? (
            <div
              className="text-destructive bg-destructive/5 flex items-start justify-between gap-3 rounded-xl border border-destructive/30 px-3 py-2.5 text-sm"
              role="alert"
            >
              <span className="min-w-0 break-words">
                {authorizeError}
                <span className="text-muted-foreground">
                  {" "}
                  ——可重试，或点「日志」查看握手细节。
                </span>
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0 text-[13px] leading-5 underline-offset-2 hover:underline"
                onClick={() => setAuthorizeError(null)}
              >
                收起
              </button>
            </div>
          ) : null}

          {/* 等待浏览器授权（第二阶段）：链接始终可见可复制——浏览器没自动打开
              或用户关掉了标签页时，这里就是唯一可靠的重入点，别让长链接只躺在
              超时错误文案里 */}
          {pendingAuth ? (
            <div
              className="flex flex-col gap-2 rounded-xl border border-amber-600/30 bg-amber-500/5 px-3 py-2.5 text-sm"
              role="status"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="font-medium">等待「{pendingAuth.name}」授权</span>
                  <span className="text-muted-foreground">
                    {pendingAuth.browserOpened
                      ? " ——已在系统浏览器打开授权页，完成授权后本页会自动更新。"
                      : " ——未能自动打开浏览器，请手动打开下面的链接完成授权。"}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground shrink-0 text-[13px] leading-5 underline-offset-2 hover:underline"
                  onClick={() => setPendingAuth(null)}
                >
                  收起
                </button>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-muted min-w-0 flex-1 truncate rounded-lg px-2 py-1 font-mono text-[13px] leading-5">
                  {pendingAuth.authUrl}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[13px] leading-5"
                  onClick={() => openExternal(pendingAuth.authUrl)}
                >
                  打开授权页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[13px] leading-5"
                  onClick={() => void copyAuthUrl(pendingAuth.authUrl)}
                >
                  复制链接
                </Button>
              </div>
            </div>
          ) : null}

          {/* 服务器列表：两列自适应卡片行（无外框，行间细分隔线） */}
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(520px,1fr))] items-start gap-3">
            {snap.error ? (
              <div className="text-muted-foreground col-span-full rounded-2xl border border-dashed px-4 py-6 text-sm">
                清单加载失败：{snap.error}
              </div>
            ) : workspaceUnavailable ? (
              <div className="text-muted-foreground col-span-full rounded-2xl border border-dashed px-4 py-6 text-sm">
                未选择工作区。选择工作区后，这里会合并显示该仓库 .mcp.json（共享）与
                .kova/mcp.json（覆盖层）的服务器；也可以点上方目录切换器「浏览其他目录…」。
              </div>
            ) : visible.length === 0 ? (
              <div className="text-muted-foreground col-span-full rounded-2xl border border-dashed px-4 py-6 text-sm">
                {query.trim()
                  ? pluginVisible.length > 0
                    ? "当前作用域没有匹配的服务器，插件 MCP 中有匹配项。"
                    : `没有匹配「${query.trim()}」的服务器。`
                  : scopeTab === "workspace"
                    ? "该工作区还没有 MCP 服务器。点右上角「创建」添加（支持 JSON 批量导入），或让团队成员把 .mcp.json 提交进仓库。"
                    : "还没有系统级 MCP 服务器。点右上角「创建」添加（支持 JSON 批量导入）。"}
              </div>
            ) : (
              visible.map((entry) => (
                <McpRow
                  key={`${entry.layer}:${entry.name}`}
                  entry={entry}
                  workspaceCwd={snap.workspaceCwd}
                  testing={testingNames.has(entry.name)}
                  testResult={testResults[entry.name] ?? null}
                  authorizing={authorizingName === entry.name || pendingAuth?.name === entry.name}
                  confirmingDelete={confirmDelete === `${entry.layer}:${entry.name}`}
                  onToggle={(enabled) => toggle(entry, enabled)}
                  onTest={() => void test(entry)}
                  onAuthorize={() => void authorize(entry)}
                  revoking={revokingName === entry.name}
                  onRevoke={() => void revoke(entry)}
                  onLog={() => setLogName(entry.name)}
                  onEdit={() => setEditor({ open: true, target: { mode: "edit", entry } })}
                  onDelete={() => setConfirmDelete(`${entry.layer}:${entry.name}`)}
                  onConfirmDelete={() => remove(entry)}
                />
              ))
            )}
            </div>
            {/* 兼容性脚注（记忆页 dailyHint 行同款位置） */}
            {scopeTab === "workspace" && !workspaceUnavailable && visible.length > 0 && (
              <div className="text-muted-foreground px-1 text-[13px] leading-5">
                .mcp.json 为生态共享格式（Claude Code / Cursor 等可直接复用）；设置页只写
                .kova/mcp.json 覆盖层，从不改写共享文件。
              </div>
            )}
          </div>

          {/* 插件 MCP：定义归插件所有，不参与系统/工作区页签；这里只做连接/授权、
              日志与启停，编辑仍在插件详情（同一份 pluginServers 数据） */}
          {!snap.error && pluginVisible.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-semibold">插件 MCP</h2>
                <span className="text-muted-foreground text-sm">
                  {pluginVisible.length} 个服务器
                </span>
              </div>
              <p className="text-muted-foreground text-[13px] leading-5">
                配置由插件提供，不可编辑；可在这里连接、授权、查看日志和启停。
              </p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(520px,1fr))] items-start gap-3">
                {pluginVisible.map((entry) => (
                  <McpRow
                    key={`${entry.layer}:${entry.name}`}
                    readOnly
                    entry={entry}
                    workspaceCwd={snap.workspaceCwd}
                    testing={testingNames.has(entry.name)}
                    testResult={testResults[entry.name] ?? null}
                    authorizing={
                      authorizingName === entry.name ||
                      pendingAuth?.name === entry.name
                    }
                    confirmingDelete={false}
                    onToggle={(enabled) => toggle(entry, enabled)}
                    onTest={() => void test(entry)}
                    onAuthorize={() => void authorize(entry)}
                    revoking={revokingName === entry.name}
                    onRevoke={() => void revoke(entry)}
                    onLog={() => setLogName(entry.name)}
                  />
                ))}
              </div>
            </div>
          )}

          {snap.diagnostics.length > 0 && (
            <details className="group border-amber-500/20 bg-amber-500/5 overflow-hidden rounded-xl border text-[13px] leading-5">
              <summary className="hover:bg-amber-500/10 flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 transition-colors [&::-webkit-details-marker]:hidden">
                <TriangleAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-foreground font-medium">加载诊断</span>
                <Badge
                  variant="secondary"
                  className="bg-amber-500/10 text-amber-700 dark:text-amber-300 px-1.5 py-0 text-3xs font-medium"
                >
                  {snap.diagnostics.length}
                </Badge>
                <ChevronRightIcon className="text-muted-foreground/70 ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-90" />
              </summary>
              <ul className="border-amber-500/15 flex flex-col gap-1.5 border-t px-3.5 py-3">
                {snap.diagnostics.map((d, i) => (
                  <li
                    key={i}
                    className="bg-background/70 border-amber-500/10 flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2"
                  >
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500/70" />
                    <span className="min-w-0 font-mono text-[13px] leading-5 break-all">{d}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>

      <McpEditorDialog
        open={editor.open}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
        target={editor.target}
        workspaceCwd={viewingCwd}
      />
      <McpJsonImportDialog
        open={editor.open}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
        target={editor.target}
        workspaceCwd={viewingCwd}
        servers={snap.servers}
      />
      <McpLogDialog name={logName} onOpenChange={(open) => !open && setLogName(null)} />
    </div>
  );
};
