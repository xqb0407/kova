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
import { Loader2Icon, MonitorCheckIcon, RefreshCwIcon } from "lucide-react";
import type { SshHost } from "@/lib/workspace/remote-projects";

const AUTH_OPTIONS = [
  { value: "agent" as const, label: "默认认证" },
  { value: "key" as const, label: "私钥认证" },
  { value: "password" as const, label: "密码认证" },
];

type AuthType = "agent" | "key" | "password";

export const SshConnectionDialog: FC<{
  open: boolean;
  onClose: () => void;
  /** 编辑模式：预填并直接进手动表单 */
  initial?: SshHost | null;
  onSaved?: (host: SshHost) => void;
}> = ({ open, onClose, initial, onSaved }) => {
  const [step, setStep] = useState<"scan" | "manual">("scan");
  const [aliases, setAliases] = useState<string[]>([]);
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
        title: "选择私钥文件",
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
      setError("请填写主机名");
      return;
    }
    if (authType === "password") {
      // ssh2 不解析 ~/.ssh/config：密码认证必须显式主机名与用户名
      if (!user) {
        setError("密码认证需要填写远程用户名");
        return;
      }
      if (!password && !initial?.hasPassword) {
        setError("请填写 SSH 密码（或勾选记住密码后填写）");
        return;
      }
      if (!rememberPassword && !password) {
        setError("未勾选记住密码时需要输入本次密码");
        return;
      }
    }
    if (authType === "key" && !privateKeyPath.trim()) {
      setError("私钥认证需要填写私钥路径");
      return;
    }
    const portNum = port.trim() ? Number(port.trim()) : undefined;
    if (portNum !== undefined && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
      setError("端口必须是 1-65535 的整数");
      return;
    }
    setBusy(true);
    try {
      const saved = (await invoke("ssh_host_save", {
        host: {
          ...(initial?.id ? { id: initial.id } : {}),
          name: name.trim() || host,
          hostname: host,
          ...(portNum ? { port: portNum } : {}),
          ...(user ? { username: user } : {}),
          authType,
          ...(authType === "key" ? { privateKeyPath: privateKeyPath.trim() } : {}),
          // 空串 = 保留已存密码（main 侧语义）；勾选记住才落盘
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
          <DialogTitle>{initial ? "编辑 SSH 连接" : "添加 SSH 连接"}</DialogTitle>
        </DialogHeader>

        {step === "scan" ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
              {!aliasesLoaded ? (
                <div className="text-muted-foreground flex h-full min-h-[180px] items-center justify-center text-sm">
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                  正在扫描 ~/.ssh/config…
                </div>
              ) : addable.length === 0 ? (
                <div className="text-muted-foreground flex h-full min-h-[180px] flex-col items-center justify-center gap-3 px-6 text-center text-sm">
                  <MonitorCheckIcon className="text-muted-foreground/50 size-9" />
                  没有发现可添加的主机，请先在 ~/.ssh/config 中配置具体的 Host。
                </div>
              ) : (
                <div className="flex flex-col p-1">
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
                </div>
              )}
            </div>
            {error && <div className="text-destructive text-xs">{error}</div>}
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
                手动添加
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  取消
                </Button>
                <Button
                  onClick={() => void addSelected()}
                  disabled={busy || selected.size === 0}
                >
                  {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                  添加
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ssh-conn-name">显示名称</Label>
                <Input
                  id="ssh-conn-name"
                  value={name}
                  placeholder="例如 开发机"
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ssh-conn-host">主机名</Label>
                <Input
                  id="ssh-conn-host"
                  value={hostname}
                  placeholder="host.com 或 user@host.com"
                  className="font-mono"
                  onChange={(e) => setHostname(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ssh-conn-port">SSH 端口（可选）</Label>
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
                options={AUTH_OPTIONS}
                onChange={setAuthType}
              />

              {(authType === "key" || authType === "password") && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ssh-conn-user">远程用户名</Label>
                  <Input
                    id="ssh-conn-user"
                    value={username}
                    placeholder="远程服务器上的账号，例如 ubuntu"
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
              )}

              {authType === "key" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ssh-conn-key">私钥路径</Label>
                  <div className="flex gap-2">
                    <Input
                      id="ssh-conn-key"
                      value={privateKeyPath}
                      placeholder="~/.ssh/id_ed25519"
                      className="flex-1 font-mono"
                      onChange={(e) => setPrivateKeyPath(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void pickKeyFile()}
                    >
                      选择…
                    </Button>
                  </div>
                </div>
              )}

              {authType === "password" && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ssh-conn-password">SSH 密码</Label>
                    <Input
                      id="ssh-conn-password"
                      type="password"
                      value={password}
                      placeholder={initial?.hasPassword ? "已保存密码，留空保持不变" : ""}
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
                    记住密码（加密保存）
                  </label>
                </>
              )}

              {error && <div className="text-destructive text-xs">{error}</div>}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button onClick={() => void saveManual()} disabled={busy}>
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                保存
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
