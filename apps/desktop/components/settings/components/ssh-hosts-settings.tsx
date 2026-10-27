"use client";

import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";
import { invoke } from "@/desktop-bridge/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { isDesktop } from "@/lib/desktop-env";
import { cn } from "@/lib/utils";
import {
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

type SshHost = {
  id: string;
  name: string;
  alias?: string;
  hostname: string;
  port?: number;
  username?: string;
  authType: "agent" | "key" | "password";
  privateKeyPath?: string;
  /** 是否已保存密码（密码本体永不回渲染层，编辑时留空 = 保持不变） */
  hasPassword?: boolean;
  enabled: boolean;
  createdAt: string;
};

type HostDraft = Partial<SshHost> & {
  authType: SshHost["authType"];
  /** 仅表单态：保存后即离开渲染层内存（main 加密落盘） */
  password?: string;
};

type TestResult = { ok: boolean; message: string; ms: number };

/** 卡片统一两层结构（与设置页其余卡片同款） */
const Card: FC<{ className?: string; children: ReactNode }> = ({ className, children }) => (
  <div className="rounded-2xl bg-muted/40 p-1.5">
    <div className={cn("rounded-xl bg-background", className)}>{children}</div>
  </div>
);

const AUTH_LABEL: Record<SshHost["authType"], string> = {
  agent: "Agent",
  key: "私钥",
  password: "密码",
};

const emptyDraft = (): HostDraft => ({
  name: "",
  alias: "",
  hostname: "",
  username: "",
  authType: "agent",
  privateKeyPath: "",
  password: "",
  enabled: true,
});

/** SSH 主机管理页：远程项目的连接前提。主机配置随 ssh CLI 语义
 *  （别名直连时端口/用户名/密钥由 ~/.ssh/config 决定），本页只维护
 *  「连接目标 + 认证方式」并保证可达。 */
export const SshHostsSettings: FC = () => {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [aliases, setAliases] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<HostDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const reload = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const hosts = (await invoke("ssh_host_list", {})) as SshHost[];
      setHosts(hosts ?? []);
      const scanned = (await invoke("ssh_host_scan_config", {})) as { alias: string }[];
      setAliases((scanned ?? []).map((s) => s.alias));
    } catch {
      // 非桌面壳
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (draft: HostDraft) => {
    const fail = (message: string) =>
      setTestResults((prev) => ({ ...prev, editor: { ok: false, message, ms: 0 } }));
    if (draft.authType === "password") {
      // ssh2 不解析 ~/.ssh/config：密码认证必须显式主机名 + 用户名
      if (draft.alias) {
        fail("密码认证不支持 ~/.ssh/config 别名：请填显式主机名");
        return;
      }
      if (!draft.hostname?.trim()) {
        fail("密码认证需要填写主机地址");
        return;
      }
      if (!draft.username?.trim()) {
        fail("密码认证需要填写用户名");
        return;
      }
      if (!draft.password) {
        const existing = hosts.find((h) => h.id === draft.id);
        if (!existing?.hasPassword) {
          fail("请填写 SSH 密码");
          return;
        }
      }
    }
    setBusyId("editor");
    try {
      const { password: _password, ...rest } = draft;
      await invoke("ssh_host_save", {
        host: {
          ...rest,
          // 密码仅在本次输入非空时下发（空 = main 保留已存密码）
          ...(draft.authType === "password" && draft.password
            ? { password: draft.password }
            : {}),
        },
      });
      setEditing(null);
      setTestResults((prev) => {
        const next = { ...prev };
        delete next["editor"];
        return next;
      });
      await reload();
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        editor: { ok: false, message: String(e), ms: 0 },
      }));
    } finally {
      setBusyId(null);
    }
  };

  const test = async (id: string) => {
    setBusyId(id);
    try {
      const result = (await invoke("ssh_host_test", { id })) as TestResult;
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, message: String(e), ms: 0 },
      }));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await invoke("ssh_host_delete", { id });
      await reload();
    } catch {
      // 列表刷新时已被删：忽略
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">SSH 主机</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          远程项目的连接目标。添加后可在「新建远程项目」中选择；密钥与 agent
          认证直接复用本机 ssh 配置，不在应用内保存秘密。
        </p>
      </div>

      <Card>
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium">主机（{hosts.length}）</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              <RefreshCwIcon className="size-3.5" />
              刷新
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setTestResults((prev) => {
                  const next = { ...prev };
                  delete next["editor"];
                  return next;
                });
                setEditing(emptyDraft());
              }}
            >
              <PlusIcon className="size-3.5" />
              添加主机
            </Button>
          </div>
        </div>
        <div className="border-t">
          {!loaded ? null : hosts.length === 0 && !editing ? (
            <div className="text-muted-foreground px-4 py-10 text-center text-sm">
              还没有 SSH 主机。点击「添加主机」，或先在 ~/.ssh/config 中配置后从别名导入。
            </div>
          ) : (
            hosts.map((host) => {
              const result = testResults[host.id];
              return (
                <div key={host.id} className="border-b px-4 py-3 last:border-b-0">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{host.name}</span>
                        <span className="bg-muted rounded px-1.5 text-xs text-muted-foreground">
                          {AUTH_LABEL[host.authType]}
                        </span>
                        {host.authType === "password" && !host.hasPassword && (
                          <span className="bg-amber-500/10 rounded px-1.5 text-xs text-amber-600">
                            未保存密码
                          </span>
                        )}
                        {!host.enabled && (
                          <span className="bg-amber-500/10 rounded px-1.5 text-xs text-amber-600">
                            已停用
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                        {host.alias ? `~/.ssh/config: ${host.alias}` : `${host.username ? `${host.username}@` : ""}${host.hostname}${host.port ? `:${host.port}` : ""}`}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setEditing(host)}
                      aria-label="编辑"
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => void remove(host.id)}
                      aria-label="删除"
                    >
                      <Trash2Icon className="text-muted-foreground size-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === host.id}
                      onClick={() => void test(host.id)}
                    >
                      {busyId === host.id ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : null}
                      测试
                    </Button>
                  </div>
                  {result && (
                    <div
                      className={cn(
                        "mt-2 rounded-md px-2 py-1 text-xs",
                        result.ok
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-destructive/10 text-destructive",
                      )}
                    >
                      {result.message}
                      {result.ok ? `（${result.ms}ms）` : ""}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </Card>

      {editing && (
        // key 按编辑对象分档：useState 只吃初始 draft，不换 key 会把上一个
        // 主机的表单值带到下一个（点编辑 B 显示 A 的内容）
        <SshHostEditor
          key={editing.id ?? "new"}
          draft={editing}
          aliases={aliases}
          busy={busyId === "editor"}
          result={testResults["editor"]}
          onCancel={() => setEditing(null)}
          onSave={(draft) => void save(draft)}
        />
      )}
    </div>
  );
};

const SshHostEditor: FC<{
  draft: HostDraft;
  aliases: string[];
  busy: boolean;
  result?: TestResult;
  onCancel: () => void;
  onSave: (draft: HostDraft) => void;
}> = ({ draft, aliases, busy, result, onCancel, onSave }) => {
  const [form, setForm] = useState<HostDraft>(draft);
  const set = <K extends keyof HostDraft>(key: K, value: HostDraft[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const pickAlias = (alias: string) => {
    // 别名直连：hostname 置空，解析交给 ~/.ssh/config
    setForm((prev) => ({ ...prev, alias, hostname: "" }));
  };

  return (
    <Card>
      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ssh-name">显示名</Label>
            <Input
              id="ssh-name"
              value={form.name ?? ""}
              placeholder="我的服务器"
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>配置别名（可选）</Label>
            <Select
              value={form.alias ?? ""}
              onValueChange={(v) =>
                !v || v === "__none__" ? set("alias", undefined) : pickAlias(v)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="直连（不走别名）" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">直连（不走别名）</SelectItem>
                {aliases.map((alias) => (
                  <SelectItem key={alias} value={alias}>
                    {alias}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {!form.alias && (
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="ssh-hostname">主机地址</Label>
              <Input
                id="ssh-hostname"
                value={form.hostname ?? ""}
                placeholder="192.168.1.10"
                onChange={(e) => set("hostname", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ssh-port">端口</Label>
              <Input
                id="ssh-port"
                type="number"
                value={form.port ?? ""}
                placeholder="22"
                onChange={(e) =>
                  set("port", e.target.value ? Number(e.target.value) : undefined)
                }
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ssh-user">用户名（可选）</Label>
            <Input
              id="ssh-user"
              value={form.username ?? ""}
              placeholder="留空用当前用户/别名配置"
              onChange={(e) => set("username", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>认证方式</Label>
            <Select
              value={form.authType ?? "agent"}
              onValueChange={(v) => set("authType", v as SshHost["authType"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">SSH Agent（默认密钥）</SelectItem>
                <SelectItem value="key">指定私钥</SelectItem>
                <SelectItem value="password">密码</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {form.authType === "key" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ssh-key">私钥路径</Label>
            <Input
              id="ssh-key"
              value={form.privateKeyPath ?? ""}
              placeholder="~/.ssh/id_ed25519"
              onChange={(e) => set("privateKeyPath", e.target.value)}
            />
          </div>
        )}

        {form.authType === "password" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ssh-password">SSH 密码</Label>
            <Input
              id="ssh-password"
              type="password"
              value={form.password ?? ""}
              placeholder={draft.hasPassword ? "已保存密码，留空保持不变" : "加密保存，不回读"}
              onChange={(e) => set("password", e.target.value)}
            />
            <span className="text-muted-foreground text-xs">
              密码认证需显式主机名与用户名（不走 ~/.ssh/config 别名）。
            </span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={form.enabled !== false}
              onCheckedChange={(v) => set("enabled", v)}
            />
            启用
          </label>
          <div className="flex items-center gap-2">
            {result && !result.ok && (
              <span className="text-destructive text-xs">{result.message}</span>
            )}
            <Button variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => onSave(form)}>
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};
