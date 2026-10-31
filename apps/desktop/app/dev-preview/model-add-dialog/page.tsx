"use client";

/**
 * 【校对页】「添加 / 编辑模型」弹窗的新版样式：/dev-preview/model-add-dialog
 *
 * 跑法：cd apps/desktop && bun run dev → http://localhost:3000/dev-preview/model-add-dialog
 *
 * 提供商列表走 sidecar 的 list_models，浏览器里拿不到，这里用夹具灌一份——id/名字
 * 都照 pi-ai 内置 provider 的真实口径（minimax-cn → "MiniMax CN"），这样
 * ProviderIcon 能命中真实品牌图标，看到的就是正式环境的样子。十六条够把列表滚起来。
 *
 * 「自动获取」同样接不到端点：夹具延迟 600ms 后返回 39 条模型 id，看加载态与
 * 二级弹窗在真实规模下的密度与滚动。编辑态入口用来校对回填（掩码提示、模型行、
 * 内置启用集），保存不落盘：结果 JSON 直接显示在页面上。
 */

import { useState } from "react";
import {
  CUSTOM_PROVIDER_ID,
  ModelAddDialog,
  type ModelAddInitial,
  type ModelAddProviderOption,
  type ModelAddSaveInput,
} from "@/components/settings/components/model-add-dialog";

const PROVIDERS: ModelAddProviderOption[] = [
  { id: "minimax-cn", name: "MiniMax CN" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "zai", name: "Z.AI" },
  { id: "moonshotai-cn", name: "Moonshot AI CN" },
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google" },
  { id: "xai", name: "xAI" },
  { id: "mistral", name: "Mistral" },
  { id: "groq", name: "Groq" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "kimi-coding", name: "Kimi For Coding" },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan CN" },
  { id: "github-copilot", name: "GitHub Copilot" },
  { id: "amazon-bedrock", name: "Amazon Bedrock" },
  { id: "cerebras", name: "Cerebras" },
];

const FETCHED_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-pro",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "kimi-k3",
  "kimi-k2.6",
  "kimi-k2.5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-r2",
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen3-coder",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "gpt-5.6",
  "gpt-5.6-mini",
  "gpt-5.6-nano",
  "o5",
  "o5-mini",
  "grok-4.5",
  "grok-4.5-fast",
  "llama-5-70b",
  "llama-5-405b",
  "mistral-large-3",
  "mistral-medium-3",
  "codestral-2",
  "minimax-m3",
  "minimax-m3-lite",
  "doubao-seed-2.0",
  "hunyuan-t2",
  "step-4",
  "yi-lightning-2",
  "sensenova-6.7",
  "mimo-v3",
  "longcat-flash-2",
];

/** 内置编辑态夹具：OpenAI 目录全集（前两个带生效值 → 行内可改属性）+ 已启用子集 */
const OPENAI_CATALOG = [
  {
    id: "gpt-5.6",
    name: "GPT-5.6",
    contextWindow: 400000,
    spec: {
      id: "gpt-5.6",
      name: "GPT-5.6",
      reasoning: true,
      contextWindow: 400000,
      maxTokens: 128000,
      input: ["text", "image"],
      cost: { input: 1.25, output: 10, cacheRead: 0.1, cacheWrite: 0 },
    },
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    thinkingOff: "none",
    t2i: false,
  },
  {
    id: "gpt-5.6-mini",
    name: "GPT-5.6 mini",
    contextWindow: 400000,
    spec: {
      id: "gpt-5.6-mini",
      contextWindow: 400000,
      maxTokens: 65536,
      input: ["text"],
      cost: { input: 0.25, output: 2, cacheRead: 0, cacheWrite: 0 },
    },
  },
  { id: "gpt-5.6-nano", contextWindow: 400000 },
  { id: "o5", contextWindow: 256000 },
  { id: "o5-mini", contextWindow: 256000 },
];

