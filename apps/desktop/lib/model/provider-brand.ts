/**
 * 品牌解析：pi-ai 的 provider id / 模型 id / 服务名 → LobeHub 品牌 id
 * （图标见 components/custom-ui/provider-icon.tsx）。只做纯映射，不含 React。
 *
 * 两条口径（调用方按语义选，不是"哪个都能用"）：
 * - 服务级 `brandForProvider`：分组标题、设置页 AI 服务行、引导页服务商卡片。
 *   只看服务身份（内置 provider id / 自定义端点 slug / 服务名），不掺模型 ——
 *   "provider 位置放 provider 的图标"。
 * - 模型级 `brandForModel`：模型行、触发器、引导页模型卡片。先按 modelId 认厂家
 *   （Claude 星芒、Gemini 彩色星比服务通用 mark 有信息量；网关服务下更是唯一
 *   线索），认不出退回服务品牌 —— "model 位置放 model 的图标"。
 *
 * 自定义端点（设置里手加的服务）的 id 是 `custom-<用户自起的 slug>`，名字也由
 * 用户起：所以除了内置精确表，还有一张 slug 表兜底——抹平 custom 前缀、大小写、
 * 连字符后精确匹配，再对够长（≥5 字符或含中文）的键做子串匹配
 * （`custom-my-opencode` 也能落到 OpenCode）。
 *
 * 拿不准一律返回 undefined，由调用方落默认 mark（OpenAI）：不给空洞占位。
 */

/** 本项目用到的 LobeHub 品牌 id（必须与 provider-icon 的 BRAND_MARKS 键一一对应） */
export type BrandKey =
  | "AgnesAI"
  | "Alibaba"
  | "Anthropic"
  | "AntGroup"
  | "AzureAI"
  | "Baseten"
  | "Bedrock"
  | "Bailian"
  | "Cerebras"
  | "Claude"
  | "Cloudflare"
  | "CodeBuddy"
  | "Codex"
  | "Cohere"
  | "DeepSeek"
  | "Doubao"
  | "Fireworks"
  | "Gemini"
  | "Gemma"
  | "GithubCopilot"
  | "Google"
  | "Grok"
  | "Groq"
  | "HuggingFace"
  | "Hunyuan"
  | "Kimi"
  | "LmStudio"
  | "LongCat"
  | "Meta"
  | "Minimax"
  | "Mistral"
  | "Moonshot"
  | "Nova"
  | "Nvidia"
  | "Ollama"
  | "OpenAI"
  | "OpenCode"
  | "OpenRouter"
  | "Perplexity"
  | "Qoder"
  | "Qwen"
  | "SenseNova"
  | "SiliconCloud"
  | "Stepfun"
  | "Together"
  | "Vercel"
  | "VertexAI"
  | "Volcengine"
  | "Wenxin"
  | "WorkersAI"
  | "XAI"
  | "XiaomiMiMo"
  | "Yi"
  | "ZAI"
  | "Zhipu";

/**
 * 内置 provider id → 服务品牌。键取自 pi-ai 的内置 provider（见 sidecar 的
 * list_models），是权威表：zai 就是 Z.AI 而不是 Zhipu。未列出的（自定义端点、
 * 未来的新服务）走下面两张表。
 * ant-ling（蚂蚁百灵）无独立 mark，用母品牌 AntGroup 兜底。
 */
const PROVIDER_BRAND: Record<string, BrandKey> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "Codex",
  google: "Google",
  "google-vertex": "VertexAI",
  deepseek: "DeepSeek",
  zai: "ZAI",
  "zai-coding-cn": "ZAI",
  moonshotai: "Moonshot",
  "moonshotai-cn": "Moonshot",
  "kimi-coding": "Kimi",
  minimax: "Minimax",
  "minimax-cn": "Minimax",
  xai: "XAI",
  mistral: "Mistral",
  groq: "Groq",
  cerebras: "Cerebras",
  together: "Together",
  nvidia: "Nvidia",
  fireworks: "Fireworks",
  baseten: "Baseten",
  huggingface: "HuggingFace",
  openrouter: "OpenRouter",
  "vercel-ai-gateway": "Vercel",
  "cloudflare-ai-gateway": "Cloudflare",
  "cloudflare-workers-ai": "WorkersAI",
  "amazon-bedrock": "Bedrock",
  "azure-openai-responses": "AzureAI",
  "github-copilot": "GithubCopilot",
  opencode: "OpenCode",
  "opencode-go": "OpenCode",
  meta: "Meta",
  "qwen-token-plan": "Qwen",
  "qwen-token-plan-cn": "Qwen",
  "qwen-token-plan-individual": "Qwen",
  xiaomi: "XiaomiMiMo",
  "xiaomi-token-plan-ams": "XiaomiMiMo",
  "xiaomi-token-plan-cn": "XiaomiMiMo",
  "xiaomi-token-plan-sgp": "XiaomiMiMo",
  "ant-ling": "AntGroup",
};

