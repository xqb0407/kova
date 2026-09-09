"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import {
  piRequest,
  type PiSkillSummary,
  type PiModelSummary,
} from "@/lib/pi-bridge";
import { isTauri } from "@/lib/tauri";
import { getWorkspace } from "@/lib/workspace-store";
import { setSelectedModel, useSelectedModel } from "@/lib/model-settings";
import {
  setWindowEffect,
  useWindowEffect,
  type WindowEffectName,
} from "@/lib/appearance";
import {
  copyText,
  encodePairPayload,
  getRemoteWebUrl,
  setRemoteWebUrl,
  type PairPayload,
} from "@/lib/remote";
import { QRCodeSVG } from "qrcode.react";
import {
  BoxesIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  GlobeIcon,
  InfoIcon,
  PaintbrushIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";

type SettingsSection =
  | "models"
  | "skills"
  | "remote"
  | "appearance"
  | "general";

const SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: FC<{ className?: string }>;
}[] = [
  { id: "models", label: "模型", icon: BoxesIcon },
  { id: "skills", label: "技能", icon: SparklesIcon },
  { id: "remote", label: "远程访问", icon: GlobeIcon },
  { id: "appearance", label: "外观", icon: PaintbrushIcon },
  { id: "general", label: "通用", icon: SlidersHorizontalIcon },
];

