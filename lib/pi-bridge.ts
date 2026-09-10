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

/** 已配置凭据（不含密钥本体） */
export type PiCredentialSummary = {
  providerId: string;
  type: "api_key";
};

/** 自定义 OpenAI 兼容提供商里的模型定义 */
export type PiCustomModelSpec = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

/** 自定义提供商（OpenAI 兼容 baseUrl + 模型列表） */
export type PiCustomApiKind = "openai-chat" | "openai-responses" | "anthropic-messages";

export type PiCustomProviderSummary = {
  providerId: string;
  name: string;
  baseUrl: string;
  models: PiCustomModelSpec[];
  api: PiCustomApiKind;
  hasApiKey: boolean;
  /** 明文 key，仅供编辑弹窗回填（存本地 SQLite） */
  apiKey?: string;
  /** 启用状态；停用的服务不进模型目录 */
  enabled: boolean;
};

export type PiResponse =
  | { type: "sessions"; sessions: PiSessionSummary[] }
  | { type: "session"; sessionId: string; threadId: string }
  | { type: "history"; messages: unknown[] }
  | { type: "deleted" }
  | { type: "renamed" }
  | { type: "models"; models: PiModelSummary[]; providers: PiProviderSummary[] }
  | { type: "model"; provider: string; modelId: string }
  | { type: "credential"; provider: string }
  | { type: "credentials"; credentials: PiCredentialSummary[] }
  | { type: "credential_deleted"; provider: string }
  | { type: "custom_provider"; provider: string }
  | { type: "custom_providers"; providers: PiCustomProviderSummary[] }
  | { type: "custom_provider_deleted"; provider: string }
  | { type: "custom_provider_toggled"; provider: string; enabled: boolean }
  | { type: "fetched_models"; models: string[] }
  | { type: "tested"; ok: true }
  | { type: "provider_filter"; provider: string; models: string[] | null }
  | {
      type: "mode_changed" | "planning_state";
      mode: "agent" | "plan" | "goal";
      approvalLevel?: "ask" | "auto-edit" | "auto";
      planning: "inactive" | "planning" | "awaiting_approval";
      proposal: {
        kind: "plan" | "goal";
        title: string;
        markdown: string;
        question: string;
      } | null;
    }
  | { type: "error"; errorText: string }
  | { type: "tool_confirmed"; approvalId: string };

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
