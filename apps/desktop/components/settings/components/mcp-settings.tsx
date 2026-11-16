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
import { ProjectScopeMenu } from "@/components/settings/components/project-scope-menu";
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
import { pathBasename } from "@/lib/workspace/workspace-store";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
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
import {
  McpCapabilityBrowser,
  type McpCapabilityTab,
} from "@/components/settings/components/mcp-capability-browser";
import { refreshSecrets, useSecrets } from "@/lib/secrets/secrets-store";
import { openExternal } from "@/lib/external-link";
import { useHtmlDark } from "@/lib/settings/use-html-dark";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { getLocale, t, useT } from "@/lib/i18n";

type ScopeTab = "system" | "workspace";

const LIFECYCLE_LABEL: Record<"lazy" | "eager" | "keep-alive", string> = {
  lazy: "settings.mcp.lifecycleLazy",
  eager: "settings.mcp.lifecycleEager",
  "keep-alive": "settings.mcp.lifecycleKeepAlive",
};

const STATE_LABEL: Record<McpServerEntry["status"]["state"], string> = {
  idle: "settings.mcp.stateIdle",
  connecting: "settings.mcp.stateConnecting",
  ready: "settings.mcp.stateReady",
  backoff: "settings.mcp.stateBackoff",
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
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 5_000) return t("settings.mcp.timeoutMin", { label });
  return Math.floor(n);
}

