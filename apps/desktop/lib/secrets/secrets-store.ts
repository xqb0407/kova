"use client";

import { useSyncExternalStore } from "react";
import {
  piRequest,
  type PiSecretBinding,
  type PiSecretEntry,
  type PiSecretsResponse,
} from "@/lib/pi/pi-bridge";

/**
 * 密钥库（设置 → 智能体 → 密钥）：前端镜像 store。
 *
 * 事实源分两半：**值**在 Rust 侧的密文表（AES-256-GCM + OS keychain 主密钥），
 * **绑定策略**（哪个密钥授给哪些技能）在 sidecar 的 SQLite kv。
 * 所以这个镜像里**只有名字与掩码，永远没有明文**——保存时的明文只在
 * saveSecret 的那一帧里存在一次，之后再也不回传（编辑弹窗不回填值，
 * 与 provider key 同款处理）。
 *
 * 设计见 docs/secrets-env-design.md。
 */
export type SecretEntry = PiSecretEntry;
export type SecretBinding = PiSecretBinding;

export type SecretsSnapshot = {
  loading: boolean;
  error: string | null;
  entries: SecretEntry[];
  /** 总开关：关闭时任何 bash 调用都不注入（紧急刹车） */
  enabled: boolean;
  bindings: SecretBinding[];
};

const EMPTY: SecretsSnapshot = {
  loading: false,
  error: null,
  entries: [],
  enabled: true,
  bindings: [],
};

let current: SecretsSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function fromResponse(res: PiSecretsResponse): SecretsSnapshot {
  return {
    loading: false,
    error: null,
    entries: res.entries,
    enabled: res.enabled,
    bindings: res.bindings,
  };
}

export function getSecretsSnapshot(): SecretsSnapshot {
  return current;
}

export function useSecrets(): SecretsSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
}

/** 拉取清单（sidecar 不可用则记录错误并保留旧镜像） */
export async function refreshSecrets(): Promise<void> {
  current = { ...current, loading: true };
  emit();
  try {
    const res = await piRequest<PiSecretsResponse>({ type: "list_secrets" });
    current = fromResponse(res);
    emit();
  } catch (err) {
    current = {
      ...current,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    };
    emit();
  }
}

/** 保存密钥（新建时 value 必填；编辑时留空 = 只改绑定不改值）。
 *  skills 给出即整条替换该名字的技能白名单。应答是刷新后的整包，改后即见。 */
export async function saveSecret(input: {
  name: string;
  scope: "global" | "workspace";
  value?: string;
  skills?: string[];
  cwd?: string | null;
}): Promise<void> {
  const res = await piRequest<PiSecretsResponse>({
    type: "save_secret",
    name: input.name,
    scope: input.scope,
    ...(input.value ? { value: input.value } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  current = fromResponse(res);
  emit();
}

export async function deleteSecret(
  name: string,
  scope: string,
  cwd?: string | null,
): Promise<void> {
  const res = await piRequest<PiSecretsResponse>({
    type: "delete_secret",
    name,
    scope: scope.startsWith("workspace:") ? "workspace" : "global",
    ...(cwd ? { cwd } : {}),
  });
  current = fromResponse(res);
  emit();
}

/** 绑定策略 + 总开关整包覆盖 */
export async function saveSecretBindings(input: {
  enabled?: boolean;
  bindings?: SecretBinding[];
}): Promise<void> {
  const res = await piRequest<PiSecretsResponse>({
    type: "save_secret_bindings",
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.bindings ? { bindings: input.bindings } : {}),
  });
  current = fromResponse(res);
  emit();
}

/** 取某密钥的绑定（清单里没有则该密钥未授权给任何技能） */
export function bindingFor(bindings: SecretBinding[], name: string): SecretBinding | undefined {
  return bindings.find((b) => b.name === name);
}

/** 作用域展示文案 */
export function scopeLabel(scope: string): string {
  return scope.startsWith("workspace:") ? "工作区" : "全局";
}
