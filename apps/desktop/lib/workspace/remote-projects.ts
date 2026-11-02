"use client";

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";

/**
 * 远程项目（SSH 执行）：项目清单 + 工作区匹配 + 连接目标解析。
 *
 * 存储：kv `remote.projects`（JSON 数组，经通用 kv_set/kv_get 命令）。
 * 项目只存 hostId 引用，连接细节（host/port/username/keyPath）在
 * `ssh.hosts`（Electron main 维护，见 apps/electron/main/ssh.ts）；
 * 两者都不含秘密明文（v1 仅密钥/agent 认证，CLI 直读本机 ssh 配置）。
 *
 * 绑定语义：新建会话时按「当前 workspace 路径 == remotePath」反查远程项目，
 * 由 pi-client-base 的 createThread 附加 remote 字段——不依赖临时选中态，
 * 最近列表/会话同步怎么进来都能正确绑定。
 */

export type RemoteProject = {
  id: string;
  /** 显示名（新建对话框填） */
  name: string;
  /** SSH 主机引用（ssh.hosts 的 id） */
  hostId: string;
  /** 远端源文件夹（会话 cwd，亦是写入根） */
  remotePath: string;
  createdAt: string;
};

/**
 * new_session/prompt 的 remote 载荷（无秘密字段）。
 * hostId 供 Electron main 在转发前解密注入密码（密码永不进渲染层）；
 * sidecar 清洗时丢弃 hostId，只消费连接字段。
 */
export type RemoteTargetPayload = {
  host: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  /** 主机引用：main 据此注入密码（仅 new_session/prompt 载荷） */
  hostId?: string;
};

export type SshHost = {
  id: string;
  name: string;
  alias?: string;
  hostname: string;
  port?: number;
  username?: string;
  authType: "agent" | "key" | "password";
  privateKeyPath?: string;
  /** 是否已保存密码（密码本体永不回渲染层） */
  hasPassword?: boolean;
  enabled: boolean;
  createdAt: string;
};

const PROJECTS_KEY = "remote.projects";
/** 曾登记为远程项目的路径（会话存活期内永久记忆）：项目被删除后，
 *  旧会话的 panel 也不能回落到本地同名目录（如 /home）去读写 */
const everRemotePaths = new Set<string>();

function markRemotePath(path: string): void {
  everRemotePaths.add(path.replace(/\/+$/, ""));
}

export function isKnownRemotePath(path: string | null | undefined): boolean {
  if (!path) return false;
  return everRemotePaths.has(path.replace(/\/+$/, ""));
}

const listeners = new Set<() => void>();
let cache: RemoteProject[] | null = null;
let loaded = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function listRemoteProjects(): Promise<RemoteProject[]> {
  // 非桌面壳没有 kv：标记 loaded 终态，避免 useRemoteProjects 每次渲染都空转重试
  if (!isDesktop()) {
    cache = [];
    loaded = true;
    return [];
  }
  try {
    const raw = await invoke<string | null>("kv_get", { key: PROJECTS_KEY });
    if (typeof raw === "string" && raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cache = parsed.filter(
          (p): p is RemoteProject =>
            p && typeof p === "object" && typeof p.id === "string" && typeof p.remotePath === "string",
        );
        for (const project of cache) markRemotePath(project.remotePath);
      }
    } else {
      cache = [];
    }
  } catch {
    // kv 不可用：保持上次缓存
  }
  loaded = true;
  return cache ?? [];
}

/** 确保清单已加载（首次调用读一次 kv，之后纯内存；面板 fs 高频调用用） */
export async function ensureRemoteProjectsLoaded(): Promise<void> {
  await loadRemoteProjectsOnce();
}

async function persist(projects: RemoteProject[]): Promise<void> {
  for (const project of projects) markRemotePath(project.remotePath);
  cache = projects;
  loaded = true;
  version += 1;
  emit();
  if (isDesktop()) {
    await invoke("kv_set", { key: PROJECTS_KEY, value: JSON.stringify(projects) }).catch(() => {});
  }
}