export const SettingsModal: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const [section, setSection] = useState<SettingsSection>("models");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[560px] max-w-6xl gap-0 overflow-hidden p-0 sm:max-w-5xl"
      >
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
        <div className="min-w-0 flex-1 overflow-y-hidden pt-5">
          {section === "models" && <ModelSettings />}
          {section === "skills" && <SkillsSettings />}
          {section === "remote" && <RemoteSettings />}
          {section === "appearance" && <AppearanceSettings />}
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
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
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
        <div className="text-destructive text-sm">
          加载模型列表失败：{error}
        </div>
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
    <div className="flex flex-col h-full overflow-x-hidden overflow-y-hidden">
      <div className="bg-background p-4">
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

      <div className="flex flex-col overflow-y-auto gap-4 p-4">
        {groups.map(([providerName, items]) => (
          <div key={providerName} data-slot="settings-model-group">
            <div className="text-muted-foreground pb-1.5 text-xs font-medium">
              {providerName}
            </div>
            <div className="flex flex-col gap-0.5">
              {items.map((m) => {
                const isSelected =
                  selected?.provider === m.provider &&
                  selected?.modelId === m.id;
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
                      !m.authed &&
                        "text-muted-foreground/60 cursor-not-allowed",
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

const SKILL_DIR_HINT =
  "技能目录：~/.pi/agent/skills（全局）与 <工作目录>/.pi/skills（项目级），每个技能一个含 SKILL.md 的文件夹。";

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
        <div className="text-destructive text-sm">
          加载技能列表失败：{error}
        </div>
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
    <div className="flex flex-col h-full overflow-hidden">
      <div className="bg-background  p-4">
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
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            onClick={load}
            title="刷新"
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        <div className="text-muted-foreground mt-3 text-xs">
          {SKILL_DIR_HINT}
        </div>
      </div>

      <div className="flex flex-col gap-4  overflow-y-auto p-4">
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

type RemoteStatus = {
  running: boolean;
  port: number | null;
  code: string | null;
  connections: number;
  /** 局域网 WS 地址列表（ws://ip:port/ws，主网卡优先） */
  lanAddresses: string[];
  /** 浏览器预览地址列表（http://ip:port，主网卡优先） */
  httpAddresses: string[];
};

const REMOTE_HINT =
  "开启后手机扫码或访问地址即可直接使用（应用自带网页，无需另外部署）；公网访问可用 Cloudflare Tunnel（cloudflared tunnel --url http://localhost:端口）或 Tailscale，详见 docs/remote-access.md。网页端凭配对码换取长效 token 后即可远程操作本机助手（含文件能力），请勿泄露配对码与地址。";

/** 远程访问页：启停 WS 网关、扫码/配对码、局域网地址 */
const RemoteSettings: FC = () => {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [webUrl, setWebUrl] = useState(() => getRemoteWebUrl());
  const [webUrlDraft, setWebUrlDraft] = useState(() => getRemoteWebUrl());

  const load = useCallback(() => {
    if (!isTauri()) return;
    invoke<RemoteStatus>("pi_remote_status")
      .then(setStatus)
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 运行中轻量轮询：刷新连接数等状态
  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [status?.running, load]);

  const toggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (status?.running) {
        await invoke("pi_remote_stop");
      } else {
        await invoke("pi_remote_start", { port: null });
      }
      setStatus(await invoke<RemoteStatus>("pi_remote_status"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [status?.running]);

  const refreshCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const code = await invoke<string>("pi_remote_refresh_code");
      setStatus((s) => (s ? { ...s, code } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback(async (text: string) => {
    if (await copyText(text)) {
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    }
  }, []);

  const saveWebUrl = useCallback(() => {
    setRemoteWebUrl(webUrlDraft);
    setWebUrl(webUrlDraft.trim());
  }, [webUrlDraft]);

  // 二维码内容（优先级）：网页端地址 > 本机预览地址（扫码直达） > 配置 JSON
  const qr = useMemo(() => {
    if (!status?.running || !status.code) return null;
    const host =
      status.lanAddresses[0] ?? `ws://127.0.0.1:${status.port ?? 8787}/ws`;
    const data: PairPayload = { v: 1, host, code: status.code };
    const web = webUrl.replace(/\/+$/, "");
    if (web && /^https?:\/\//.test(web)) {
      return { value: `${web}#h=${encodePairPayload(data)}`, direct: true };
    }
    const preview = status.httpAddresses[0];
    if (preview) {
      return {
        value: `${preview}/#h=${encodePairPayload(data)}`,
        direct: true,
      };
    }
    return { value: JSON.stringify(data), direct: false };
  }, [
    status?.running,
    status?.code,
    status?.lanAddresses,
    status?.httpAddresses,
    status?.port,
    webUrl,
  ]);

  if (!isTauri()) {
    return (
      <div className="text-muted-foreground p-5 text-sm">
        远程访问配置依赖桌面端，请在 Tauri 应用中打开设置。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-5 overflow-hidden h-full">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-medium">远程网关</div>
          <div className="text-muted-foreground text-xs">
            {status?.running
              ? `运行中 · 端口 ${status.port ?? "-"} · ${status.connections} 个连接`
              : "未开启"}
          </div>
        </div>
        <Button
          size="sm"
          variant={status?.running ? "outline" : "default"}
          disabled={busy}
          onClick={() => void toggle()}
        >
          {status?.running ? "关闭" : "开启"}
        </Button>
      </div>

      {status?.running && (
        <div className="flex flex-col gap-4 flex-1 overflow-y-auto">
          {qr && (
            <div className="flex items-start gap-4">
              <div className="shrink-0 rounded-lg border bg-white p-2">
                <QRCodeSVG value={qr.value} size={124} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="text-sm font-medium">扫码连接</div>
                {qr.direct ? (
                  <p className="text-muted-foreground text-xs">
                    手机扫码将直接打开应用网页（本机提供，无需另外部署），地址与配对码已自动填入。
                  </p>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    未检测到局域网 IP，扫码可得连接配置
                    JSON；可在网页连接页地址框粘贴解析。
                  </p>
                )}
                <p className="text-muted-foreground bg-muted/30 rounded-md px-2.5 border border-[0.5] border-muted/30 mr-1 py-1.5 font-mono break-all text-xs">
                  {qr.value}
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <div className="text-muted-foreground text-xs">
              浏览器打开（手机与本机同一网络，扫码或输入地址即可使用）
            </div>
            {status.httpAddresses.length > 0 ? (
              <div className="flex flex-col gap-1">
                {status.httpAddresses.map((addr) => (
                  <AddressRow
                    key={addr}
                    addr={addr}
                    copied={copied}
                    onCopy={copy}
                  />
                ))}
              </div>
            ) : (
              <div className="text-muted-foreground text-xs">
                未检测到局域网 IP，可使用隧道（如 Cloudflare Tunnel）地址访问。
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="text-muted-foreground text-xs">
              WS 连接地址（供其他客户端 / 隧道使用）
            </div>
            {status.lanAddresses.length > 0 ? (
              <div className="flex flex-col gap-1">
                {status.lanAddresses.map((addr) => (
                  <AddressRow
                    key={addr}
                    addr={addr}
                    copied={copied}
                    onCopy={copy}
                  />
                ))}
              </div>
            ) : (
              <div className="text-muted-foreground text-xs">
                未检测到局域网 IP。
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="text-muted-foreground text-xs">
              配对码（每连接 5 次输错即锁定）
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-md border bg-muted/50 px-4 py-2 font-mono text-2xl tracking-[0.4em] tabular-nums">
                {status.code ?? "------"}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void refreshCode()}
              >
                <RefreshCwIcon className="size-4" />
                换一个
              </Button>
              {status.code && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy(status.code!)}
                >
                  {copied === status.code ? (
                    <CheckIcon className="size-4" />
                  ) : (
                    <CopyIcon className="size-4" />
                  )}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="text-muted-foreground text-xs">
              网页端地址（可选，配置后扫码直达网页）
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={webUrlDraft}
                onChange={(e) => setWebUrlDraft(e.target.value)}
                placeholder="https://你的网页部署地址"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveWebUrl();
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={saveWebUrl}
                disabled={webUrlDraft.trim() === webUrl}
              >
                保存
              </Button>
            </div>
          </div>

          <Alert className="border-0 bg-muted/70">
            <InfoIcon />
            <AlertDescription>{REMOTE_HINT}</AlertDescription>
          </Alert>

          {/* <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {REMOTE_HINT}
          </div> */}
        </div>
      )}

      {error && <div className="text-destructive text-sm">{error}</div>}
    </div>
  );
};

/** 地址行：等宽展示 + 一键复制 */
const AddressRow: FC<{
  addr: string;
  copied: string | null;
  onCopy: (text: string) => void;
}> = ({ addr, copied, onCopy }) => (
  <div className="bg-muted/30 flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
    <span className="truncate font-mono text-xs">{addr}</span>
    <Button
      size="sm"
      variant="ghost"
      className="h-6 shrink-0 px-2"
      onClick={() => onCopy(addr)}
    >
      {copied === addr ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
      <span className="text-xs">{copied === addr ? "已复制" : "复制"}</span>
    </Button>
  </div>
);

const EFFECT_OPTIONS: {
  value: WindowEffectName;
  label: string;
  desc: string;
}[] = [
  { value: "none", label: "不透明", desc: "默认纯色背景，性能最好" },
  {
    value: "acrylic",
    label: "高斯模糊",
    desc: "穿透模糊桌面背景（Windows Acrylic，macOS 使用系统材质）",
  },
  { value: "mica", label: "Mica", desc: "Windows 11 系统材质，随桌面壁纸色调" },
];

/** 外观配置页：窗口背景材质（穿透高斯模糊），仅桌面端可设置 */
const AppearanceSettings: FC = () => {
  const effect = useWindowEffect();
  const [busy, setBusy] = useState<WindowEffectName | null>(null);

  if (!isTauri()) {
    return (
      <div className="text-muted-foreground p-5 text-sm">
        外观设置依赖桌面端窗口能力，请在 Tauri 应用中打开设置。
      </div>
    );
  }

  const pick = (value: WindowEffectName) => {
    if (value === effect || busy) return;
    setBusy(value);
    void setWindowEffect(value).finally(() => setBusy(null));
  };

  return (
    <div className="flex flex-col gap-4  h-full p-5 overflow-hidden">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium">窗口背景</div>
        <div className="text-muted-foreground text-xs">
          启用穿透效果后界面为半透明底色，可看到桌面模糊背景；效果由系统渲染，拖动窗口可能轻微掉帧。
        </div>
      </div>
      <div className="flex flex-col gap-2 ">
        {EFFECT_OPTIONS.map((opt) => {
          const active = effect === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={busy !== null}
              onClick={() => pick(opt.value)}
              data-active={active}
              className={cn(
                "hover:bg-muted/50 flex flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-60",
                active && "border-primary ring-primary/30 ring-1",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{opt.label}</span>
                {active && <CheckIcon className="text-primary size-4" />}
              </div>
              <span className="text-muted-foreground text-xs">{opt.desc}</span>
            </button>
          );
        })}
      </div>
      <div className="text-muted-foreground text-xs shrink-0">
        高斯模糊（Acrylic）需 Windows 10 1809+，Mica 需 Windows
        11；不支持时自动回退不透明。
      </div>
    </div>
  );
};
