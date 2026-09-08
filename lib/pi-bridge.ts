"use client";

import { invoke } from "@tauri-apps/api/core";

/**
 * pi-agent 管理类请求-响应桥。
 * Rust 侧 pi_request 会给 payload 注入唯一 id，并直接把子进程的响应行返回。
 */

export type PiSessionSummary = {
  sessionId: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: string;
  cwd: string;
};

/** pi 可用模型（ModelRegistry.getAll + 凭据状态） */
export type PiModelSummary = {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  authed: boolean;
};

export type PiProviderSummary = {
  id: string;
  name: string;
  authed: boolean;
};

/** pi 可用技能（loadSkills 发现的 SKILL.md） */
export type PiSkillSummary = {
  name: string;
  description: string;
  filePath: string;
  scope: "user" | "project" | "temporary";
};

type PiResponse =
  | { type: "sessions"; sessions: PiSessionSummary[] }
  | { type: "session"; sessionId: string; threadId: string }
  | { type: "history"; messages: unknown[] }
  | { type: "deleted" }
  | { type: "renamed" }
  | { type: "models"; models: PiModelSummary[]; providers: PiProviderSummary[] }
  | { type: "model"; provider: string; modelId: string }
  | { type: "skills"; skills: PiSkillSummary[] }
  | { type: "error"; errorText: string };

export async function piRequest<T extends PiResponse>(
  payload: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<T> {
  const invokePromise = invoke<string>("pi_request", { payload }).then(
    (line) => JSON.parse(line) as PiResponse,
  );

  const response = await Promise.race([
    invokePromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("pi-agent request timed out")), timeoutMs),
    ),
  ]);

  if (response.type === "error") {
    throw new Error(response.errorText);
  }
  return response as T;
}