export async function saveRemoteProject(
  input: { id?: string; name: string; hostId: string; remotePath: string },
): Promise<RemoteProject> {
  const projects = await listRemoteProjects();
  const id = input.id || `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const existing = projects.find((p) => p.id === id);
  const next: RemoteProject = {
    id,
    name: input.name.trim() || input.remotePath,
    hostId: input.hostId,
    remotePath: input.remotePath.trim(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  const idx = projects.findIndex((p) => p.id === id);
  if (idx >= 0) projects[idx] = next;
  else projects.push(next);
  await persist(projects);
  return next;
}

export async function deleteRemoteProject(id: string): Promise<void> {
  const projects = await listRemoteProjects();
  await persist(projects.filter((p) => p.id !== id));
}

/** 按 workspace 路径反查远程项目（远程路径即 remotePath，全等匹配） */
export function findRemoteProjectByPath(path: string | null | undefined): RemoteProject | null {
  if (!path || !cache) return null;
  const normalized = path.replace(/\/+$/, "");
  return (
    cache.find((p) => p.remotePath.replace(/\/+$/, "") === normalized) ?? null
  );
}

/**
 * 解析项目的 SSH 连接目标（new_session.remote 载荷）。
 * 主机已被删除 / 停用时返回 null（会话按本地语义失败，错误自然暴露）。
 */
export async function resolveRemoteTargetPayload(
  project: RemoteProject,
): Promise<RemoteTargetPayload | null> {
  if (!isDesktop()) return null;
  try {
    const hosts = (await invoke("ssh_host_list", {})) as SshHost[];
    const host = (hosts ?? []).find((h) => h.id === project.hostId && h.enabled);
    if (!host) return null;
    // 密码认证走 ssh2（不解析 ~/.ssh/config）：别名不可作为目标，必须显式主机名
    if (host.authType === "password") {
      if (!host.hostname?.trim()) return null;
      const target: RemoteTargetPayload = { host: host.hostname.trim(), hostId: host.id };
      if (host.port && host.port !== 22) target.port = host.port;
      if (host.username?.trim()) target.username = host.username.trim();
      return target;
    }
    // 别名直连：host 存别名，解析交给 ~/.ssh/config（port/username/keyPath 随配置）
    if (host.alias) return { host: host.alias, hostId: host.id };
    const target: RemoteTargetPayload = { host: host.hostname, hostId: host.id };
    if (host.port && host.port !== 22) target.port = host.port;
    if (host.username?.trim()) target.username = host.username.trim();
    if (host.authType === "key" && host.privateKeyPath?.trim()) {
      target.privateKeyPath = host.privateKeyPath.trim();
    }
    return target;
  } catch {
    return null;
  }
}

/* ---------------- 同步判定（UI 门控用） ---------------- */

/** 订阅快照：清单版本号（persist / 刷新都会 +1），useSyncExternalStore 用 */
let version = 0;
function getVersion(): number {
  return version;
}

/**
 * 在途加载去重：模块加载、多个 hook 挂载、fs 门控并发调用时只发一次 kv_get。
 * 完成后统一递增版本号再广播——只 emit 不递增会让 useSyncExternalStore
 * 读到同一个快照而不重渲染（门控/清单 UI 会停在旧值）。
 */
let loadPromise: Promise<void> | null = null;
function loadRemoteProjectsOnce(): Promise<void> {
  if (loaded) return Promise.resolve();
  loadPromise ??= listRemoteProjects()
    .catch(() => cache ?? [])
    .then(() => {
      version += 1;
      emit();
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

/** 模块加载即恢复（SSR 端 no-op） */
void loadRemoteProjectsOnce();

/**
 * React 订阅：远程项目清单（对话框主机下拉、列表页、门控判定共用）。
 * 首次挂载时若尚未加载会触发一次异步刷新（effect 内，不在渲染期派发）。
 */
export function useRemoteProjects(): { projects: RemoteProject[]; loaded: boolean } {
  useSyncExternalStore(subscribe, getVersion, () => 0);
  useEffect(() => {
    void loadRemoteProjectsOnce();
  }, []);
  return { projects: cache ?? [], loaded };
}

/**
 * 当前路径是否远程项目工作区（同步判定，UI 门控：隐藏 Git 面板/文件树/
 * 检查点卡等本地面板）。清单尚未加载完成时按 false 处理（首帧短暂按本地渲染）。
 */
export function isRemoteWorkspace(path: string | null | undefined): boolean {
  if (!path) return false;
  return findRemoteProjectByPath(path) !== null;
}

/**
 * React 版远程工作区判定（文件树等面板门控用）。
 * 清单是异步载入的，首帧直接调 isRemoteWorkspace 会把远程路径当本地；
 * 这里订阅 useRemoteProjects，载入/增删项目后重渲染门控。
 * 与 fs.ts 的 remoteProjectFor 同口径：当前清单命中，或本进程曾登记过的
 * 远程路径（项目已删除的旧会话也不回落到本地）。
 */
export function useIsRemoteWorkspace(path: string | null | undefined): boolean {
  useRemoteProjects();
  return isRemoteWorkspace(path) || isKnownRemotePath(path);
}
