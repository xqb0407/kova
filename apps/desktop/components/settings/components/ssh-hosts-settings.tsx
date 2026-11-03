"use client";

/**
 * SSH 主机管理页：远程项目的连接前提。
 * 版式对齐钩子/MCP 等设置页：页头（标题 + 右上操作）、编辑器卡片
 * （bg-muted/30 + 边框）、列表卡片（bg-muted/50 容器 + muted 行）。
 * 认证三档：默认（agent/默认密钥）、私钥、密码（加密保存，编辑留空不变）。
 */
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
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

const AUTH_LABEL: Record<SshHost["authType"], string> = {
  agent: "Agent",
  key: "私钥",
  password: "密码",
};

const AUTH_ITEMS = [
  { value: "agent", label: "SSH Agent（默认密钥）" },
  { value: "key", label: "指定私钥" },
  { value: "password", label: "密码" },
] as const;

const NO_ALIAS = "__none__";

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
      setHosts(((await invoke("ssh_host_list", {})) as SshHost[]) ?? []);
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
        fail("密码认证不支持 ~/.ssh/config 别名：请改填显式主机名");
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
      // 保存前先测试连接：未落库配置直接探（密码主机走 sidecar ssh2 探针）
      const probe = (await invoke("ssh_host_test_draft", {
        draft,
      })) as TestResult;
      if (!probe.ok) {
        fail(`连接测试未通过，未保存：${probe.message}`);
        return;
      }
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
      fail(String(e));
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
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SSH 主机</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              远程项目的连接目标。支持默认认证（agent/默认密钥）、私钥与密码认证；
              密码加密保存且不回读。
            </p>
          </div>
          {!editing && (
            <Button
              onClick={() => {
                setTestResults((prev) => {
                  const next = { ...prev };
                  delete next["editor"];
                  return next;
                });
                setEditing(emptyDraft());
              }}
            >
              <PlusIcon className="size-4" />
              添加主机
            </Button>
          )}
        </div>

        {editing && (
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

        <section>
          {!loaded ? null : hosts.length === 0 ? (
            <div className="text-muted-foreground rounded-2xl border border-dashed p-10 text-center text-sm">
              还没有 SSH 主机。点「添加主机」，或先在 ~/.ssh/config 中配置 Host 后从别名导入。
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {hosts.map((host) => {
                const result = testResults[host.id];
                return (
                  <div
                    key={host.id}
                    className="flex items-center justify-between gap-3 rounded-xl px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{host.name}</span>
                        <span className="text-muted-foreground rounded-md bg-background px-1.5 py-0.5 text-[13px] leading-5">
                          {AUTH_LABEL[host.authType]}
                        </span>
                        {host.authType === "password" && !host.hasPassword && (
                          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[13px] leading-5 text-amber-600">
                            未保存密码
                          </span>
                        )}
                        {!host.enabled && (
                          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[13px] leading-5 text-amber-600">
                            已停用
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground mt-0.5 truncate font-mono text-[13px] leading-5">
                        {host.alias
                          ? `~/.ssh/config: ${host.alias}`
                          : `${host.username ? `${host.username}@` : ""}${host.hostname}${host.port ? `:${host.port}` : ""}`}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {result && (
                        <span
                          className={cn(
                            "mr-1 max-w-56 truncate text-[13px] leading-5",
                            result.ok ? "text-emerald-600" : "text-destructive",
                          )}
                          title={result.message}
                        >
                          {result.ok ? `通过（${result.ms}ms）` : result.message}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === host.id}
                        onClick={() => void test(host.id)}
                      >
                        {busyId === host.id ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : null}
                        测试
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setTestResults((prev) => {
                            const next = { ...prev };
                            delete next["editor"];
                            return next;
                          });
                          setEditing(host);
                        }}
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
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="text-muted-foreground flex items-center gap-2 text-[13px] leading-5">
          <RefreshCwIcon
            className="size-3 cursor-pointer"
            onClick={() => void reload()}
          />
          主机列表与 ~/.ssh/config 别名在打开本页时扫描
        </div>
      </div>
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

  // 别名回填：当前值必须出现在选项里，否则 base-ui 会落回 placeholder
  const aliasOptions = useMemo(() => {
    const names = new Set(aliases);
    if (form.alias) names.add(form.alias);
    return [
      { value: NO_ALIAS, label: "直连（不走别名）" },
      ...[...names].sort().map((alias) => ({ value: alias, label: alias })),
    ];
  }, [aliases, form.alias]);

  const pickAlias = (alias: string) => {
    // 别名直连：hostname 置空，解析交给 ~/.ssh/config
    setForm((prev) => ({ ...prev, alias, hostname: "" }));
  };

  /** 私钥文件选择：显示隐藏文件（~/.ssh 默认不可见） */
  const pickKeyFile = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const file = await open({
        title: "选择私钥文件",
        multiple: false,
        showHiddenFiles: true,
        ...(form.privateKeyPath?.trim() ? { defaultPath: form.privateKeyPath.trim() } : {}),
      });
      if (typeof file === "string" && file) set("privateKeyPath", file);
    } catch {
      // 非桌面壳
    }
  };

  return (
    <div className="bg-muted/30 flex flex-col gap-5 rounded-2xl border p-5">
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
            value={form.alias ? form.alias : NO_ALIAS}
            items={aliasOptions}
            onValueChange={(v) =>
              !v || v === NO_ALIAS
                ? setForm((prev) => ({ ...prev, alias: undefined }))
                : pickAlias(v)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {aliasOptions.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
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
              placeholder="192.168.1.10 或 host.com"
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
              onChange={(e) => set("port", e.target.value ? Number(e.target.value) : undefined)}
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
            value={form.authType}
            items={[...AUTH_ITEMS]}
            onValueChange={(v) => v && set("authType", v as SshHost["authType"])}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTH_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {form.authType === "key" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ssh-key">私钥路径</Label>
          <div className="flex gap-2">
            <Input
              id="ssh-key"
              className="flex-1"
              value={form.privateKeyPath ?? ""}
              placeholder="~/.ssh/id_ed25519"
              onChange={(e) => set("privateKeyPath", e.target.value)}
            />
            <Button type="button" variant="outline" onClick={() => void pickKeyFile()}>
              选择…
            </Button>
          </div>
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
          <span className="text-muted-foreground text-[13px] leading-5">
            密码认证需显式主机地址与用户名（不走 ~/.ssh/config 别名）。
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
            <span className="text-destructive max-w-80 truncate text-[13px] leading-5" title={result.message}>
              {result.message}
            </span>
          )}
          <span className="text-muted-foreground text-[13px] leading-5">保存前会先测试连接</span>
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
  );
};
