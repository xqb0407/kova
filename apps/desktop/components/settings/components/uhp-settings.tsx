"use client";

import { useCallback, useEffect, useState, type FC } from "react";
import { invoke } from "@/desktop-bridge/core";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
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
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import { isDesktop } from "@/lib/desktop-env";
import { useT } from "@/lib/i18n";
import {
  projectDisplayName,
  projectPrimaryPath,
  sameProjectPath,
  useProjectRegistry,
} from "@/lib/pi/pi-projects";
import { pathBasename } from "@/lib/workspace/path";

type UhpServerSettings = {
  enabled: boolean;
  port: number;
  workspaceRoot: string;
  approvalLevel: string;
  maxConcurrentTasks: number;
  responseRetentionDays: number;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
};

type UhpHarnessView = {
  id: string;
  name: string;
  base: string;
  defaultModel?: string | null;
  createdAt: number;
};

type UhpStatus = {
  running: boolean;
  port: number | null;
  url: string | null;
  conformanceClass: string;
  settings: UhpServerSettings;
  harnesses: UhpHarnessView[];
  apiKeyMasked: string | null;
};

type UhpClientServer = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasToken: boolean;
  tokenMasked: string | null;
};

const APPROVAL_LEVELS = ["ask", "workspace-write", "auto-edit", "review", "auto"] as const;

