"use client";

import type { FC } from "react";
import type { IconType } from "@lobehub/icons/es/types";
import {
  brandForModel,
  brandForProvider,
  type BrandKey,
} from "@/lib/model/provider-brand";
import { cn } from "@/lib/utils";

/**
 * 模型/服务品牌 mark（LobeHub icons）。服务级位置不传 modelId（分组标题、AI
 * 服务行、引导页服务商卡片），模型级位置传 modelId（模型行、触发器、模型卡片），
 * 口径见 lib/model/provider-brand。
 *
 * 兜底：认不出品牌时统一落 OpenAI mark（不置空、不摆通用占位图标）——自定义
 * 端点三种接口格式里两种是 OpenAI 系，兜底成 OpenAI 多数时候就是实情，且服务行
 * 永远不会出现"这里没有图标"的空缺。
 *
 * 为什么深链 `es/<品牌>/components/{Mono,Color}` 而不是 `import { Claude }`：
 * 品牌 index 会把 .Avatar/.Combine 一起挂进导出对象（Icons.Avatar = Avatar），
 * 那两条链引到 features/IconAvatar、IconCombine → @lobehub/ui（peer 还要 antd），
 * 是"用到了"而非死代码，树摇不掉 = 把 antd 打进客户端包。这两个组件只依赖 react。
 *
 * 配色：有官方彩色 mark（.Color，多为品牌色/渐变）就用它——它是唯一在深浅主题
 * 下都成立的品牌色来源；没有的（OpenAI、Anthropic、xAI……官方 mark 本就是黑白）
 * 退回 Mono：currentColor 随文字色，深色主题自动转白。
 * 例外：彩色 mark 以白／近白为主体的必须排除（Kimi 的 K 是 #fff、Nova 是 #fff），
 * 浅色行上整块看不见 —— 加新品牌前先 `ls es/<品牌>/components/Color.js` 看一遍
 * 填充色，白主体的走 Mono。
 */