/**
 * 服务 id / 服务名的 slug → 品牌。自定义端点靠这张表认亲：id 是
 * `custom-<slug>`、名字是用户随手起的（"Qoder"、"llm-studio"、"阿里云 CodingPlan"）。
 * 键写成 normalizeServiceSlug 之后的形态（全小写、无连字符空格）。
 */
const SLUG_BRAND: Record<string, BrandKey> = {
  // 模型厂家
  claude: "Claude",
  anthropic: "Anthropic",
  openai: "OpenAI",
  chatgpt: "OpenAI",
  openaicodex: "Codex",
  codex: "Codex",
  gemini: "Gemini",
  gemma: "Gemma",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  tongyi: "Qwen",
  zhipu: "Zhipu",
  zai: "ZAI",
  glm: "Zhipu",
  chatglm: "Zhipu",
  moonshot: "Moonshot",
  kimi: "Kimi",
  minimax: "Minimax",
  grok: "Grok",
  xai: "XAI",
  mistral: "Mistral",
  llama: "Meta",
  meta: "Meta",
  cohere: "Cohere",
  perplexity: "Perplexity",
  sonar: "Perplexity",
  nova: "Nova",
  hunyuan: "Hunyuan",
  tencent: "Hunyuan",
  doubao: "Doubao",
  bytedance: "Doubao",
  volcengine: "Volcengine",
  wenxin: "Wenxin",
  ernie: "Wenxin",
  baidu: "Wenxin",
  stepfun: "Stepfun",
  step: "Stepfun",
  mimo: "XiaomiMiMo",
  xiaomi: "XiaomiMiMo",
  longcat: "LongCat",
  sensenova: "SenseNova",
  sensetime: "SenseNova",
  yi: "Yi",
  "01ai": "Yi",
  nemotron: "Nvidia",
  antling: "AntGroup",
  antgroup: "AntGroup",
  // 服务商
  google: "Google",
  deepmind: "Google",
  vertex: "VertexAI",
  azure: "AzureAI",
  aws: "Bedrock",
  bedrock: "Bedrock",
  copilot: "GithubCopilot",
  github: "GithubCopilot",
  cloudflare: "Cloudflare",
  workersai: "WorkersAI",
  vercel: "Vercel",
  openrouter: "OpenRouter",
  siliconflow: "SiliconCloud",
  siliconcloud: "SiliconCloud",
  // 阿里巴巴系：企业品牌走 Alibaba，百炼/DashScope（模型平台）走 Bailian
  alibaba: "Alibaba",
  aliyun: "Alibaba",
  阿里云: "Alibaba",
  bailian: "Bailian",
  dashscope: "Bailian",
  百炼: "Bailian",
  // 本地/聚合工具（用户常把这些挂成自定义端点）
  ollama: "Ollama",
  lmstudio: "LmStudio",
  opencode: "OpenCode",
  qoder: "Qoder",
  agnes: "AgnesAI",
  agnesai: "AgnesAI",
  // 腾讯 CodeBuddy（lobe-icons 归在 application 组）：自建中转也叫它 workbuddy
  codebuddy: "CodeBuddy",
  workbuddy: "CodeBuddy",
  // 其它常见厂家
  groq: "Groq",
  cerebras: "Cerebras",
  together: "Together",
  nvidia: "Nvidia",
  fireworks: "Fireworks",
  baseten: "Baseten",
  huggingface: "HuggingFace",
  hf: "HuggingFace",
};

/** 参与子串匹配的键：够长或含中文（短键只做精确匹配，免得 "yi"/"step" 到处乱撞） */
const SUBSTRING_KEYS = Object.keys(SLUG_BRAND)
  .filter((k) => k.length >= 5 || /[\u4e00-\u9fff]/.test(k))
  .sort((a, b) => b.length - a.length);

