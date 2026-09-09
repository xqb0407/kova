"use client";

import { getPiChannel } from "@/lib/pi-channel";

/**
 * pi-agent 管理类请求-响应桥。
 * 具体传输由 PiChannel 决定（桌面 = Tauri invoke；远程网页 = WebSocket，见 pi-channel.ts），
 * 桥只负责类型定义与错误归一。
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

export type PiResponse =
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
  const response = await getPiChannel().request(payload, timeoutMs);

  if (response.type === "error") {
    throw new Error(response.errorText);
  }
  return response as T;
}