function formToDraft(form: FormDraft): McpServerDraft | string {
  if (form.transport === "stdio") {
    const seen = new Set<string>();
    for (const row of form.secretEnv) {
      const envName = row.envName.trim();
      if (!SECRET_ENV_NAME_RE.test(envName)) {
        return t("settings.mcp.secretEnvNameInvalid");
      }
      if (!row.name) return t("settings.mcp.secretEnvNoSecret", { name: envName });
      if (seen.has(envName)) return t("settings.mcp.secretEnvDuplicate", { name: envName });
      seen.add(envName);
    }
  }
  const idleTimeout = parseTimeoutText(
    form.idleTimeoutText,
    t("settings.mcp.timeoutIdleLabel"),
  );
  if (typeof idleTimeout === "string") return idleTimeout;
  const callTimeout = parseTimeoutText(
    form.callTimeoutText,
    t("settings.mcp.timeoutCallLabel"),
  );
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
  const t = useT();
  const activeWorkspace = useProjectWorkspaceDir();
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
                  ? t("settings.mcp.createWorkspaceTitle")
                  : t("settings.mcp.createSystemTitle")
                : t("settings.mcp.editTitle", { name: target.entry.name })}
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm">
              {layer === "workspace"
                ? t("settings.mcp.saveWorkspaceDesc", { cwd: workspaceCwd ?? "" })
                : t("settings.mcp.saveSystemDesc")}
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex min-w-0 flex-col gap-4">
          <div className="flex gap-3">
            <Label className="flex min-w-0 flex-1 flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-[13px] leading-5">
                {t("settings.mcp.fieldName")}
              </span>
              <Input
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder={t("settings.mcp.namePlaceholder")}
                className="font-mono"
              />
            </Label>
            <div className="flex shrink-0 flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-[13px] leading-5">
                {t("settings.mcp.fieldTransport")}
              </span>
              <Segmented
                value={form.transport}
                options={[
                  { value: "stdio", label: t("settings.mcp.transportStdio") },
                  { value: "http", label: t("settings.mcp.transportHttp") },
                ]}
                onChange={(value) => setField("transport", value)}
              />
            </div>
          </div>

          {form.transport === "stdio" ? (
            <>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.mcp.fieldCommand")}
                </span>
                <Input
                  value={form.command}
                  onChange={(e) => setField("command", e.target.value)}
                  placeholder={t("settings.mcp.commandPlaceholder")}
                  className="font-mono"
                />
              </Label>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.mcp.fieldArgs")}
                </span>
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
                <span className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.mcp.fieldUrl")}
                </span>
                <Input
                  value={form.url}
                  onChange={(e) => setField("url", e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="font-mono"
                />
              </Label>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.mcp.fieldHeaders")}
                </span>
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
                {t("settings.mcp.fieldEnv")}
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
                    {t("settings.mcp.secretInjectTitle")}
                  </span>
                  <span className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.mcp.secretInjectDesc")}
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
                      ? t("settings.mcp.addSecretDisabled")
                      : t("settings.mcp.addSecretTitle")
                  }
                >
                  <PlusIcon className="size-3.5" />
                  {t("settings.mcp.addSecret")}
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
                          <SelectValue placeholder={t("settings.mcp.selectSecret")} />
                        </SelectTrigger>
                        <SelectContent>
                          {globalSecrets.map((secret) => (
                            <SelectItem key={secret.name} value={secret.name}>
                              {secret.name} · {secret.masked}
                            </SelectItem>
                          ))}
                          {row.name && !globalSecrets.some((s) => s.name === row.name) && (
                            <SelectItem value={row.name}>
                              {t("settings.mcp.secretUnavailable", { name: row.name })}
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive size-7 shrink-0"
                        onClick={() => removeSecretRow(index)}
                        title={t("settings.mcp.removeSecret")}
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
                  <span>{t("settings.mcp.configChangedHint")}</span>
                </label>
              )}

              {isEdit && target.mode === "edit" && target.entry.secretBindingStale && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-[13px] leading-5">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                  <span>{t("settings.mcp.bindingStale")}</span>
                </div>
              )}

              {globalSecrets.length === 0 && (
                <p className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.mcp.noGlobalSecrets")}
                </p>
              )}
            </div>
          )}

          {insecureHttp && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[13px] leading-5">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span>{t("settings.mcp.insecureHttp")}</span>
            </div>
          )}

          <Label className="flex flex-col items-start gap-1 text-sm">
            <span className="text-muted-foreground text-[13px] leading-5">
              {t("settings.mcp.fieldDescription")}
            </span>
            <Input
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
              placeholder={t("settings.mcp.descriptionPlaceholder")}
            />
          </Label>

          <Collapsible>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-[13px] leading-5 transition-colors">
              {t("settings.mcp.advanced")}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-3">
              <div className="flex gap-3">
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.mcp.fieldLifecycle")}
                  </span>
                  <Select
                    value={form.lifecycle}
                    onValueChange={(v) => setField("lifecycle", v as FormDraft["lifecycle"])}
                  >
                    <SelectTrigger size="sm" className="w-full border">
                      <SelectValue>{t(LIFECYCLE_LABEL[form.lifecycle])}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(LIFECYCLE_LABEL) as Array<keyof typeof LIFECYCLE_LABEL>).map(
                        (v) => (
                          <SelectItem key={v} value={v}>
                            {t(LIFECYCLE_LABEL[v])}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.mcp.fieldApproveTools")}
                  </span>
                  <Input
                    value={form.approveToolsText}
                    onChange={(e) => setField("approveToolsText", e.target.value)}
                    placeholder={t("settings.mcp.approveToolsPlaceholder")}
                    className="font-mono  text-[13px] leading-5"
                  />
                  {layer === "workspace" && (
                    // 工作区文件跟着仓库走：不能给自己授权。要免审批就在审批卡上点
                    // 「允许并记住这个工具」（记进本机 permissions.local.json）
                    <span className="text-muted-foreground text-[13px] leading-5">
                      {t("settings.mcp.approveToolsWorkspaceHint")}
                    </span>
                  )}
                </Label>
              </div>
              <div className="flex gap-3">
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.mcp.fieldCallTimeout")}
                  </span>
                  <Input
                    type="number"
                    min={5000}
                    step={1000}
                    value={form.callTimeoutText}
                    onChange={(e) => setField("callTimeoutText", e.target.value)}
                    placeholder={t("settings.mcp.callTimeoutPlaceholder")}
                    className=" font-mono text-[13px] leading-5 tabular-nums"
                  />
                </Label>
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.mcp.fieldIdleTimeout")}
                  </span>
                  <Input
                    type="number"
                    min={5000}
                    step={1000}
                    value={form.idleTimeoutText}
                    onChange={(e) => setField("idleTimeoutText", e.target.value)}
                    placeholder={t("settings.mcp.idleTimeoutPlaceholder")}
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
                ? t("settings.mcp.layerNeedsCwd")
                : layer === "workspace"
                  ? t("settings.mcp.layerWorkspace")
                  : t("settings.mcp.layerSystem")}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("settings.mcp.cancel")}
              </Button>
              <Button onClick={save} disabled={busy || layerNeedsCwd}>
                {busy ? t("settings.mcp.saving") : t("settings.mcp.save")}
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
    return t("settings.mcp.jsonMapObject", { label });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") return t("settings.mcp.jsonMapString", { label, key: k });
    out[k] = v;
  }
  return out;
}