import AgnesAIMono from "@lobehub/icons/es/AgnesAI/components/Mono";
import AlibabaColor from "@lobehub/icons/es/Alibaba/components/Color";
import AlibabaMono from "@lobehub/icons/es/Alibaba/components/Mono";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import AntGroupColor from "@lobehub/icons/es/AntGroup/components/Color";
import AntGroupMono from "@lobehub/icons/es/AntGroup/components/Mono";
import AzureAIColor from "@lobehub/icons/es/AzureAI/components/Color";
import AzureAIMono from "@lobehub/icons/es/AzureAI/components/Mono";
import BailianColor from "@lobehub/icons/es/Bailian/components/Color";
import BailianMono from "@lobehub/icons/es/Bailian/components/Mono";
import BasetenMono from "@lobehub/icons/es/Baseten/components/Mono";
import BedrockColor from "@lobehub/icons/es/Bedrock/components/Color";
import BedrockMono from "@lobehub/icons/es/Bedrock/components/Mono";
import CerebrasColor from "@lobehub/icons/es/Cerebras/components/Color";
import CerebrasMono from "@lobehub/icons/es/Cerebras/components/Mono";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import ClaudeMono from "@lobehub/icons/es/Claude/components/Mono";
import CloudflareColor from "@lobehub/icons/es/Cloudflare/components/Color";
import CloudflareMono from "@lobehub/icons/es/Cloudflare/components/Mono";
import CodeBuddyColor from "@lobehub/icons/es/CodeBuddy/components/Color";
import CodeBuddyMono from "@lobehub/icons/es/CodeBuddy/components/Mono";
import CodexColor from "@lobehub/icons/es/Codex/components/Color";
import CodexMono from "@lobehub/icons/es/Codex/components/Mono";
import CohereMono from "@lobehub/icons/es/Cohere/components/Mono";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono";
import DoubaoColor from "@lobehub/icons/es/Doubao/components/Color";
import DoubaoMono from "@lobehub/icons/es/Doubao/components/Mono";
import FireworksColor from "@lobehub/icons/es/Fireworks/components/Color";
import FireworksMono from "@lobehub/icons/es/Fireworks/components/Mono";
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color";
import GeminiMono from "@lobehub/icons/es/Gemini/components/Mono";
import GemmaColor from "@lobehub/icons/es/Gemma/components/Color";
import GemmaMono from "@lobehub/icons/es/Gemma/components/Mono";
import GithubCopilotMono from "@lobehub/icons/es/GithubCopilot/components/Mono";
import GoogleColor from "@lobehub/icons/es/Google/components/Color";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import HuggingFaceColor from "@lobehub/icons/es/HuggingFace/components/Color";
import HuggingFaceMono from "@lobehub/icons/es/HuggingFace/components/Mono";
import HunyuanColor from "@lobehub/icons/es/Hunyuan/components/Color";
import HunyuanMono from "@lobehub/icons/es/Hunyuan/components/Mono";
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";
import LmStudioMono from "@lobehub/icons/es/LmStudio/components/Mono";
import LongCatColor from "@lobehub/icons/es/LongCat/components/Color";
import LongCatMono from "@lobehub/icons/es/LongCat/components/Mono";
import MetaColor from "@lobehub/icons/es/Meta/components/Color";
import MetaMono from "@lobehub/icons/es/Meta/components/Mono";
import MinimaxColor from "@lobehub/icons/es/Minimax/components/Color";
import MinimaxMono from "@lobehub/icons/es/Minimax/components/Mono";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import NovaMono from "@lobehub/icons/es/Nova/components/Mono";
import NvidiaColor from "@lobehub/icons/es/Nvidia/components/Color";
import NvidiaMono from "@lobehub/icons/es/Nvidia/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import OpenRouterColor from "@lobehub/icons/es/OpenRouter/components/Color";
import OpenRouterMono from "@lobehub/icons/es/OpenRouter/components/Mono";
import PerplexityColor from "@lobehub/icons/es/Perplexity/components/Color";
import PerplexityMono from "@lobehub/icons/es/Perplexity/components/Mono";
import QoderColor from "@lobehub/icons/es/Qoder/components/Color";
import QoderMono from "@lobehub/icons/es/Qoder/components/Mono";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono";
import SenseNovaColor from "@lobehub/icons/es/SenseNova/components/Color";
import SenseNovaMono from "@lobehub/icons/es/SenseNova/components/Mono";
import SiliconCloudColor from "@lobehub/icons/es/SiliconCloud/components/Color";
import SiliconCloudMono from "@lobehub/icons/es/SiliconCloud/components/Mono";
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono";
import TogetherColor from "@lobehub/icons/es/Together/components/Color";
import TogetherMono from "@lobehub/icons/es/Together/components/Mono";
import VercelMono from "@lobehub/icons/es/Vercel/components/Mono";
import VertexAIColor from "@lobehub/icons/es/VertexAI/components/Color";
import VertexAIMono from "@lobehub/icons/es/VertexAI/components/Mono";
import VolcengineColor from "@lobehub/icons/es/Volcengine/components/Color";
import VolcengineMono from "@lobehub/icons/es/Volcengine/components/Mono";
import WenxinColor from "@lobehub/icons/es/Wenxin/components/Color";
import WenxinMono from "@lobehub/icons/es/Wenxin/components/Mono";
import WorkersAIColor from "@lobehub/icons/es/WorkersAI/components/Color";
import WorkersAIMono from "@lobehub/icons/es/WorkersAI/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import XiaomiMiMoMono from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import YiColor from "@lobehub/icons/es/Yi/components/Color";
import YiMono from "@lobehub/icons/es/Yi/components/Mono";
import ZAIMono from "@lobehub/icons/es/ZAI/components/Mono";
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono";

/** 一个品牌的两个变体：Colored = 官方彩色 mark（有的品牌才有），Mono = currentColor */
type BrandMark = { Colored?: IconType; Mono: IconType };

