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
  FolderOpenIcon,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { JsonCodeEditor } from "@/components/code/cm-json-editor";
import { isTauri } from "@/lib/tauri";
import { pathBasename, useWorkspace, useWorkspaceRecents } from "@/lib/workspace/workspace-store";
import {
  authorizeMcpServer,
  deleteMcpServer,
  fetchMcpAuditLog,
  fetchMcpServerLog,
  fetchMcpServerTools,
  refreshMcpServers,
  revokeMcpServerAuth,
  saveMcpServer,
  setMcpServerEnabled,
  testMcpServer,
  useMcpServers,
  type McpAuditEvent,
  type McpLogLine,
  type McpServerDraft,
  type McpToolInfo,
  type McpServerEntry,
  type McpServerIcon,
} from "@/lib/mcp/mcp";
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
};

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
  const isEdit = target?.mode === "edit";
  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !target) return;
    setForm(target.mode === "edit" ? entryToForm(target.entry) : EMPTY_FORM);
    setError(null);
    setBusy(false);
  }, [open, target]);

  if (!target || target.mode === "json") return null;
  const layer = writableLayer(target.mode === "create" ? target.layer : target.entry.layer);
  const layerNeedsCwd = layer === "workspace" && !workspaceCwd;
  const insecureHttp =
    form.transport === "http" && isNonLoopbackHttpUrl(form.url);

  const setField = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    if (busy) return;
    const draft = formToDraft(form);
    if (typeof draft === "string") {
      setError(draft);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveMcpServer({
        layer,
        cwd: layer === "workspace" ? workspaceCwd ?? undefined : undefined,
        ...(isEdit && target.mode === "edit" ? { name: target.entry.name } : {}),
        definition: draft,
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target.mode === "create"
              ? layer === "workspace"
                ? "新建工作区 MCP 服务器"
                : "新建系统 MCP 服务器"
              : `编辑 ${target.entry.name}`}
          </DialogTitle>
          <DialogDescription>
            {layer === "workspace"
              ? `保存到 ${workspaceCwd ?? ""}/.kova/mcp.json（随仓库共享；不改写 .mcp.json）`
              : "保存到 ~/.kova/mcp.json，对本机所有工作区生效"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <Label className="flex min-w-0 flex-1 flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">名称</span>
              <Input
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="如 github（字母/数字/_/-，≤64）"
                className="font-mono"
              />
            </Label>
            <div className="flex shrink-0 flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">传输</span>
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
                <span className="text-muted-foreground text-xs">启动命令</span>
                <Input
                  value={form.command}
                  onChange={(e) => setField("command", e.target.value)}
                  placeholder="如 npx（不含 .. 的命令名或绝对路径）"
                  className="font-mono"
                />
              </Label>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-xs">参数（每行一个）</span>
                <Textarea
                  value={form.argsText}
                  onChange={(e) => setField("argsText", e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={"-y\n@modelcontextprotocol/server-xxx"}
                  spellCheck={false}
                />
              </Label>
            </>
          ) : (
            <>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-xs">端点 URL</span>
                <Input
                  value={form.url}
                  onChange={(e) => setField("url", e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="font-mono"
                />
              </Label>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-xs">请求头（每行 Key=Value）</span>
                <Textarea
                  value={form.headersText}
                  onChange={(e) => setField("headersText", e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={"Authorization=Bearer ..."}
                  spellCheck={false}
                />
              </Label>
            </>
          )}

          {form.transport === "stdio" && (
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                环境变量（每行 KEY=value；只有这里声明的变量会传给子进程）
              </span>
              <Textarea
                value={form.envText}
                onChange={(e) => setField("envText", e.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder={"GITHUB_TOKEN=..."}
                spellCheck={false}
              />
            </Label>
          )}

          {insecureHttp && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span>
                这是非环回的明文 HTTP 端点：凭证与工具调用内容可能被网络截获。保存即表示你知晓并接受该风险。
              </span>
            </div>
          )}

          <Label className="flex flex-col items-start gap-1 text-sm">
            <span className="text-muted-foreground text-xs">
              描述（注入系统提示词，帮助模型选择）
            </span>
            <Input
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
              placeholder="如 GitHub API：仓库、issue、PR 操作"
            />
          </Label>

          <Collapsible>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-xs transition-colors">
              高级选项
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-3">
              <div className="flex gap-3">
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-xs">生命周期</span>
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
                  <span className="text-muted-foreground text-xs">
                    免审批工具（逗号分隔 glob，如 get_*, list_*）
                  </span>
                  <Input
                    value={form.approveToolsText}
                    onChange={(e) => setField("approveToolsText", e.target.value)}
                    placeholder="留空 = 每次调用都需确认"
                    className="font-mono  text-xs"
                  />
                  {layer === "workspace" && (
                    // 工作区文件跟着仓库走：不能给自己授权。要免审批就在审批卡上点
                    // 「允许并记住这个工具」（记进本机 permissions.local.json）
                    <span className="text-muted-foreground text-xs">
                      工作区配置里的免审批名单不在本机生效（仓库不能给自己授权），只作为审批卡上的说明；
                      要免审批请在审批卡上点「允许并记住这个工具」，或把该服务器配到系统层。
                    </span>
                  )}
                </Label>
              </div>
              <div className="flex gap-3">
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-xs">
                    工具调用超时（毫秒；留空 = 默认 120000，即 2 分钟）
                  </span>
                  <Input
                    type="number"
                    min={5000}
                    step={1000}
                    value={form.callTimeoutText}
                    onChange={(e) => setField("callTimeoutText", e.target.value)}
                    placeholder="120000（默认 2 分钟）"
                    className=" font-mono text-xs tabular-nums"
                  />
                </Label>
                <Label className="flex flex-1 flex-col items-start gap-1">
                  <span className="text-muted-foreground text-xs">
                    空闲断开时间（毫秒；留空 = 默认 600000，即 10 分钟）
                  </span>
                  <Input
                    type="number"
                    min={5000}
                    step={1000}
                    value={form.idleTimeoutText}
                    onChange={(e) => setField("idleTimeoutText", e.target.value)}
                    placeholder="600000（默认 10 分钟）"
                    className=" font-mono text-xs tabular-nums"
                  />
                </Label>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        {error && (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
        {layerNeedsCwd && (
          <p className="text-muted-foreground text-xs">
            未选择工作区：先在主界面选好工作目录，或切换到"系统级"页签。
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={busy || layerNeedsCwd}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// JSON 导入弹窗（粘贴 mcpServers JSON → 本地校验预览 → 逐台 saveMcpServer）
// ---------------------------------------------------------------------------

const ENTRY_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const LIFECYCLE_VALUES = ["lazy", "eager", "keep-alive"] as const;

const JSON_IMPORT_PLACEHOLDER = `{ "mcpServers": { "名称": { "command": "…", "args": ["…"] } } }`;

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
            cwd: layer === "workspace" ? workspaceCwd ?? undefined : undefined,
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
      {/* DialogContent 基类没有 max-h/overflow：长内容会把弹窗顶出视口，这里自限高度 */}
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>JSON 导入 MCP 服务器</DialogTitle>
          <DialogDescription>
            {layer === "workspace"
              ? `导入到 ${workspaceCwd ?? ""}/.kova/mcp.json（随仓库共享；不改写 .mcp.json）`
              : "导入到 ~/.kova/mcp.json，对本机所有工作区生效"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          <Label className="flex w-full min-w-0 flex-col items-start gap-1 text-sm">
            <span className="text-muted-foreground text-xs">
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
                <div key={d.name} className="flex min-w-0 items-center gap-2 text-xs">
                  {d.transport === "http" ? (
                    <ServerIcon className="text-muted-foreground size-3.5 shrink-0" />
                  ) : (
                    <SquareTerminalIcon className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  <span className="shrink-0 font-mono font-medium">{d.name}</span>
                  <Badge variant="outline" className="shrink-0 font-mono text-xs">
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
            <ul className="text-destructive flex min-w-0 flex-col gap-0.5 break-words text-xs" role="alert">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {error && (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
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
        </DialogFooter>
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
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onAuthorize: () => void;
  onRevoke: () => void;
  onLog: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
}> = ({
  entry,
  workspaceCwd,
  testing,
  testResult,
  authorizing,
  revoking,
  confirmingDelete,
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
        entry.layer === "workspace" ? workspaceCwd : undefined,
      )
        .then(setTools)
        .catch((err) => setToolsError(err instanceof Error ? err.message : String(err)))
        .finally(() => setToolsBusy(false));
    }
  };
  return (
    <div className="flex flex-col">
    <div className="hover:bg-muted/70 flex items-center gap-3 rounded-xl px-3 py-2 transition-colors">
      {/* 图标盒 + 连接状态点（记忆文件行同款 size-9 边框盒） */}
      <div className="bg-background text-muted-foreground relative flex size-9 shrink-0 items-center justify-center rounded-lg border">
        <McpProtocolIcon
          icons={status.icons}
          fallback={
            entry.transport === "http" ? (
              <ServerIcon className="size-4" />
            ) : (
              <SquareTerminalIcon className="size-4" />
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
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <Badge variant="outline" className="shrink-0 font-mono text-xs">
            {entry.transport}
          </Badge>
          {status.state === "ready" ? (
            <button
              type="button"
              onClick={toggleTools}
              className="text-emerald-600 dark:text-emerald-400 hover:underline shrink-0 cursor-pointer text-xs"
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
            <span className="text-amber-600 dark:text-amber-400 shrink-0 text-xs">
              需要授权
            </span>
          ) : status.state !== "idle" ? (
            <span className="text-muted-foreground truncate text-xs">
              {STATE_LABEL[status.state]}
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          <span className="truncate">{entry.description || target || "未配置目标"}</span>
          {entry.source && (
            <span className="hidden truncate font-mono text-xs lg:block">
              {entry.layer === "workspace" &&
              workspaceCwd &&
              entry.source.startsWith(workspaceCwd + "/")
                ? entry.source.slice(workspaceCwd.length + 1)
                : entry.source}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {entry.transport === "http" && (status.needsAuth || authorizing) && (
          <Button
            variant="outline"
            size="sm"
            className="text-amber-600 dark:text-amber-400 h-7 border-amber-600/40 px-2 text-xs"
            onClick={onAuthorize}
            disabled={authorizing}
            title="打开浏览器完成该服务器的 OAuth 授权"
          >
            {authorizing ? "等待浏览器授权…" : "授权"}
          </Button>
        )}
        {entry.transport === "http" && status.oauthAuthorized && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive h-7 px-2 text-xs"
            onClick={onRevoke}
            disabled={revoking}
            title="清除已存储的 OAuth 凭据并断开；下次连接需重新授权（不删除服务器配置）"
          >
            {revoking ? "取消中…" : "取消授权"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onTest}
          disabled={testing}
          title="强制重新握手并统计工具"
        >
          测试
        </Button>
        {/* 测试状态徽标：进行中 loading，结束后成功/失败 */}
        {(testing || testResult) && (
          <AnimatedBadge
            size="sm"
            status={
              testing ? "loading" : testResult === "ok" ? "success" : "danger"
            }
          >
            {testing ? "测试中" : testResult === "ok" ? "成功" : "失败"}
          </AnimatedBadge>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onLog}
          title="查看连接日志与事件"
        >
          日志
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={onEdit} title="编辑">
          <PencilIcon className="size-3.5" />
        </Button>
        {!entry.fromStandard &&
          (confirmingDelete ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-xs"
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
        <Switch
          size="sm"
          checked={entry.enabled}
          onCheckedChange={onToggle}
          aria-label={`${entry.name} 启用`}
        />
      </div>
      </div>
      {toolsOpen && (
        <div className="bg-muted/40 mx-3 mb-2 rounded-xl border px-3 py-1.5">
          {toolsBusy ? (
            <p className="text-muted-foreground py-2 text-xs">加载工具列表…</p>
          ) : toolsError ? (
            <p className="text-destructive py-2 text-xs">工具列表加载失败：{toolsError}</p>
          ) : tools && tools.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border/50">
              {tools.map((t) => (
                <li key={t.name} className="flex flex-col gap-0.5 py-1.5">
                  <span className="font-mono text-xs font-medium">{t.name}</span>
                  {t.description ? (
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {t.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground py-2 text-xs">该服务器未提供工具</p>
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
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>连接日志</DialogTitle>
          <DialogDescription>
            {name} · 连接错误（最近 100 条）与持久化审计事件，点「测试」可重新握手
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-destructive min-w-0 break-words text-sm">{error}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <section>
              <h4 className="mb-1.5 text-xs font-medium">连接错误</h4>
              {busy && lines.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">读取中…</p>
              ) : lines.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  暂无连接错误
                </p>
              ) : (
                <ul className="bg-muted/60 flex max-h-64 min-w-0 flex-col gap-1.5 overflow-y-auto rounded-lg border p-3">
                  {lines.map((l, i) => (
                    <li key={i} className="flex min-w-0 gap-2 text-xs">
                      <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                        {new Date(l.at).toLocaleString()}
                      </span>
                      <span className="min-w-0 break-words">{l.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h4 className="mb-1.5 text-xs font-medium">
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
                      <li key={i} className="flex min-w-0 items-baseline gap-2 text-xs">
                        <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                          {new Date(e.at).toLocaleString()}
                        </span>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-xs leading-4 font-medium",
                            meta.className,
                          )}
                        >
                          {meta.label}
                          {e.ok === false && <XIcon className="size-3 shrink-0" />}
                        </span>
                        {e.detail ? (
                          <span className="min-w-0 break-words">{e.detail}</span>
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
        <DialogFooter className="items-center sm:justify-end">
          <Button variant="outline" onClick={() => void load()} disabled={busy}>
            <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
            刷新
          </Button>
          <Button onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
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
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs transition-colors"
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
        <div className="text-muted-foreground px-2 py-3 text-center text-xs">暂无记录</div>
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

export const McpSettings: FC = () => {
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
  const [testingName, setTestingName] = useState<string | null>(null);
  // 各服务器最近一次「测试」结果（按 name），驱动行内状态徽标
  const [testResults, setTestResults] = useState<
    Record<string, "ok" | "fail">
  >({});
  // OAuth 授权进行中的服务器名（sidecar 已开浏览器，等用户批准回跳）
  const [authorizingName, setAuthorizingName] = useState<string | null>(null);
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

  const toggle = (entry: McpServerEntry, enabled: boolean) => {
    void setMcpServerEnabled(
      entry.layer,
      entry.name,
      enabled,
      entry.layer === "workspace" ? viewingCwd : undefined,
    ).catch(() => {});
  };

  const remove = (entry: McpServerEntry) => {
    void deleteMcpServer(
      writableLayer(entry.layer),
      entry.name,
      entry.layer === "workspace" ? viewingCwd : undefined,
    ).catch(() => {});
    setConfirmDelete(null);
  };

  const test = async (entry: McpServerEntry) => {
    if (testingName) return;
    setTestingName(entry.name);
    try {
      const status = await testMcpServer(
        writableLayer(entry.layer),
        entry.name,
        entry.layer === "workspace" ? viewingCwd : undefined,
      );
      if (status.state === "ready") {
        setTestResults((m) => ({ ...m, [entry.name]: "ok" }));
        toast.success({
          title: `${entry.name} 测试成功`,
          description: `连接正常，发现 ${status.toolCount} 个工具`,
        });
      } else {
        setTestResults((m) => ({ ...m, [entry.name]: "fail" }));
      }
    } catch {
      setTestResults((m) => ({ ...m, [entry.name]: "fail" }));
    } finally {
      setTestingName(null);
    }
  };

  // OAuth 授权：sidecar 打开浏览器等用户批准，可能几分钟，清单在成功后整体刷新。
  const authorize = async (entry: McpServerEntry) => {
    if (authorizingName) return;
    setAuthorizingName(entry.name);
    setAuthorizeError(null);
    try {
      await authorizeMcpServer(
        entry.name,
        entry.layer === "workspace" ? viewingCwd : undefined,
      );
    } catch (err) {
      setAuthorizeError(`授权失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAuthorizingName(null);
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
        entry.layer === "workspace" ? viewingCwd : undefined,
      );
    } catch (err) {
      setAuthorizeError(`取消授权失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRevokingName(null);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    void refreshMcpServers(viewingCwd).finally(() => setRefreshing(false));
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
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "浏览工作区 MCP 配置" });
      if (typeof dir === "string") setOverrideCwd(dir === workspace ? null : dir);
    } catch {
      // 非 Tauri 环境：无原生目录选择器
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
      <div className="flex w-full max-w-7xl flex-col gap-8 self-center px-8 py-8">
        {/* 标题行：状态文字在右（记忆页同款） */}
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">MCP 服务器</h1>
          <span
            className={cn("text-xs", snap.error ? "text-destructive" : "text-muted-foreground")}
          >
            {snap.error
              ? "清单加载失败，可刷新重试"
              : `${snap.servers.length} 个服务器（${snap.servers.filter((s) => s.enabled).length} 个启用）`}
          </span>
        </div>

        <section className="flex flex-col gap-3">
          {/* 工具行：作用域页签 + 工作区切换 + 搜索/刷新/新建 */}
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={scopeTab} onValueChange={(v) => setScopeTab(v as ScopeTab)}>
              <TabsList className="h-auto rounded-full bg-muted/50 p-[3px]">
                <TabsTrigger value="system" className="rounded-full px-3 py-1 text-sm">
                  系统级
                </TabsTrigger>
                <TabsTrigger value="workspace" className="rounded-full px-3 py-1 text-sm">
                  工作区级
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {scopeTab === "workspace" && (
              <WorkspaceCwdMenu
                value={viewingCwd}
                following={!overrideCwd}
                followLabel={workspace ? pathBasename(workspace) : null}
                candidates={cwdCandidates}
                showBrowse={isTauri()}
                onChange={(dir) => setOverrideCwd(dir === workspace ? null : dir)}
                onFollowCurrent={() => setOverrideCwd(null)}
                onBrowse={() => void pickBrowseDir()}
              />
            )}
            <span className="text-muted-foreground text-sm">{visible.length} 个服务器</span>
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
                className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline-offset-2 hover:underline"
                onClick={() => setAuthorizeError(null)}
              >
                收起
              </button>
            </div>
          ) : null}

          {/* 服务器列表卡片（记忆文件列表同款容器） */}
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {snap.error ? (
              <div className="text-muted-foreground px-3 py-3 text-sm">
                清单加载失败：{snap.error}
              </div>
            ) : workspaceUnavailable ? (
              <div className="text-muted-foreground px-3 py-3 text-sm">
                未选择工作区。选择工作区后，这里会合并显示该仓库 .mcp.json（共享）与
                .kova/mcp.json（覆盖层）的服务器；也可以点上方目录切换器「浏览其他目录…」。
              </div>
            ) : visible.length === 0 ? (
              <div className="text-muted-foreground flex flex-col gap-1 px-3 py-3 text-sm">
                <span>
                  {query.trim()
                    ? `没有匹配「${query.trim()}」的服务器。`
                    : scopeTab === "workspace"
                      ? "该工作区还没有 MCP 服务器。点右上角「创建」添加（支持 JSON 批量导入），或让团队成员把 .mcp.json 提交进仓库。"
                      : "还没有系统级 MCP 服务器。点右上角「创建」添加（支持 JSON 批量导入）。"}
                </span>
              </div>
            ) : (
              visible.map((entry) => (
                <McpRow
                  key={`${entry.layer}:${entry.name}`}
                  entry={entry}
                  workspaceCwd={snap.workspaceCwd}
                  testing={testingName === entry.name}
                  testResult={testResults[entry.name] ?? null}
                  authorizing={authorizingName === entry.name}
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
            {/* 兼容性脚注（记忆页 dailyHint 行同款位置） */}
            {scopeTab === "workspace" && !workspaceUnavailable && visible.length > 0 && (
              <div className="text-muted-foreground px-3 py-1.5 text-xs">
                .mcp.json 为生态共享格式（Claude Code / Cursor 等可直接复用）；设置页只写
                .kova/mcp.json 覆盖层，从不改写共享文件。
              </div>
            )}
          </div>

          {snap.diagnostics.length > 0 && (
            <details className="text-xs">
              <summary className="text-muted-foreground cursor-pointer px-1">
                加载诊断（{snap.diagnostics.length}）
              </summary>
              <ul className="text-muted-foreground mt-1 list-disc pl-6">
                {snap.diagnostics.map((d, i) => (
                  <li key={i} className="font-mono text-[11px]">
                    {d}
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
