"use client";

/**
 * 「添加 SSH 连接」对话框（对齐 MCode 交互）：
 * 1) 扫描步骤：列出 ~/.ssh/config 中尚未添加的 Host 别名，多选后批量添加；
 *    无别名时给空态提示；左下「手动添加」切到表单。
 * 2) 手动表单：显示名称 / 主机名（可 user@host）/ 端口 / 三档认证
 *    （默认 = agent、私钥、密码）/ 用户名 / 密码 + 记住密码（加密保存）。
 *
 * 密码只在这里 → main（加密落盘）；渲染层此后永远拿不到明文（列表仅
 * hasPassword 标志，连接时由 main 在转发前注入）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import { invoke } from "@/desktop-bridge/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/custom-ui/segmented";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Loader2Icon, MonitorCheckIcon, RefreshCwIcon } from "lucide-react";
import type { SshHost } from "@/lib/workspace/remote-projects";

const authOptions = (t: ReturnType<typeof useT>) => [
  { value: "agent" as const, label: t("settings.sshConnection.authAgent") },
  { value: "key" as const, label: t("settings.sshConnection.authKey") },
  { value: "password" as const, label: t("settings.sshConnection.authPassword") },
];

type AuthType = "agent" | "key" | "password";

export const SshConnectionDialog: FC<{
  open: boolean;
  onClose: () => void;
  /** 编辑模式：预填并直接进手动表单 */
  initial?: SshHost | null;
  onSaved?: (host: SshHost) => void;
}> = ({ open, onClose, initial, onSaved }) => {
  const t = useT();
  const [step, setStep] = useState<"scan" | "manual">("scan");
  const [aliases, setAliases] = useState<string[]>([]);
  const [savedHosts, setSavedHosts] = useState<SshHost[]>([]);
  const [savedAliases, setSavedAliases] = useState<Set<string>>(new Set());
  const [aliasesLoaded, setAliasesLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 手动表单
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<AuthType>("agent");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(true);

  const refreshScan = async () => {
    setAliasesLoaded(false);
    setError(null);
    try {
      const [scanned, hosts] = await Promise.all([
        invoke("ssh_host_scan_config", {}) as Promise<{ alias: string }[]>,
        invoke("ssh_host_list", {}) as Promise<SshHost[]>,
      ]);
      const existing = new Set((hosts ?? []).map((h) => h.alias).filter(Boolean) as string[]);
      setSavedAliases(existing);
      setSavedHosts(hosts ?? []);
      setAliases((scanned ?? []).map((s) => s.alias));
      setSelected(new Set());
    } catch (e) {
      setAliases([]);
      setError(String(e));
    } finally {
      setAliasesLoaded(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setPassword("");
    setRememberPassword(true);
    if (initial) {
      setStep("manual");
      setName(initial.name ?? "");
      setHostname(initial.hostname ?? "");
      setPort(initial.port ? String(initial.port) : "");
      setUsername(initial.username ?? "");
      setAuthType(initial.authType ?? "agent");
      setPrivateKeyPath(initial.privateKeyPath ?? "");
    } else {
      setStep("scan");
      setName("");
      setHostname("");
      setPort("");
      setUsername("");
      setAuthType("agent");
      setPrivateKeyPath("");
      void refreshScan();
    }
  }, [open, initial]);

  const addable = useMemo(
    () => aliases.filter((alias) => !savedAliases.has(alias)),
    [aliases, savedAliases],
  );

  if (!open) return null;

  /** 私钥文件选择：显示隐藏文件（~/.ssh 默认不可见） */
  const pickKeyFile = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const file = await open({
        title: t("settings.sshConnection.pickKeyTitle"),
        multiple: false,
        showHiddenFiles: true,
        ...(privateKeyPath.trim() ? { defaultPath: privateKeyPath.trim() } : {}),
      });
      if (typeof file === "string" && file) setPrivateKeyPath(file);
    } catch {
      // 非桌面壳
    }
  };

  const toggle = (alias: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  };

  const addSelected = async () => {
    setBusy(true);
    setError(null);
    try {
      let last: SshHost | null = null;
      for (const alias of selected) {
        last = (await invoke("ssh_host_save", {
          host: { alias, hostname: "", name: alias, authType: "agent", enabled: true },
        })) as SshHost;
      }
      if (last) onSaved?.(last);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveManual = async () => {
    setError(null);
    // 主机名支持 user@host 写法（用户名留空时才拆分）
    let host = hostname.trim();
    let user = username.trim();
    if (host.includes("@") && !user) {
      const at = host.lastIndexOf("@");
      user = host.slice(0, at).trim();
      host = host.slice(at + 1).trim();
    }
    if (!host) {
      setError(t("settings.sshConnection.validationHostRequired"));
      return;
    }
    if (authType === "password") {
      // ssh2 不解析 ~/.ssh/config：密码认证必须显式主机名与用户名
      if (!user) {
        setError(t("settings.sshConnection.validationPasswordUserRequired"));
        return;
      }
      if (!password && !initial?.hasPassword) {
        setError(t("settings.sshConnection.validationPasswordRequired"));
        return;
      }
      if (!rememberPassword && !password) {
        setError(t("settings.sshConnection.validationPasswordUnremembered"));
        return;
      }
    }
    if (authType === "key" && !privateKeyPath.trim()) {
      setError(t("settings.sshConnection.validationKeyRequired"));
      return;
    }
    const portNum = port.trim() ? Number(port.trim()) : undefined;
    if (portNum !== undefined && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
      setError(t("settings.sshConnection.validationPortInvalid"));
      return;
    }
    setBusy(true);
    try {
      const draftHost = {
        ...(initial?.id ? { id: initial.id } : {}),
        name: name.trim() || host,
        hostname: host,
        ...(portNum ? { port: portNum } : {}),
        ...(user ? { username: user } : {}),
        authType,
        ...(authType === "key" ? { privateKeyPath: privateKeyPath.trim() } : {}),
        // 测试用本次输入的密码（未勾选记住也要先验证能连上）
        ...(authType === "password" && password ? { password } : {}),
      };
      // 保存前先测试连接：未落库配置直接探（密码主机走 sidecar ssh2 探针）
      const probe = (await invoke("ssh_host_test_draft", {
        draft: draftHost,
      })) as { ok: boolean; message: string; ms: number };
      if (!probe.ok) {
        setError(t("settings.sshConnection.validationTestFailed", { message: probe.message }));
        return;
      }
      const saved = (await invoke("ssh_host_save", {
        host: {
          ...draftHost,
          ...(authType === "password" && rememberPassword ? { password } : {}),
          enabled: true,
        },
      })) as SshHost;
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="flex h-[560px] max-h-[calc(100dvh-4rem)] flex-col gap-5 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? t("settings.sshConnection.editTitle") : t("settings.sshConnection.addTitle")}</DialogTitle>
        </DialogHeader>

        {step === "scan" ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
              {!aliasesLoaded ? (
                <div className="text-muted-foreground flex h-full min-h-[180px] items-center justify-center text-sm">
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                  {t("settings.sshConnection.scanning")}
                </div>
              ) : addable.length === 0 && savedHosts.length === 0 ? (
                <div className="text-muted-foreground flex h-full min-h-[180px] flex-col items-center justify-center gap-3 px-6 text-center text-sm">
                  <MonitorCheckIcon className="text-muted-foreground/50 size-9" />
                  {t("settings.sshConnection.noHosts")}
                </div>
              ) : (
                <div className="flex flex-col p-1">
                  {/* 已配置的主机（应用内已添加）：给个可见的去处，避免误以为丢了配置 */}
                  {savedHosts.map((host) => (
                    <div
                      key={host.id}
                      className="text-muted-foreground flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm"
                    >
                      <Checkbox checked disabled aria-label={host.name} />
                      <span className="truncate">{host.name}</span>
                      {host.alias && (
                        <span className="truncate font-mono text-[13px] leading-5">{host.alias}</span>
                      )}
                      <span className="ml-auto rounded-md bg-background px-1.5 py-0.5 text-[13px] leading-5">
                        {t("settings.sshConnection.added")}
                      </span>
                    </div>
                  ))}
                  {addable.map((alias) => (
                    <label
                      key={alias}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm"
                    >
                      <Checkbox
                        checked={selected.has(alias)}
                        onCheckedChange={() => toggle(alias)}
                      />
                      <span className="truncate font-mono">{alias}</span>
                    </label>
                  ))}
                  {addable.length === 0 && savedHosts.length > 0 ? (
                    <div className="text-muted-foreground px-3 py-2 text-[13px] leading-5">
                      {t("settings.sshConnection.noNewAliases")}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            {error && <div className="text-destructive text-[13px] leading-5">{error}</div>}
            <DialogFooter className="items-center sm:justify-between">
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => {
                  setStep("manual");
                  setError(null);
                }}
              >
                <RefreshCwIcon className="size-4" />
                {t("settings.sshConnection.manualAdd")}
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  {t("settings.sshConnection.cancel")}
                </Button>
                <Button
                  onClick={() => void addSelected()}
                  disabled={busy || selected.size === 0}
                >
                  {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                  {t("settings.sshConnection.add")}
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ssh-conn-name">{t("settings.sshConnection.displayName")}</Label>
                <Input
                  id="ssh-conn-name"
                  value={name}
                  placeholder={t("settings.sshConnection.displayNamePlaceholder")}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ssh-conn-host">{t("settings.sshConnection.hostname")}</Label>
                <Input
                  id="ssh-conn-host"
                  value={hostname}
                  placeholder={t("settings.sshConnection.hostnamePlaceholder")}
                  className="font-mono"
                  onChange={(e) => setHostname(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ssh-conn-port">{t("settings.sshConnection.port")}</Label>
                <Input
                  id="ssh-conn-port"
                  type="number"
                  value={port}
                  placeholder="22"
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>

              <Segmented<AuthType>
                value={authType}
                stretch
                options={authOptions(t)}
                onChange={setAuthType}
              />

              {(authType === "key" || authType === "password") && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ssh-conn-user">{t("settings.sshConnection.remoteUser")}</Label>
                  <Input
                    id="ssh-conn-user"
                    value={username}
                    placeholder={t("settings.sshConnection.remoteUserPlaceholder")}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
              )}

              {authType === "key" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ssh-conn-key">{t("settings.sshConnection.keyPath")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="ssh-conn-key"
                      value={privateKeyPath}
                      placeholder={t("settings.sshConnection.keyPlaceholder")}
                      className="flex-1 font-mono"
                      onChange={(e) => setPrivateKeyPath(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void pickKeyFile()}
                    >
                      {t("settings.sshConnection.choose")}
                    </Button>
                  </div>
                </div>
              )}

              {authType === "password" && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ssh-conn-password">{t("settings.sshConnection.sshPassword")}</Label>
                    <Input
                      id="ssh-conn-password"
                      type="password"
                      value={password}
                      placeholder={initial?.hasPassword ? t("settings.sshConnection.passwordPlaceholderExisting") : ""}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-2 text-sm",
                      password.length > 0 && "text-foreground",
                    )}
                  >
                    <Checkbox
                      checked={rememberPassword}
                      onCheckedChange={(v) => setRememberPassword(v === true)}
                    />
                    {t("settings.sshConnection.rememberPassword")}
                  </label>
                </>
              )}

              {error && <div className="text-destructive text-[13px] leading-5">{error}</div>}
            </div>

            <DialogFooter className="items-center">
              <span className="text-muted-foreground mr-auto text-[13px] leading-5">{t("settings.sshConnection.testBeforeSave")}</span>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {t("settings.sshConnection.cancel")}
              </Button>
              <Button onClick={() => void saveManual()} disabled={busy}>
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                {t("settings.sshConnection.save")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