export const UhpSettings: FC = () => {
  const t = useT();
  const [status, setStatus] = useState<UhpStatus | null>(null);
  const projectRegistry = useProjectRegistry();
  const [servers, setServers] = useState<UhpClientServer[]>([]);
  const [busy, setBusy] = useState(false);
  const [portText, setPortText] = useState("");
  const [workspaceText, setWorkspaceText] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    id?: string;
    name: string;
    baseUrl: string;
    token: string;
  }>({ name: "", baseUrl: "", token: "" });
  /** 添加/编辑表单默认收起：和其他设置页一样，列表为主，点「添加」再展开 */
  const [clientFormOpen, setClientFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const next = await invoke<UhpStatus>("uhp_status");
      setStatus(next);
      setPortText(String(next.settings.port));
      setWorkspaceText(next.settings.workspaceRoot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    try {
      setServers(await invoke<UhpClientServer[]>("uhp_client_list_servers"));
    } catch {
      setServers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const next = await invoke<UhpServerSettings & { apiKey?: string }>("uhp_set_settings", patch);
      if (next.apiKey) setNewKey(next.apiKey);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      // The backend rolls `enabled` back if the listener fails (e.g. port in
      // use); reload so the switch reflects reality instead of staying on.
      await load();
    } finally {
      setBusy(false);
    }
  };

  const rotateKey = async () => {
    setBusy(true);
    try {
      const result = await invoke<{ apiKey: string }>("uhp_rotate_key");
      setNewKey(result.apiKey);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveServer = async () => {
    setBusy(true);
    try {
      await invoke("uhp_client_save_server", draft);
      setDraft({ name: "", baseUrl: "", token: "" });
      setClientFormOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const discover = async (id: string) => {
    setBusy(true);
    try {
      const result = await invoke<{ harnesses: UhpHarnessView[] }>("uhp_client_discover", { id });
      toast.success(
        t("settings.uhp.discovered", { count: result.harnesses.length }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async (id: string) => {
    setBusy(true);
    try {
      await invoke("uhp_client_delete_server", { id });
      if (draft.id === id) {
        setDraft({ name: "", baseUrl: "", token: "" });
        setClientFormOpen(false);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!isDesktop()) {
    return (
      <div className="text-muted-foreground p-8 text-sm">{t("settings.uhp.desktopOnly")}</div>
    );
  }

  const settings = status?.settings;
  // 默认工作区用项目选择器：值仍是目录（项目主目录），但选项来自项目列表，
  // 与对话输入框里的工作区选择保持一致
  const workspaceOptions: { value: string; label: string }[] = [];
  for (const project of projectRegistry) {
    const value = projectPrimaryPath(project);
    // 跳过归档/无主目录的项目；多个项目共享同一主目录时只留一行
    if (
      project.archived ||
      !value ||
      workspaceOptions.some((o) => sameProjectPath(o.value, value))
    ) {
      continue;
    }
    workspaceOptions.push({ value, label: projectDisplayName(project) });
  }
  // 已有配置可能不是注册项目（历史路径）：补一行，避免选择器显示为空
  if (
    workspaceText &&
    !workspaceOptions.some((option) => sameProjectPath(option.value, workspaceText))
  ) {
    workspaceOptions.unshift({ value: workspaceText, label: pathBasename(workspaceText) });
  }
  const selectedWorkspaceLabel =
    workspaceOptions.find((option) =>
      sameProjectPath(option.value, workspaceText),
    )?.label ?? "";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.uhp.title")}</h1>
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{t("settings.uhp.serverTitle")}</h2>
            <span className="text-muted-foreground text-[13px]">
              {status?.running
                ? `${status.url ?? ""} · ${status.conformanceClass}`
                : t("settings.uhp.stopped")}
            </span>
          </div>

          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label={t("settings.uhp.enable")} desc={t("settings.uhp.enableDesc")}>
              <Switch
                checked={settings?.enabled ?? false}
                disabled={busy}
                onCheckedChange={(checked) => void saveSettings({ enabled: checked })}
              />
            </SettingRow>

            <SettingRow label={t("settings.uhp.port")} desc={t("settings.uhp.portDesc")}>
              <Input
                value={portText}
                inputMode="numeric"
                disabled={busy}
                onChange={(event) => setPortText(event.target.value)}
                onBlur={() => {
                  const port = Number(portText);
                  if (Number.isFinite(port) && port >= 1024 && port <= 65535) {
                    void saveSettings({ port });
                  } else {
                    setPortText(String(settings?.port ?? 8788));
                  }
                }}
                className="bg-background h-8 w-24 text-right tabular-nums"
              />
            </SettingRow>

            <SettingRow
              label={t("settings.uhp.workspace")}
              desc={t("settings.uhp.workspaceDesc")}
            >
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      disabled={busy}
                      title={workspaceText || undefined}
                      className="bg-muted/60 hover:bg-muted flex h-8 w-64 items-center justify-between gap-2 rounded-full px-3 text-sm disabled:opacity-50"
                    />
                  }
                >
                  <span className="truncate">
                    {selectedWorkspaceLabel ||
                      t("settings.uhp.workspacePlaceholder")}
                  </span>
                  <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <div className="text-muted-foreground px-2 py-1.5 text-xs">
                    {t("settings.uhp.workspaceCurrent")}
                  </div>
                  <DropdownMenuSeparator />
                  {workspaceOptions.length === 0 ? (
                    <div className="text-muted-foreground px-2 py-1.5 text-[13px] leading-5">
                      {t("settings.uhp.workspaceEmpty")}
                    </div>
                  ) : (
                    workspaceOptions.map((option) => {
                      const active = sameProjectPath(option.value, workspaceText);
                      return (
                        <DropdownMenuItem
                          key={option.value}
                          title={option.value}
                          onClick={() => {
                            if (active) return;
                            setWorkspaceText(option.value);
                            void saveSettings({ workspaceRoot: option.value });
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {option.label}
                          </span>
                          {active ? (
                            <CheckIcon className="size-4 shrink-0" />
                          ) : null}
                        </DropdownMenuItem>
                      );
                    })
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </SettingRow>

            <SettingRow label={t("settings.uhp.approval")} desc={t("settings.uhp.approvalDesc")}>
              <Select
                value={settings?.approvalLevel ?? "workspace-write"}
                disabled={busy}
                onValueChange={(value) =>
                  void saveSettings({ approvalLevel: value })
                }
                items={APPROVAL_LEVELS.map((level) => ({
                  value: level,
                  label: level,
                }))}
              >
                <SelectTrigger size="sm" className="bg-background w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPROVAL_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow label={t("settings.uhp.apiKey")} desc={t("settings.uhp.apiKeyDesc")}>
              <div className="flex items-center gap-2">
                <code className="bg-background rounded-md px-2 py-2 font-mono text-sm">
                  {newKey ?? status?.apiKeyMasked ?? t("settings.uhp.noKey")}
                </code>
                <Button  disabled={busy} onClick={() => void rotateKey()}>
                  {t("settings.uhp.rotateKey")}
                </Button>
              </div>
            </SettingRow>
          </div>

          {newKey && (
            <p className="text-muted-foreground border-border/50 rounded-xl border px-3 py-2 text-[13px] leading-relaxed">
              {t("settings.uhp.keyOnce")}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.uhp.harnessesTitle")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {(status?.harnesses ?? []).length === 0 && (
              <p className="text-muted-foreground p-3 text-sm">{t("settings.uhp.noHarness")}</p>
            )}
            {(status?.harnesses ?? []).map((harness) => (
              <div key={harness.id} className="flex items-center justify-between gap-4 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{harness.name}</div>
                  <div className="text-muted-foreground mt-0.5 font-mono text-[11px]">
                    {harness.id} · {harness.base}
                  </div>
                </div>
                <div className="text-muted-foreground shrink-0 text-[12px]">
                  {harness.defaultModel ?? t("settings.uhp.noModel")}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">{t("settings.uhp.clientTitle")}</h2>
            <Button
              disabled={busy}
              onClick={() => {
                setDraft({ name: "", baseUrl: "", token: "" });
                setClientFormOpen(true);
              }}
            >
              {t("settings.uhp.addServer")}
            </Button>
          </div>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {servers.length === 0 && (
              <p className="text-muted-foreground p-3 text-sm">{t("settings.uhp.noClient")}</p>
            )}
            {servers.map((server) => (
              <div key={server.id} className="flex items-center justify-between gap-4 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{server.name}</div>
                  <div className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
                    {server.baseUrl} · {server.tokenMasked ?? t("settings.uhp.noToken")}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void discover(server.id)}
                  >
                    {t("settings.uhp.discover")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setDraft({
                        id: server.id,
                        name: server.name,
                        baseUrl: server.baseUrl,
                        token: "",
                      });
                      setClientFormOpen(true);
                    }}
                  >
                    {t("settings.uhp.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void removeServer(server.id)}
                  >
                    {t("settings.uhp.remove")}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {clientFormOpen && (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow label={t("settings.uhp.clientName")}>
                <Input
                  value={draft.name}
                  placeholder={t("settings.uhp.clientNamePlaceholder")}
                  onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
                  className="bg-background h-8 w-56"
                />
              </SettingRow>
              <SettingRow label={t("settings.uhp.clientBaseUrl")}>
                <Input
                  value={draft.baseUrl}
                  placeholder="http://127.0.0.1:8788"
                  onChange={(event) => setDraft((d) => ({ ...d, baseUrl: event.target.value }))}
                  className="bg-background h-8 w-72 font-mono text-[12px]"
                />
              </SettingRow>
              <SettingRow label={t("settings.uhp.clientToken")}>
                <Input
                  value={draft.token}
                  type="password"
                  placeholder={t("settings.uhp.clientTokenPlaceholder")}
                  onChange={(event) => setDraft((d) => ({ ...d, token: event.target.value }))}
                  className="bg-background h-8 w-72 font-mono text-[12px]"
                />
              </SettingRow>
              <div className="flex justify-end gap-2 px-3 py-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft({ name: "", baseUrl: "", token: "" });
                    setClientFormOpen(false);
                  }}
                >
                  {t("settings.uhp.cancel")}
                </Button>
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    !draft.baseUrl.trim() ||
                    (!draft.id && !draft.token.trim())
                  }
                  onClick={() => void saveServer()}
                >
                  {draft.id ? t("settings.uhp.saveServer") : t("settings.uhp.addServer")}
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
