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
import { useT } from "@/lib/i18n";
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

const authItems = (t: ReturnType<typeof useT>) =>
  [
    { value: "agent", label: t("settings.sshHosts.authAgentItem") },
    { value: "key", label: t("settings.sshHosts.authKeyItem") },
    { value: "password", label: t("settings.sshHosts.authPasswordItem") },
  ] as const;

const authLabel = (t: ReturnType<typeof useT>, type: SshHost["authType"]) =>
  type === "key"
    ? t("settings.sshHosts.authPrivateKey")
    : type === "password"
      ? t("settings.sshHosts.authPassword")
      : "Agent";

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
  const t = useT();
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
        fail(t("settings.sshHosts.validationPasswordAlias"));
        return;
      }
      if (!draft.hostname?.trim()) {
        fail(t("settings.sshHosts.validationPasswordHostname"));
        return;
      }
      if (!draft.username?.trim()) {
        fail(t("settings.sshHosts.validationPasswordUsername"));
        return;
      }
      if (!draft.password) {
        const existing = hosts.find((h) => h.id === draft.id);
        if (!existing?.hasPassword) {
          fail(t("settings.sshHosts.validationPasswordRequired"));
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
        fail(t("settings.sshHosts.validationTestFailed", { message: probe.message }));
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
            <h1 className="text-2xl font-bold tracking-tight">{t("settings.sshHosts.title")}</h1>
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
              {t("settings.sshHosts.addHost")}
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
              {t("settings.sshHosts.empty")}
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
                        <span className="text-muted-foreground rounded-md bg-background px-1.5 py-0.5 text-ui leading-5">
                          {authLabel(t, host.authType)}
                        </span>
                        {host.authType === "password" && !host.hasPassword && (
                          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-ui leading-5 text-amber-600">
                            {t("settings.sshHosts.passwordNotSaved")}
                          </span>
                        )}
                        {!host.enabled && (
                          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-ui leading-5 text-amber-600">
                            {t("settings.sshHosts.disabled")}
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground mt-0.5 truncate font-mono text-ui leading-5">
                        {host.alias
                          ? `~/.ssh/config: ${host.alias}`
                          : `${host.username ? `${host.username}@` : ""}${host.hostname}${host.port ? `:${host.port}` : ""}`}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {result && (
                        <span
                          className={cn(
                            "mr-1 max-w-56 truncate text-ui leading-5",
                            result.ok ? "text-emerald-600" : "text-destructive",
                          )}
                          title={result.message}
                        >
                          {result.ok ? t("settings.sshHosts.passMs", { ms: result.ms }) : result.message}
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
                        {t("settings.sshHosts.test")}
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
                        aria-label={t("settings.sshHosts.edit")}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void remove(host.id)}
                        aria-label={t("settings.sshHosts.delete")}
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

        <div className="text-muted-foreground flex items-center gap-2 text-ui leading-5">
          <RefreshCwIcon
            className="size-3 cursor-pointer"
            onClick={() => void reload()}
          />
          {t("settings.sshHosts.footerHint")}
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
  const t = useT();
  const [form, setForm] = useState<HostDraft>(draft);
  const set = <K extends keyof HostDraft>(key: K, value: HostDraft[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // 别名回填：当前值必须出现在选项里，否则 base-ui 会落回 placeholder
  const aliasOptions = useMemo(() => {
    const names = new Set(aliases);
    if (form.alias) names.add(form.alias);
    return [
      { value: NO_ALIAS, label: t("settings.sshHosts.noAlias") },
      ...[...names].sort().map((alias) => ({ value: alias, label: alias })),
    ];
  }, [aliases, form.alias, t]);

  const pickAlias = (alias: string) => {
    // 别名直连：hostname 置空，解析交给 ~/.ssh/config
    setForm((prev) => ({ ...prev, alias, hostname: "" }));
  };

  /** 私钥文件选择：显示隐藏文件（~/.ssh 默认不可见） */
  const pickKeyFile = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const file = await open({
        title: t("settings.sshHosts.pickKeyTitle"),
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
          <Label htmlFor="ssh-name">{t("settings.sshHosts.displayName")}</Label>
          <Input
            id="ssh-name"
            value={form.name ?? ""}
            placeholder={t("settings.sshHosts.displayNamePlaceholder")}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t("settings.sshHosts.alias")}</Label>
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
            <Label htmlFor="ssh-hostname">{t("settings.sshHosts.hostname")}</Label>
            <Input
              id="ssh-hostname"
              value={form.hostname ?? ""}
              placeholder={t("settings.sshHosts.hostnamePlaceholder")}
              onChange={(e) => set("hostname", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ssh-port">{t("settings.sshHosts.port")}</Label>
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
          <Label htmlFor="ssh-user">{t("settings.sshHosts.username")}</Label>
          <Input
            id="ssh-user"
            value={form.username ?? ""}
            placeholder={t("settings.sshHosts.usernamePlaceholder")}
            onChange={(e) => set("username", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t("settings.sshHosts.auth")}</Label>
          <Select
            value={form.authType}
            items={[...authItems(t)]}
            onValueChange={(v) => v && set("authType", v as SshHost["authType"])}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {authItems(t).map((item) => (
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
          <Label htmlFor="ssh-key">{t("settings.sshHosts.keyPath")}</Label>
          <div className="flex gap-2">
            <Input
              id="ssh-key"
              className="flex-1"
              value={form.privateKeyPath ?? ""}
              placeholder={t("settings.sshHosts.keyPlaceholder")}
              onChange={(e) => set("privateKeyPath", e.target.value)}
            />
            <Button type="button" variant="outline" onClick={() => void pickKeyFile()}>
              {t("settings.sshHosts.choose")}
            </Button>
          </div>
        </div>
      )}

      {form.authType === "password" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ssh-password">{t("settings.sshHosts.sshPassword")}</Label>
          <Input
            id="ssh-password"
            type="password"
            value={form.password ?? ""}
            placeholder={draft.hasPassword ? t("settings.sshHosts.passwordPlaceholderExisting") : t("settings.sshHosts.passwordPlaceholderNew")}
            onChange={(e) => set("password", e.target.value)}
          />
          <span className="text-muted-foreground text-ui leading-5">
            {t("settings.sshHosts.passwordHint")}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={form.enabled !== false}
            onCheckedChange={(v) => set("enabled", v)}
          />
          {t("settings.sshHosts.enable")}
        </label>
        <div className="flex items-center gap-2">
          {result && !result.ok && (
            <span className="text-destructive max-w-80 truncate text-ui leading-5" title={result.message}>
              {result.message}
            </span>
          )}
          <span className="text-muted-foreground text-ui leading-5">{t("settings.sshHosts.testBeforeSave")}</span>
          <Button variant="ghost" onClick={onCancel}>
            {t("settings.sshHosts.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => onSave(form)}>
            {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {t("settings.sshHosts.save")}
          </Button>
        </div>
      </div>
    </div>
  );
};