const BRAND_MARKS: Record<BrandKey, BrandMark> = {
  AgnesAI: { Mono: AgnesAIMono },
  Alibaba: { Colored: AlibabaColor, Mono: AlibabaMono },
  Anthropic: { Mono: AnthropicMono },
  AntGroup: { Colored: AntGroupColor, Mono: AntGroupMono },
  AzureAI: { Colored: AzureAIColor, Mono: AzureAIMono },
  Bailian: { Colored: BailianColor, Mono: BailianMono },
  Baseten: { Mono: BasetenMono },
  Bedrock: { Colored: BedrockColor, Mono: BedrockMono },
  Cerebras: { Colored: CerebrasColor, Mono: CerebrasMono },
  Claude: { Colored: ClaudeColor, Mono: ClaudeMono },
  Cloudflare: { Colored: CloudflareColor, Mono: CloudflareMono },
  CodeBuddy: { Colored: CodeBuddyColor, Mono: CodeBuddyMono },
  Codex: { Colored: CodexColor, Mono: CodexMono },
  Cohere: { Mono: CohereMono },
  DeepSeek: { Colored: DeepSeekColor, Mono: DeepSeekMono },
  Doubao: { Colored: DoubaoColor, Mono: DoubaoMono },
  Fireworks: { Colored: FireworksColor, Mono: FireworksMono },
  Gemini: { Colored: GeminiColor, Mono: GeminiMono },
  Gemma: { Colored: GemmaColor, Mono: GemmaMono },
  GithubCopilot: { Mono: GithubCopilotMono },
  Google: { Colored: GoogleColor, Mono: GoogleMono },
  Grok: { Mono: GrokMono },
  Groq: { Mono: GroqMono },
  HuggingFace: { Colored: HuggingFaceColor, Mono: HuggingFaceMono },
  Hunyuan: { Colored: HunyuanColor, Mono: HunyuanMono },
  // Kimi 的官方彩色 mark 以白色为主体（#fff 的 K 压在 #1783FF 上），浅色行上整块消失
  // → 用 Mono 跟随文字色，深浅主题都成立
  Kimi: { Mono: KimiMono },
  LmStudio: { Mono: LmStudioMono },
  LongCat: { Colored: LongCatColor, Mono: LongCatMono },
  Meta: { Colored: MetaColor, Mono: MetaMono },
  Minimax: { Colored: MinimaxColor, Mono: MinimaxMono },
  Mistral: { Colored: MistralColor, Mono: MistralMono },
  Moonshot: { Mono: MoonshotMono },
  Nova: { Mono: NovaMono },
  Nvidia: { Colored: NvidiaColor, Mono: NvidiaMono },
  Ollama: { Mono: OllamaMono },
  OpenAI: { Mono: OpenAIMono },
  OpenCode: { Mono: OpenCodeMono },
  OpenRouter: { Colored: OpenRouterColor, Mono: OpenRouterMono },
  Perplexity: { Colored: PerplexityColor, Mono: PerplexityMono },
  Qoder: { Colored: QoderColor, Mono: QoderMono },
  Qwen: { Colored: QwenColor, Mono: QwenMono },
  SenseNova: { Colored: SenseNovaColor, Mono: SenseNovaMono },
  SiliconCloud: { Colored: SiliconCloudColor, Mono: SiliconCloudMono },
  Stepfun: { Mono: StepfunMono },
  Together: { Colored: TogetherColor, Mono: TogetherMono },
  Vercel: { Mono: VercelMono },
  VertexAI: { Colored: VertexAIColor, Mono: VertexAIMono },
  Volcengine: { Colored: VolcengineColor, Mono: VolcengineMono },
  Wenxin: { Colored: WenxinColor, Mono: WenxinMono },
  WorkersAI: { Colored: WorkersAIColor, Mono: WorkersAIMono },
  XAI: { Mono: XAIMono },
  XiaomiMiMo: { Mono: XiaomiMiMoMono },
  Yi: { Colored: YiColor, Mono: YiMono },
  ZAI: { Mono: ZAIMono },
  Zhipu: { Colored: ZhipuColor, Mono: ZhipuMono },
};

/** 认不出品牌时的默认 mark（OpenAI 单色：随文字色，深浅主题自适应） */
const FALLBACK_MARK: IconType = OpenAIMono;

export const ProviderIcon: FC<{
  provider: string;
  /** 传了就是模型级 mark（按 modelId 认厂家），不传按服务认 */
  modelId?: string;
  /** 服务显示名：自定义端点的 id 是 `custom-<slug>`，名字才是品牌线索（"Qoder"、"阿里云 CodingPlan"） */
  providerName?: string;
  className?: string;
}> = ({ provider, modelId, providerName, className }) => {
  const brand =
    modelId === undefined
      ? brandForProvider(provider, providerName)
      : brandForModel(provider, modelId, providerName);
  const mark = brand ? BRAND_MARKS[brand] : undefined;
  const Mark = mark?.Colored ?? mark?.Mono ?? FALLBACK_MARK;
  return <Mark className={cn("size-3.5 shrink-0", className)} />;
};