const EDIT_CUSTOM: ModelAddInitial = {
  providerId: CUSTOM_PROVIDER_ID,
  apiKeyMasked: "sk-****abcd",
  custom: {
    name: "我的网关",
    api: "openai-chat",
    baseUrl: "http://118.25.178.24:7863/v1",
    headers: [{ name: "X-Title", value: "kova" }],
    models: [
      {
        id: "glm-5.2",
        spec: {
          id: "glm-5.2",
          name: "GLM-5.2",
          reasoning: true,
          contextWindow: 256000,
          maxTokens: 64000,
          input: ["text", "image"],
          cost: { input: 0.6, output: 2.2, cacheRead: 0.1, cacheWrite: 0 },
        },
        thinkingLevels: ["minimal", "low", "medium", "high"],
        thinkingOff: "none",
        t2i: false,
      },
      {
        id: "kimi-k3",
        spec: { id: "kimi-k3", input: ["text"], cost: { input: 0, output: 0 } },
        thinkingLevels: [],
        thinkingOff: "",
        t2i: true,
      },
    ],
  },
};

const EDIT_BUILTIN: ModelAddInitial = {
  providerId: "openai",
  apiKeyMasked: "sk-****1234",
  env: {},
  builtinSelected: ["gpt-5.6", "o5"],
};

export default function ModelAddDialogPreview() {
  const [open, setOpen] = useState(true);
  const [initial, setInitial] = useState<ModelAddInitial | null>(null);
  const [lastSaved, setLastSaved] = useState<ModelAddSaveInput | null>(null);

  const openNew = () => {
    setInitial(null);
    setOpen(true);
  };

  return (
    <div className="bg-muted flex min-h-dvh flex-col items-center gap-4 p-8">
      <p className="text-muted-foreground text-sm">
        添加/编辑模型弹窗样式校对（{PROVIDERS.length} 个内置提供商 + 自定义；自动获取
        返回 {FETCHED_MODELS.length} 条）
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="bg-background rounded-md border px-3 py-1.5 text-sm"
          onClick={openNew}
        >
          打开弹窗（新增）
        </button>
        <button
          type="button"
          className="bg-background rounded-md border px-3 py-1.5 text-sm"
          onClick={() => {
            setInitial(EDIT_CUSTOM);
            setOpen(true);
          }}
        >
          编辑 · 自定义端点
        </button>
        <button
          type="button"
          className="bg-background rounded-md border px-3 py-1.5 text-sm"
          onClick={() => {
            setInitial(EDIT_BUILTIN);
            setOpen(true);
          }}
        >
          编辑 · 内置 OpenAI
        </button>
      </div>
      {lastSaved && (
        <pre className="bg-background max-w-2xl overflow-x-auto rounded-md border px-3 py-2 text-xs">
          上次保存：{JSON.stringify(lastSaved, null, 2)}
        </pre>
      )}
      <ModelAddDialog
        open={open}
        onOpenChange={setOpen}
        providers={PROVIDERS}
        initial={initial}
        onSave={(input) => {
          setLastSaved(input);
          setOpen(false);
        }}
        getProviderModels={async (id) =>
          id === "openai"
            ? { models: OPENAI_CATALOG, selected: ["gpt-5.6", "o5"] }
            : { models: [], selected: [] }
        }
        onLookupSeed={async () => {
          await new Promise((r) => setTimeout(r, 300));
          return {
            reasoning: true,
            contextWindow: 131072,
            maxTokens: 16384,
            input: ["text", "image"],
            thinkingLevelMap: { off: "none" },
            supportedThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
            cost: { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          };
        }}
        onFetchModels={async () => {
          await new Promise((r) => setTimeout(r, 600));
          return FETCHED_MODELS.map((id) => ({
            id,
            contextLength: 128_000,
            maxTokens: 8_192,
          }));
        }}
        onTestConnection={async ({ baseUrl, model }) => {
          await new Promise((r) => setTimeout(r, 800));
          // 夹具：地址含 "fail" 模拟失败，其它成功
          if (baseUrl.includes("fail")) {
            throw new Error(`HTTP 401 Unauthorized（model=${model}）`);
          }
        }}
      />
    </div>
  );
}