/* ---------- 模糊匹配（容错层） ----------
 * 用在"精确 + 子串都没命中"之后，只治拼写噪声（qzai→zai、qwne→qwen、
 * antropic→anthropic），不做相似度打分也不用第三方库。三重护栏挡住乱标：
 *  1. 键长 ≥4（"yi"/"glm"/"hf" 这类短键不参战，随便一个词都撞得上）；
 *  2. 距离阈值随长度收紧：4–7 字只允 1 处差异、≥8 字才允 2 处；
 *  3. 并列判负：最佳距离上有两个不同品牌 → 谁都别认（grog 距 grok/groq 都是 1）。
 * 键按长度分桶，只在同长 ±2 的桶里比，且只在未命中时才跑——单次渲染成本可忽略。
 */

/** 编辑距离（含相邻换位），超限即提前返回 limit+1 */
function editDistance(a: string, b: string, limit: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > limit) return limit + 1;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i += 1) {
    const cur: number[] = new Array<number>(m + 1).fill(0);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

/** 长度对应的容错额度：短词只容一处，长词才容两处 */
function distanceLimit(len: number): number {
  return len >= 8 ? 2 : 1;
}

/** 模糊候选桶：键长 → [键, 品牌]（服务层用） */
const SLUG_BUCKETS = new Map<number, [string, BrandKey][]>();
for (const [key, brand] of Object.entries(SLUG_BRAND)) {
  if (key.length < 4 || /[\u4e00-\u9fff]/.test(key)) continue;
  const bucket = SLUG_BUCKETS.get(key.length);
  if (bucket) bucket.push([key, brand]);
  else SLUG_BUCKETS.set(key.length, [[key, brand]]);
}

/** 模型 id 的厂家 token（容错用；正则前缀表之后兜底） */
const MODEL_TOKENS: readonly (readonly [string, BrandKey])[] = [
  ["claude", "Claude"],
  ["anthropic", "Anthropic"],
  ["gemini", "Gemini"],
  ["gemma", "Gemma"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["chatglm", "Zhipu"],
  ["zhipu", "Zhipu"],
  ["kimi", "Kimi"],
  ["moonshot", "Moonshot"],
  ["minimax", "Minimax"],
  ["grok", "Grok"],
  ["mistral", "Mistral"],
  ["llama", "Meta"],
  ["cohere", "Cohere"],
  ["nova", "Nova"],
  ["sonar", "Perplexity"],
  ["hunyuan", "Hunyuan"],
  ["doubao", "Doubao"],
  ["ernie", "Wenxin"],
  ["wenxin", "Wenxin"],
  ["stepfun", "Stepfun"],
  ["longcat", "LongCat"],
  ["sensenova", "SenseNova"],
  ["nemotron", "Nvidia"],
  ["codex", "Codex"],
  ["agnes", "AgnesAI"],
];

/** 在候选集里找唯一的模糊命中；并列或超阈值返回 undefined */
function nearestBrand(
  value: string,
  candidates: readonly (readonly [string, BrandKey])[],
): BrandKey | undefined {
  const limit = distanceLimit(value.length);
  let best: number | undefined;
  let bestBrand: BrandKey | undefined;
  let tied = false;
  for (const [key, brand] of candidates) {
    if (Math.abs(key.length - value.length) > limit) continue;
    const dist = editDistance(value, key, limit);
    if (dist > limit) continue;
    if (best === undefined || dist < best) {
      best = dist;
      bestBrand = brand;
      tied = false;
    } else if (dist === best && brand !== bestBrand) {
      tied = true;
    }
  }
  return tied ? undefined : bestBrand;
}

/** 模糊：归一化 slug → 品牌（同长 ±2 桶内比编辑距离） */
function brandFromFuzzySlug(slug: string): BrandKey | undefined {
  if (slug.length < 4) return undefined;
  const limit = distanceLimit(slug.length);
  const candidates: [string, BrandKey][] = [];
  for (let len = slug.length - limit; len <= slug.length + limit; len += 1) {
    const bucket = SLUG_BUCKETS.get(len);
    if (bucket) candidates.push(...bucket);
  }
  return nearestBrand(slug, candidates);
}

/** 模型 id 的 token 化：字母/数字分段（"qwne3.8-flash" → qwne,3,8,flash） */
function modelTokens(value: string): string[] {
  return value.match(/[a-z]+|\d+/g) ?? [];
}

/** 自定义端点的 slug 归一：抹掉 custom 前缀 + 大小写 + 连字符空格点 */
function normalizeServiceSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(custom|自定义)[-_ ]?/, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function brandFromSlug(value: string | undefined): BrandKey | undefined {
  if (!value) return undefined;
  const slug = normalizeServiceSlug(value);
  if (!slug) return undefined;
  const exact = SLUG_BRAND[slug];
  if (exact) return exact;
  for (const key of SUBSTRING_KEYS) {
    if (slug.includes(key)) return SLUG_BRAND[key];
  }
  // 精确与子串都没中，才走拼写容错
  return brandFromFuzzySlug(slug);
}

/** 服务级品牌：内置精确表 → id 的 slug → 服务名的 slug（不掺模型） */
export function brandForProvider(
  provider: string,
  providerName?: string,
): BrandKey | undefined {
  return (
    PROVIDER_BRAND[provider.toLowerCase()] ??
    brandFromSlug(provider) ??
    brandFromSlug(providerName)
  );
}

/** 模型 id → 品牌（保守前缀匹配；顺序即优先级，命中即止） */
const MODEL_BRAND_RULES: readonly (readonly [RegExp, BrandKey])[] = [
  [/^gpt-oss/, "OpenAI"],
  [/^gpt-/, "OpenAI"],
  [/^chatgpt/, "OpenAI"],
  [/^o[134](-|$)/, "OpenAI"],
  [/^codex/, "Codex"],
  [/^claude/, "Claude"],
  [/^(sonnet|opus|haiku)/, "Claude"],
  [/^gemini/, "Gemini"],
  [/^gemma/, "Gemma"],
  [/^deepseek/, "DeepSeek"],
  [/^qwen/, "Qwen"],
  [/^qwq/, "Qwen"],
  [/^(glm|chatglm|zhipu)/, "Zhipu"],
  [/^kimi/, "Kimi"],
  [/^moonshot/, "Moonshot"],
  [/^(minimax|abab)/, "Minimax"],
  [/^grok/, "Grok"],
  [/^(mistral|mixtral|magistral|codestral|devstral|pixtral)/, "Mistral"],
  [/^llama/, "Meta"],
  [/^command/, "Cohere"],
  [/^nova-/, "Nova"],
  [/^sonar/, "Perplexity"],
  [/^hunyuan/, "Hunyuan"],
  [/^doubao/, "Doubao"],
  [/^seed-/, "Doubao"],
  [/^(ernie|wenxin)/, "Wenxin"],
  [/^step-/, "Stepfun"],
  [/^mimo/, "XiaomiMiMo"],
  [/^longcat/, "LongCat"],
  [/^sensenova/, "SenseNova"],
  [/^yi-/, "Yi"],
  [/^nemotron/, "Nvidia"],
  [/^(ling|ring)-/, "AntGroup"],
];

/** 按模型 id 认厂家（提供不了线索返回 undefined）。
 *  网关的 id 常带厂家前缀（"anthropic/claude-sonnet-4.5"、"cn:deepseek-v4"），
 *  末段是模型名、首段是厂家名，两段都试：先模型名（更具体），再厂家前缀。
 *  前缀表（含少量拼写噪声）都没中时，按 token 做一轮模糊容错。 */
export function brandFromModelId(
  modelId: string | undefined,
): BrandKey | undefined {
  if (!modelId) return undefined;
  const segments = modelId.toLowerCase().split(/[/:]/).filter(Boolean);
  if (segments.length === 0) return undefined;
  const candidates =
    segments.length > 1
      ? [segments[segments.length - 1], segments[0]]
      : segments;
  for (const candidate of candidates) {
    for (const [re, brand] of MODEL_BRAND_RULES) {
      if (re.test(candidate)) return brand;
    }
  }
  for (const candidate of candidates) {
    for (const token of modelTokens(candidate)) {
      if (token.length < 4) continue;
      const brand = nearestBrand(token, MODEL_TOKENS);
      if (brand) return brand;
    }
  }
  return undefined;
}

/**
 * 模型级品牌：先按 modelId 认厂家，认不出再用服务品牌。
 * 行内认的是"这行的模型是谁家的"，不是"这行来自哪个服务"——Claude 的星芒、
 * Gemini 的彩色星比服务名下的通用 mark 有用得多；聚合/网关服务下更是唯一线索。
 */
export function brandForModel(
  provider: string,
  modelId: string | undefined,
  providerName?: string,
): BrandKey | undefined {
  return brandFromModelId(modelId) ?? brandForProvider(provider, providerName);
}
