"use client";

/**
 * SSH 主机管理页：远程项目的连接前提。
 * 列表 + 连接测试/删除；添加/编辑走 SshConnectionDialog（扫描 ~/.ssh/config
 * 或手动表单，三档认证含密码）。密码不可回读——列表只显示 hasPassword 标志。
 */
import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";
import { invoke } from "@/desktop-bridge/core";
import { Button } from "@/components/ui/button";
import { isDesktop } from "@/lib/desktop-env";
import { cn } from "@/lib/utils";
import {
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import type { SshHost } from "@/lib/workspace/remote-projects";
import { SshConnectionDialog } from "./ssh-connection-dialog";

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

export const SshHostsSettings: FC = () => {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<SshHost | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const reload = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      setHosts(((await invoke("ssh_host_list", {})) as SshHost[]) ?? []);
    } catch {
      // 非桌面壳
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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
          远程项目的连接目标。支持默认认证（agent/默认密钥）、私钥与密码认证；
          密码加密保存且不回读。添加后可在「新建远程项目」中选择。
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
                setEditingHost(null);
                setDialogOpen(true);
              }}
            >
              <PlusIcon className="size-3.5" />
              添加主机
            </Button>
          </div>
        </div>
        <div className="border-t">
          {!loaded ? null : hosts.length === 0 ? (
            <div className="text-muted-foreground px-4 py-10 text-center text-sm">
              还没有 SSH 主机。点击「添加主机」，或从 ~/.ssh/config 的别名导入。
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
                        {host.alias
                          ? `~/.ssh/config: ${host.alias}`
                          : `${host.username ? `${host.username}@` : ""}${host.hostname}${host.port ? `:${host.port}` : ""}`}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditingHost(host);
                        setDialogOpen(true);
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

      <SshConnectionDialog
        open={dialogOpen}
        initial={editingHost}
        onClose={() => {
          setDialogOpen(false);
          setEditingHost(null);
        }}
        onSaved={() => void reload()}
      />
    </div>
  );
};
