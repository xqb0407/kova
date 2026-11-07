"use client";

import { useEffect, useState } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";

/**
 * 自定义命令清单（composer `/` 菜单的「命令」分类）：事实源在 sidecar
 * （.kova/commands 工作区/全局 + 内置 /init，见 sidecar src/commands），
 * 前端只取清单渲染条目；选中后往输入框插 `/name `，展开在发送时由 sidecar
 * 完成（桌面/移动/自动化一套语义）。
 */

export type CustomCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  source: "workspace" | "global" | "builtin";
  /** 模板正文（管理页编辑器用；菜单条目忽略） */
  body?: string;
};

const EMPTY: CustomCommand[] = [];

/** 进程级缓存：菜单每次敲 `/` 都重建 items，别为每个键击打一次 RPC */
let cache: { cwd: string | null; at: number; items: CustomCommand[] } | null = null;
const inflight = new Map<string, Promise<CustomCommand[]>>();
const STALE_MS = 30_000;

export async function fetchCustomCommands(cwd: string | null): Promise<CustomCommand[]> {
  const key = cwd ?? "";
  const cached = cache;
  if (cached && cached.cwd === key && Date.now() - cached.at < STALE_MS) return cached.items;
  const inflightHit = inflight.get(key);
  if (inflightHit) return inflightHit;
  const p = piRequest<{ type: "commands"; commands: CustomCommand[] }>({
    type: "get_commands",
    ...(cwd ? { cwd } : {}),
  })
    .then((res) => {
      const items = (res.commands ?? []).filter(
        (c): c is CustomCommand =>
          typeof c?.name === "string" &&
          typeof c?.description === "string" &&
          (c.source === "workspace" || c.source === "global" || c.source === "builtin"),
      );
      cache = { cwd: key, at: Date.now(), items };
      return items;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** `/` 菜单打开期间的自定义命令条目：workspace 变化或缓存过期即重取 */
export function useCustomCommands(workspace: string | null): CustomCommand[] {
  const [items, setItems] = useState<CustomCommand[]>(() =>
    cache && cache.cwd === (workspace ?? "") ? cache.items : EMPTY,
  );
  useEffect(() => {
    let alive = true;
    void fetchCustomCommands(workspace).then((list) => {
      if (alive) setItems(list);
    });
    return () => {
      alive = false;
    };
  }, [workspace]);
  return items;
}

/** 保存（新建/覆盖/改名）：应答即刷新后的清单，同步进缓存并返回 */
export async function saveCommand(input: {
  cwd: string | null;
  scope: "workspace" | "global";
  name: string;
  description?: string;
  argumentHint?: string;
  body: string;
  replaceName?: string;
}): Promise<CustomCommand[]> {
  const cwd = input.cwd ?? undefined;
  const res = await piRequest<{ type: "commands"; commands: CustomCommand[] }>({
    type: "save_command",
    scope: input.scope,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.argumentHint !== undefined ? { argumentHint: input.argumentHint } : {}),
    body: input.body,
    ...(cwd ? { cwd } : {}),
    ...(input.replaceName ? { replaceName: input.replaceName } : {}),
  });
  const items = (res.commands ?? []).filter(
    (c): c is CustomCommand =>
      typeof c?.name === "string" &&
      typeof c?.description === "string" &&
      (c.source === "workspace" || c.source === "global" || c.source === "builtin"),
  );
  cache = { cwd: cwd ?? "", at: Date.now(), items };
  return items;
}

/** 删除：应答即刷新后的清单，同步进缓存并返回 */
export async function deleteCommand(input: {
  cwd: string | null;
  scope: "workspace" | "global";
  name: string;
}): Promise<CustomCommand[]> {
  const cwd = input.cwd ?? undefined;
  const res = await piRequest<{ type: "commands"; commands: CustomCommand[] }>({
    type: "delete_command",
    scope: input.scope,
    name: input.name,
    ...(cwd ? { cwd } : {}),
  });
  const items = (res.commands ?? []).filter(
    (c): c is CustomCommand =>
      typeof c?.name === "string" &&
      typeof c?.description === "string" &&
      (c.source === "workspace" || c.source === "global" || c.source === "builtin"),
  );
  cache = { cwd: cwd ?? "", at: Date.now(), items };
  return items;
}