/** 一个 mcpServers 条目 → 保存草稿；结构错误返回带 [name] 前缀的错误文案 */
function jsonEntryToDraft(name: string, raw: unknown): McpServerDraft | string {
  const label = `[${name}]`;
  if (!ENTRY_NAME_RE.test(name)) return t("settings.mcp.jsonNameInvalid", { label });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return t("settings.mcp.jsonMustObject", { label });
  }
  const r = raw as Record<string, unknown>;
  const hasCommand = typeof r.command === "string" && r.command.trim().length > 0;
  const hasUrl = typeof r.url === "string" && r.url.trim().length > 0;
  const type = typeof r.type === "string" ? r.type.trim().toLowerCase() : "";
  let transport: "stdio" | "http" | null = null;
  if (type === "http" || type === "sse" || type === "streamable-http") transport = "http";
  else if (type === "stdio") transport = "stdio";
  else if (hasCommand && hasUrl) return t("settings.mcp.jsonCommandOrUrl", { label });
  else if (hasUrl) transport = "http";
  else if (hasCommand) transport = "stdio";
  else return t("settings.mcp.jsonMissingCommandUrl", { label });

  const draft: McpServerDraft = { name, transport };
  if (transport === "stdio") {
    draft.command = String(r.command).trim();
    if (r.args !== undefined) {
      if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== "string")) {
        return t("settings.mcp.jsonArgsArray", { label });
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
      return t("settings.mcp.jsonLifecycle", { label });
    }
  }
  if (r.idleTimeout !== undefined) {
    if (typeof r.idleTimeout === "number" && Number.isFinite(r.idleTimeout) && r.idleTimeout >= 5_000) {
      draft.idleTimeout = Math.floor(r.idleTimeout);
    } else {
      return t("settings.mcp.jsonIdleTimeout", { label });
    }
  }
  if (r.callTimeout !== undefined) {
    if (typeof r.callTimeout === "number" && Number.isFinite(r.callTimeout) && r.callTimeout >= 5_000) {
      draft.callTimeout = Math.floor(r.callTimeout);
    } else {
      return t("settings.mcp.jsonCallTimeout", { label });
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
      return t("settings.mcp.jsonApproveTools", { label });
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
      errors: [
        t("settings.mcp.jsonParseFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      ],
    };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { drafts: [], errors: [t("settings.mcp.jsonRootObject")] };
  }
  const root = doc as Record<string, unknown>;
  let map: Record<string, unknown>;
  if (root.mcpServers !== undefined) {
    if (
      typeof root.mcpServers !== "object" ||
      root.mcpServers === null ||
      Array.isArray(root.mcpServers)
    ) {
      return { drafts: [], errors: [t("settings.mcp.jsonServersObject")] };
    }
    map = root.mcpServers as Record<string, unknown>;
  } else if (typeof root.command === "string" || typeof root.url === "string") {
    const name = typeof root.name === "string" ? root.name : "";
    if (!name) return { drafts: [], errors: [t("settings.mcp.jsonSingleNeedsName")] };
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
    errors.push(t("settings.mcp.jsonNoEntries"));
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
  const t = useT();
  // 批量导入同样要区分「正在看的目录」和「当前会话工作区」
  const activeWorkspace = useProjectWorkspaceDir();
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
          res.errors.push(t("settings.mcp.jsonDuplicate", { name: d.name }));
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
            t("settings.mcp.importOneFailed", {
              name: draft.name,
              error: err instanceof Error ? err.message : String(err),
            }),
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
              {t("settings.mcp.jsonTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm">
              {layer === "workspace"
                ? t("settings.mcp.importWorkspaceDesc", { cwd: workspaceCwd ?? "" })
                : t("settings.mcp.importSystemDesc")}
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex min-w-0 flex-col gap-4">
          <Label className="flex w-full min-w-0 flex-col items-start gap-1 text-sm">
            <span className="text-muted-foreground text-[13px] leading-5">
              {t("settings.mcp.jsonFieldLabel")}
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
                ? t("settings.mcp.importWorkspaceFooter")
                : t("settings.mcp.importSystemFooter")}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("settings.mcp.cancel")}
              </Button>
              <Button onClick={() => void importAll()} disabled={busy || !canImport}>
                {busy
                  ? t("settings.mcp.importing")
                  : hasInput && drafts.length > 0 && errors.length === 0
                    ? t("settings.mcp.importCount", { count: drafts.length })
                    : t("settings.mcp.import")}
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
  const t = useT();
  const status = entry.status;
  const target = entry.transport === "http" ? entry.url : entry.command;
  // 工具清单展开（ready 行才有触发器）：首次展开才拉，行内缓存
  const [toolsOpen, setToolsOpen] = useState(false);
  const [capabilityTab, setCapabilityTab] = useState<McpCapabilityTab | null>(null);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const toggleTools = () => {
    const next = !toolsOpen;
    setToolsOpen(next);
    if (next) setCapabilityTab(null);
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
  const toggleCapability = (tab: McpCapabilityTab) => {
    setToolsOpen(false);
    setCapabilityTab((current) => (current === tab ? null : tab));
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
            title={t(STATE_LABEL[status.state])}
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
                {t("settings.mcp.pluginBadge")}
              </Badge>
            )}
            {entry.transport === "stdio" && entry.secretEnv && entry.secretEnv.length > 0 && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 border-emerald-600/40 text-[13px] leading-5 text-emerald-700 dark:text-emerald-400"
                title={t("settings.mcp.secretsInjectedTitle", { count: entry.secretEnv.length })}
              >
                <KeyRoundIcon className="size-3" />
                {t("settings.mcp.secretsCount", { count: entry.secretEnv.length })}
              </Badge>
            )}
            {entry.transport === "stdio" && entry.secretBindingStale && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 border-amber-600/40 text-[13px] leading-5 text-amber-700 dark:text-amber-400"
                title={t("settings.mcp.secretStaleTitle")}
              >
                <TriangleAlertIcon className="size-3" />
                {t("settings.mcp.secretStaleBadge")}
              </Badge>
            )}
            {status.state === "ready" ? (
              <>
                <button
                  type="button"
                  onClick={toggleTools}
                  className="text-emerald-600 dark:text-emerald-400 hover:underline shrink-0 cursor-pointer text-[13px] leading-5"
                  title={toolsOpen ? t("settings.mcp.collapseTools") : t("settings.mcp.expandTools")}
                >
                  {t("settings.mcp.toolsCount", { count: status.toolCount })}
                  <ChevronDownIcon
                    className={cn(
                      "mb-[2px] inline size-3 transition-transform",
                      toolsOpen && "rotate-180",
                    )}
                  />
                </button>
                {status.capabilities?.resources ? (
                  <button
                    type="button"
                    onClick={() => toggleCapability("resources")}
                    className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer text-[13px] leading-5 hover:underline"
                  >
                    {t("settings.mcp.resourcesCount", { count: status.resourceCount ?? 0 })}
                    <ChevronDownIcon
                      className={cn(
                        "mb-[2px] inline size-3 transition-transform",
                        capabilityTab === "resources" && "rotate-180",
                      )}
                    />
                  </button>
                ) : null}
                {status.capabilities?.prompts ? (
                  <button
                    type="button"
                    onClick={() => toggleCapability("prompts")}
                    className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer text-[13px] leading-5 hover:underline"
                  >
                    {t("settings.mcp.promptsCount", { count: status.promptCount ?? 0 })}
                    <ChevronDownIcon
                      className={cn(
                        "mb-[2px] inline size-3 transition-transform",
                        capabilityTab === "prompts" && "rotate-180",
                      )}
                    />
                  </button>
                ) : null}
              </>
            ) : status.needsAuth ? (
              <span className="text-amber-600 dark:text-amber-400 shrink-0 text-[13px] leading-5">
                {t("settings.mcp.needsAuth")}
              </span>
            ) : status.state !== "idle" ? (
              <span className="text-muted-foreground shrink-0 text-[13px] leading-5">
                {t(STATE_LABEL[status.state])}
              </span>
            ) : null}
          </div>

          <div className="text-muted-foreground mt-1 line-clamp-2 text-[13px] leading-5">
            {entry.description || target || t("settings.mcp.noTarget")}
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
                title={t("settings.mcp.authorizeTitle")}
              >
                {authorizing ? t("settings.mcp.authorizing") : t("settings.mcp.authorize")}
              </Button>
            )}
            {entry.enabled && status.state !== "ready" && !status.needsAuth && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-[13px] leading-5"
                onClick={onTest}
                disabled={testing || status.state === "connecting"}
                title={status.message ?? t("settings.mcp.forceConnectTitle")}
              >
                {testing || status.state === "connecting"
                  ? t("settings.mcp.connecting")
                  : status.state === "backoff"
                    ? t("settings.mcp.retry")
                    : t("settings.mcp.connect")}
              </Button>
            )}
            {(testing || testResult) && (
              <AnimatedBadge
                size="sm"
                status={testing ? "loading" : testResult === "ok" ? "success" : "danger"}
              >
                {testing
                  ? t("settings.mcp.testing")
                  : testResult === "ok"
                    ? t("settings.mcp.testOk")
                    : t("settings.mcp.testFail")}
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
                  title={t("settings.mcp.revokeTitle")}
                >
                  {revoking ? t("settings.mcp.revoking") : t("settings.mcp.revoke")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onTest}
                disabled={testing}
                title={t("settings.mcp.testTitle")}
              >
                <FlaskConicalIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onLog}
                title={t("settings.mcp.logTitle")}
              >
                <FileTextIcon className="size-3.5" />
              </Button>
              {!readOnly && onEdit && (
                <Button variant="ghost" size="icon" className="size-7" onClick={onEdit} title={t("settings.mcp.edit")}>
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
                    {t("settings.mcp.deleteConfirm")}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-7"
                    onClick={onDelete}
                    title={t("settings.mcp.delete")}
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
          aria-label={t("settings.mcp.enableAria", { name: entry.name })}
        />
      </div>

      {toolsOpen && (
        <div className="bg-muted/40 mx-3 mb-3 rounded-xl border px-3 py-1.5">
          {toolsBusy ? (
            <p className="text-muted-foreground py-2 text-[13px] leading-5">
              {t("settings.mcp.toolsLoading")}
            </p>
          ) : toolsError ? (
            <p className="text-destructive py-2 text-[13px] leading-5">
              {t("settings.mcp.toolsLoadFailed", { error: toolsError })}
            </p>
          ) : tools && tools.length > 0 ? (
            <ul className="divide-border/50 flex flex-col divide-y">
              {tools.map((tool) => (
                <li key={tool.name} className="flex flex-col gap-0.5 py-1.5">
                  <span className="font-mono text-[13px] leading-5 font-medium">{tool.name}</span>
                  {tool.description ? (
                    <span className="text-muted-foreground line-clamp-2 text-[13px] leading-5">
                      {tool.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground py-2 text-[13px] leading-5">
              {t("settings.mcp.noTools")}
            </p>
          )}
        </div>
      )}

      {capabilityTab ? (
        <div className="bg-muted/40 mx-3 mb-3 rounded-xl border px-3 py-1.5">
          <McpCapabilityBrowser
            serverName={entry.name}
            cwd={entry.layer === "system" ? undefined : workspaceCwd}
            tab={capabilityTab}
          />
        </div>
      ) : null}

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
  { labelKey: string; className: string }
> = {
  connect: {
    labelKey: "settings.mcp.auditConnect",
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  connect_fail: {
    labelKey: "settings.mcp.auditConnectFail",
    className: "bg-destructive/15 text-destructive",
  },
  disconnect: { labelKey: "settings.mcp.auditDisconnect", className: "bg-muted text-muted-foreground" },
  call: {
    labelKey: "settings.mcp.auditCall",
    className: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  resource_read: {
    labelKey: "settings.mcp.auditResourceRead",
    className: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  },
  prompt_get: {
    labelKey: "settings.mcp.auditPromptGet",
    className: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  },
  truncate: {
    labelKey: "settings.mcp.auditTruncate",
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  auth: {
    labelKey: "settings.mcp.auditAuth",
    className: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  probe_fail: {
    labelKey: "settings.mcp.auditProbeFail",
    className: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  },
};

const McpLogDialog: FC<{
  name: string | null;
  onOpenChange: (open: boolean) => void;
}> = ({ name, onOpenChange }) => {
  const t = useT();
  const locale = getLocale() === "zh" ? "zh-CN" : "en-US";
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
              {t("settings.mcp.logDialogTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm">
              {t("settings.mcp.logDialogDesc", { name: name ?? "" })}
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {error ? (
            <p className="text-destructive min-w-0 text-sm [overflow-wrap:anywhere]">{error}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-4">
              <section className="min-w-0">
                <h4 className="mb-1.5 text-[13px] leading-5 font-medium">
                  {t("settings.mcp.connectionErrors")}
                </h4>
                {busy && lines.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm">
                    {t("settings.mcp.reading")}
                  </p>
                ) : lines.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm">
                    {t("settings.mcp.noConnectionErrors")}
                  </p>
                ) : (
                  <ul className="bg-muted/60 flex max-h-64 min-w-0 flex-col gap-1.5 overflow-y-auto rounded-lg border p-3">
                    {lines.map((l, i) => (
                      <li key={i} className="flex min-w-0 gap-2 text-[13px] leading-5">
                        <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                          {new Date(l.at).toLocaleString(locale)}
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
                  {t("settings.mcp.connectionEvents")}
                  <span className="text-muted-foreground ml-1.5 font-normal">
                    {t("settings.mcp.eventsPersist")}
                  </span>
                </h4>
                {busy && events.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm">
                    {t("settings.mcp.reading")}
                  </p>
                ) : recentEvents.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm">
                    {t("settings.mcp.noEvents")}
                  </p>
                ) : (
                  <ul className="bg-muted/60 flex max-h-64 min-w-0 flex-col gap-1 overflow-y-auto rounded-lg border p-3">
                    {recentEvents.map((e, i) => {
                      const meta = AUDIT_KIND_META[e.kind] ?? AUDIT_KIND_META.disconnect;
                      return (
                        <li key={i} className="flex min-w-0 items-baseline gap-2 text-[13px] leading-5">
                          <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                            {new Date(e.at).toLocaleString(locale)}
                          </span>
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[13px] leading-4 font-medium",
                              meta.className,
                            )}
                          >
                            {t(meta.labelKey)}
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
            {t("settings.mcp.logFooter")}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void load()} disabled={busy}>
              <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
              {t("settings.mcp.refresh")}
            </Button>
            <Button onClick={() => onOpenChange(false)}>{t("settings.mcp.close")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 工作区范围选择器（与记忆、子智能体管理页同款）：只列项目/工作区。 */
export const McpSettings: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const t = useT();
  const workspace = useProjectWorkspaceDir();
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
          // 插件镜像跟随当前会话工作区，不跟设置页选择的工作区范围
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
          title: t("settings.mcp.testSuccessTitle", { name: entry.name }),
          description: t("settings.mcp.testSuccessDesc", { count: status.toolCount }),
        });
      } else {
        setTestResults((m) => ({ ...m, [entry.name]: "fail" }));
        // 连接按钮已经常显，失败必须给原因；行内「失败」徽标不够自解释
        toast.error({
          title: t("settings.mcp.testFailTitle", { name: entry.name }),
          description: status.message ?? t("settings.mcp.testFailDesc"),
        });
      }
    } catch (err) {
      setTestResults((m) => ({ ...m, [entry.name]: "fail" }));
      toast.error({
        title: t("settings.mcp.testFailTitle", { name: entry.name }),
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
          title: t("settings.mcp.testSuccessTitle", { name: entry.name }),
          description: t("settings.mcp.authorizeSuccessDesc"),
        });
      }
    } catch (err) {
      setAuthorizeError(
        t("settings.mcp.authorizeFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
        setAuthorizeError(
          t("settings.mcp.authorizeFailed", {
            error: frame.errorText ?? t("settings.mcp.authorizeFailedUnknown"),
          }),
        );
        return;
      }
      if (frame.workspaceCwd !== viewingCwd) void refreshMcpServers(viewingCwd);
      toast.success({ title: t("settings.mcp.authorizeDone", { name: frame.name }) });
    });
    return () => setMcpAuthHandler(null);
  }, [viewingCwd, t]);

  const copyAuthUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success({ title: t("settings.mcp.authLinkCopied") });
    } catch {
      toast.error({
        title: t("settings.mcp.copyFailed"),
        description: t("settings.mcp.copyFailedDesc"),
      });
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
      setAuthorizeError(
        t("settings.mcp.revokeFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
            <h1 className="text-2xl font-bold tracking-tight">{t("settings.mcp.title")}</h1>
            <span
              className={cn("text-[13px] leading-5", snap.error ? "text-destructive" : "text-muted-foreground")}
            >
              {snap.error
                ? t("settings.mcp.loadFailedShort")
                : `${t("settings.mcp.serversEnabledCount", {
                    count: snap.servers.length,
                    enabled: snap.servers.filter((s) => s.enabled).length,
                  })}${
                    snap.pluginServers.length > 0
                      ? t("settings.mcp.pluginCount", { count: snap.pluginServers.length })
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
                { value: "system", label: t("settings.mcp.scopeSystem") },
                { value: "workspace", label: t("settings.mcp.scopeWorkspace") },
              ]}
            />
            {scopeTab === "workspace" && (
              <ProjectScopeMenu
                value={viewingCwd}
                following={!overrideCwd}
                onChange={(dir) =>
                  setOverrideCwd(dir === workspace ? null : dir)
                }
                onFollowCurrent={() => setOverrideCwd(null)}
              />
            )}
            <span className="text-muted-foreground text-sm leading-relaxed">
              {t("settings.mcp.serversCount", { count: visible.length })}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Input
                className="h-8 w-56 bg-muted/50"
                placeholder={t("settings.mcp.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={refresh}
                disabled={refreshing}
                aria-label={t("settings.mcp.refresh")}
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
                  {t("settings.mcp.create")}
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem onClick={openCreate}>
                    <SquarePenIcon className="size-4" />
                    {t("settings.mcp.createForm")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openCreateJson}>
                    <BracesIcon className="size-4" />
                    {t("settings.mcp.createJson")}
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
                  {t("settings.mcp.authorizeRetryHint")}
                </span>
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0 text-[13px] leading-5 underline-offset-2 hover:underline"
                onClick={() => setAuthorizeError(null)}
              >
                {t("settings.mcp.collapse")}
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
                  <span className="font-medium">
                    {t("settings.mcp.waitingAuth", { name: pendingAuth.name })}
                  </span>
                  <span className="text-muted-foreground">
                    {pendingAuth.browserOpened
                      ? t("settings.mcp.authBrowserOpened")
                      : t("settings.mcp.authBrowserFailed")}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground shrink-0 text-[13px] leading-5 underline-offset-2 hover:underline"
                  onClick={() => setPendingAuth(null)}
                >
                  {t("settings.mcp.collapse")}
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
                  {t("settings.mcp.openAuthPage")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[13px] leading-5"
                  onClick={() => void copyAuthUrl(pendingAuth.authUrl)}
                >
                  {t("settings.mcp.copyLink")}
                </Button>
              </div>
            </div>
          ) : null}

          {/* 服务器列表：两列自适应卡片行（无外框，行间细分隔线） */}
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(520px,1fr))] items-start gap-3">
            {snap.error ? (
              <div className="text-muted-foreground col-span-full rounded-2xl border border-dashed px-4 py-6 text-sm">
                {t("settings.mcp.loadFailed", { error: snap.error })}
              </div>
            ) : workspaceUnavailable ? (
              <div className="text-muted-foreground col-span-full rounded-2xl border border-dashed px-4 py-6 text-sm">
                {t("settings.mcp.workspaceUnavailable")}
              </div>
            ) : visible.length === 0 ? (
              <div className="text-muted-foreground col-span-full rounded-2xl border border-dashed px-4 py-6 text-sm">
                {query.trim()
                  ? pluginVisible.length > 0
                    ? t("settings.mcp.emptyNoMatchPlugin")
                    : t("settings.mcp.emptyNoMatch", { query: query.trim() })
                  : scopeTab === "workspace"
                    ? t("settings.mcp.emptyWorkspace")
                    : t("settings.mcp.emptySystem")}
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
                {t("settings.mcp.sharedFileHint")}
              </div>
            )}
          </div>

          {/* 插件 MCP：定义归插件所有，不参与系统/工作区页签；这里只做连接/授权、
              日志与启停，编辑仍在插件详情（同一份 pluginServers 数据） */}
          {!snap.error && pluginVisible.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-semibold">{t("settings.mcp.pluginSection")}</h2>
                <span className="text-muted-foreground text-sm">
                  {t("settings.mcp.serversCount", { count: pluginVisible.length })}
                </span>
              </div>
              <p className="text-muted-foreground text-[13px] leading-5">
                {t("settings.mcp.pluginSectionDesc")}
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
                <span className="text-foreground font-medium">{t("settings.mcp.diagnostics")}</span>
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
