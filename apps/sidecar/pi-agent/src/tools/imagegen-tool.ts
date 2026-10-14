/**
 * 文生图/图生图工具（generate_image）：OpenAI 兼容 `POST {baseUrl}/images/generations`。
 * 一张适配器覆盖绝大多数服务商（OpenAI 官方、302.AI、one-api/new-api 等
 * "兼容 OpenAI"网关）；混元/Gemini/Stability 原生协议留 parseGenerationItems
 * 扩展位，P0 不做。批量：n>1 一次请求多张，data[] 逐条消化、坏一张不拖垮整批。
 *
 * 图生图：传 image（本地路径/http URL/data URL）即带底图。请求先走网关常见的
 * generations + image(base64) JSON 变体，被 4xx 拒（如 OpenAI 官方）再回落
 * 官方 /images/edits multipart——4xx 意味着未处理未计费，重试安全。
 * 成图落盘 <cwd>/.kova/imagegen/ 并在结果文本报路径：模型下一轮把该路径填回
 * image 参数即形成"生成 → 迭代修改"闭环。
 *
 * 出网走 sidecar 直连 fetch（fetch_models 先例：provider 凭据通路在 sidecar，
 * 不经宿主 bash 通道；生图回包数 MB，也不该挤 NDJSON 行）。密钥只在本函数
 * 内存里存活一次调用（credentialGet），模型参数碰不到它。
 *
 * 结果 image 块自动走投影链路上屏（image-parts.ts 闸门 + data-image 渲染），
 * 同时回放进模型上下文供验收——超限/类型外会降级为占位行，工具描述里给模型
 * 指了 jpeg 重试路径。配置门控（imagegen-config.ts，get/set_imagegen 协议）：
 * 工具常驻注册不按开关增删（缓存纪律），execute 内实时门控。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { credentialGet } from "../storage/hostdb";
import { getModels } from "../model/catalog";
import { normalizeMime } from "./image-parts";
import { getImageGenConfig, type ImageGenConfig } from "./imagegen-config";

/** 生图请求超时（网关排队 + 出图普遍慢于普通 API）；结果/底图下载单独计时 */
const GENERATE_TIMEOUT_MS = 180_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** 底图字节上限（OpenAI edits 官方 png ≤50MB；20MB 足够且防呆） */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export type ImageGenParams = {
  prompt: string;
  /** 底图（图生图）：工作区相对/绝对路径、http(s) URL 或 data URL；缺省 = 纯文生图 */
  image?: string;
  size?: string;
  format?: "png" | "jpeg";
  /** 单次批量出图张数（1-10，缺省 1）；网关/模型不支持多张时会报错，由模型降回 n=1 并发调用 */
  n?: number;
};

/** 出图张数归一：非法/缺省 → 1，越界 → clamp 到 1..10（OpenAI generations 上限） */
export function clampN(raw: unknown): number {
  const v = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 1;
  return Math.min(10, Math.max(1, v));
}

/** 与 fetch_models 同款 baseUrl 语义：OpenAI SDK 前缀（含 /v1），端点直接拼接 */
export function buildImagesRequest(
  cfg: ImageGenConfig,
  params: ImageGenParams,
  baseUrl: string,
  apiKey: string,
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const size = params.size?.trim() || cfg.size || "1024x1024";
  const body: Record<string, unknown> = {
    model: cfg.modelId,
    prompt: params.prompt,
    n: clampN(params.n),
    size,
    // dall-e 系默认回 url（临时链接），显式要 b64；gpt-image 系本就回 b64（多余字段被忽略）
    response_format: "b64_json",
  };
  // gpt-image 系支持 output_format；dall-e 不认识（被忽略），jpeg 能显著压进 2MiB 内联闸门
  if (params.format === "jpeg" || params.format === "png") {
    body.output_format = params.format;
  }
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/images/generations`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  };
}

/** generations + image(base64) 变体：网关常见的图生图入参形态（302.AI/one-api 等） */
export function attachImageToBody(
  body: Record<string, unknown>,
  b64: string,
): Record<string, unknown> {
  return { ...body, image: b64 };
}

/** 官方 /images/edits multipart 回落：image 走文件字段，无 response_format（gpt-image 恒 b64） */
export function buildEditsRequest(
  cfg: ImageGenConfig,
  params: ImageGenParams,
  baseUrl: string,
  apiKey: string,
  imageBytes: Uint8Array,
  imageMime: string,
): { url: string; headers: Record<string, string>; form: FormData } {
  const size = params.size?.trim() || cfg.size || "1024x1024";
  const form = new FormData();
  form.set("model", cfg.modelId);
  form.set("prompt", params.prompt);
  form.set("size", size);
  const n = clampN(params.n);
  // 缺省形态不写 n 字段（保持单图请求与旧网关的最大兼容面）；官方 gpt-image edits 支持 n
  if (n > 1) form.set("n", String(n));
  const ext = imageMime === "image/jpeg" ? "jpg" : imageMime === "image/webp" ? "webp" : "png";
  // 拷贝为 ArrayBuffer 背衬视图：Buffer 的 ArrayBufferLike 不满足 BlobPart 类型
  form.set("image", new Blob([new Uint8Array(imageBytes)], { type: imageMime }), `input.${ext}`);
  if (params.format === "jpeg" || params.format === "png") {
    form.set("output_format", params.format);
  }
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/images/edits`,
    // 不设 Content-Type：交给 fetch 按 FormData 生成 multipart boundary
    headers: { Authorization: `Bearer ${apiKey}` },
    form,
  };
}

export type GenerationItem = { b64?: string; url?: string };

/**
 * 响应解析：data[] 全部条目，b64_json 优先，其次 url（下载分支在调用侧）。
 * 部分网关对 n>1 会静默回少于请求数的条目（或回重复条目缺数据），
 * 这里按实际有效条目数返回，调用侧如实报告。
 */
export function parseGenerationItems(json: unknown): GenerationItem[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const items: GenerationItem[] = [];
  for (const entry of data) {
    const e = entry as { b64_json?: unknown; url?: unknown } | null;
    const b64 = str(e?.b64_json);
    const url = str(e?.url);
    if (b64 || url) items.push({ b64, url });
  }
  return items;
}

/** base64 魔数嗅探（png/jpeg/webp/gif），识别不了回落 png（白名单内最稳缺省） */
export function sniffImageMime(b64: string): string {
  let head: Uint8Array;
  try {
    head = new Uint8Array(Buffer.from(b64.slice(0, 32), "base64"));
  } catch {
    return "image/png";
  }
  const is = (sig: number[], at = 0): boolean =>
    head.length >= at + sig.length && sig.every((b, i) => head[at + i] === b);
  const ascii = (s: string, at: number): boolean =>
    head.length >= at + s.length && [...s].every((c, i) => head[at + i] === c.charCodeAt(0));
  if (is([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (is([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii("RIFF", 0) && ascii("WEBP", 8)) return "image/webp";
  if (ascii("GIF8", 0)) return "image/gif";
  return "image/png";
}

/** 底图解析结果：base64 + 归一后的 mime */
export type ResolvedInputImage = { b64: string; mime: string };

/**
 * 底图来源三形态归一为 base64：data URL 直接拆；http(s) 下载（网关大多不吃外链，
 * 自取转码最通用）；其余按本地路径读（相对 cwd）。错误回可转述文本而不是抛栈。
 */
export async function resolveInputImage(
  raw: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ResolvedInputImage | { err: string }> {
  const s = raw.trim();
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(s);
  if (dataUrl) {
    const mime = normalizeMime(dataUrl[1]) ?? sniffImageMime(dataUrl[2]);
    return { b64: dataUrl[2], mime };
  }
  let b64 = "";
  let mime: string | null = null;
  if (/^https?:\/\//i.test(s)) {
    let buf: Buffer;
    try {
      const dl = await fetch(s, { signal });
      if (!dl.ok) return { err: `底图下载失败：HTTP ${dl.status}` };
      buf = Buffer.from(await dl.arrayBuffer());
      mime = normalizeMime((dl.headers.get("content-type") ?? "").split(";")[0]);
    } catch (err) {
      if (signal.aborted) throw err;
      return { err: `底图下载失败：${err instanceof Error ? err.message : String(err)}` };
    }
    if (buf.length > MAX_INPUT_BYTES) {
      return { err: `底图过大（${fmtKb(buf.length)}，上限 20 MB）` };
    }
    b64 = buf.toString("base64");
  } else {
    const p = isAbsolute(s) ? s : join(cwd, s);
    let buf: Buffer;
    try {
      buf = await readFile(p);
    } catch (err) {
      return {
        err:
          `底图读取失败：${p}（${err instanceof Error ? err.message : String(err)}）。` +
          "image 传工作区相对路径、绝对路径、http(s) URL 或 data URL；" +
          "本工具此前生成的图片用结果里报出的保存路径。",
      };
    }
    if (buf.length > MAX_INPUT_BYTES) {
      return { err: `底图过大（${fmtKb(buf.length)}，上限 20 MB）` };
    }
    b64 = buf.toString("base64");
  }
  if (!b64) return { err: "底图内容为空" };
  return { b64, mime: mime ?? sniffImageMime(b64) };
}

/**
 * 成图落盘：workspace 的 .kova/imagegen/ 下按时间戳+模型名存档，回绝对路径供下轮引用。
 * index = 同批序号：批量调用毫秒同值，裸 Date.now() 会互相覆盖。
 */
async function saveGeneratedImage(
  cwd: string,
  modelId: string,
  mime: string,
  b64: string,
  index = 0,
): Promise<string> {
  const ext =
    mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
  const slug = modelId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "image";
  const dir = join(cwd, ".kova", "imagegen");
  const full = join(
    dir,
    `${Date.now()}${index > 0 ? `-${index}` : ""}-${slug}.${ext}`,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(full, Buffer.from(b64, "base64"));
  return full;
}

/** 组合外部中断信号与超时信号（AbortSignal.any 不存在的运行时兜底） */
function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as {
    any?: (s: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort();
      break;
    }
    s.addEventListener("abort", () => c.abort(), { once: true });
  }
  return c.signal;
}

const fmtKb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** 批量合计可达 MB 级，KB 数字过长；<1MB 沿用 fmtKb 文案（保持单图既有输出兼容） */
const fmtSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : fmtKb(bytes);

/** 依赖缝隙：端点解析（默认查模型目录的 baseUrl；单测注入假端点，不 mock 模块）；
 *  cwd = 工作区根（底图相对路径解析 + 成图落盘目录），缺省进程 cwd */
export type ImageGenDeps = {
  resolveEndpoint?: (cfg: ImageGenConfig) => string;
  cwd?: string;
};

const defaultResolveEndpoint = (cfg: ImageGenConfig): string => {
  const model = getModels().getModel(cfg.provider, cfg.modelId);
  return (model?.baseUrl ?? "").trim();
};

export function buildImageGenTool(deps: ImageGenDeps = {}): AgentTool {
  const resolveEndpoint = deps.resolveEndpoint ?? defaultResolveEndpoint;
  const cwd = deps.cwd?.trim() || process.cwd();
  return {
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate an image with the configured image model and return it as an image you can see " +
      "in the result. Text-to-image: pass prompt only. Image-to-image: also pass image (a base " +
      "image to transform: workspace-relative path, absolute path, http(s) URL, or data URL) - " +
      "each generated image is saved under .kova/imagegen/ in the workspace and its path is " +
      "reported in the result text, so you can iterate by passing that path back as image. " +
      "Use for banners, illustrations, mockups and other visual assets. To produce several " +
      "variations in one call, pass n (2-10) instead of calling the tool repeatedly - all " +
      "images return together and display side by side. Optionally pass size " +
      "(e.g. \"1024x1024\", \"1792x1024\", "
    + "\"auto\") or format (\"jpeg\" keeps files small). If the result says the image exceeded " +
      "the inline display cap, retry with format=\"jpeg\". Refusal results (feature disabled or " +
      "model not configured) are text-only - relay them to the user, do not retry.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Image description: subject, style, colors, composition. Be specific and vivid. " +
          "For image-to-image, describe the desired change relative to the base image.",
      }),
      image: Type.Optional(
        Type.String({
          description:
            "Base image for image-to-image: workspace-relative path, absolute path, http(s) URL, " +
            "or data URL. Pass the saved path reported by a previous generate_image result to " +
            "iterate on it. Omit for pure text-to-image.",
        }),
      ),
      size: Type.Optional(
        Type.String({
          description: "Output size, e.g. 1024x1024 / 1792x1024 / 1024x1792 / auto (default from settings)",
        }),
      ),
      format: Type.Optional(
        Type.Union([Type.Literal("png"), Type.Literal("jpeg")], {
          description: "Output format hint; \"jpeg\" strongly recommended for large sizes",
        }),
      ),
      n: Type.Optional(
        Type.Number({
          description:
            "Number of images to generate in ONE call (1-10, default 1). Use this instead of " +
            "parallel tool calls when the user wants several variations of the same prompt. " +
            "If the gateway rejects n>1, retry with n=1.",
        }),
      ),
    }),
    execute: async (_id, raw, signal) => {
      const p = raw as ImageGenParams;
      const prompt = (p.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt is required");
      const cfg = getImageGenConfig();
      if (!cfg.enabled) {
        return textResult(
          "文生图未启用（设置 → 模型 → 文生图）。请告知用户开启后再试，不要重复调用。",
        );
      }
      if (!cfg.provider || !cfg.modelId) {
        return textResult(
          "尚未配置默认文生图模型（设置 → 模型 → 文生图）。请告知用户配置后再试，不要重复调用。",
        );
      }
      const baseUrl = resolveEndpoint(cfg);
      if (!baseUrl) {
        return textResult(
          `文生图模型 ${cfg.provider}/${cfg.modelId} 缺少端点地址，无法调用。` +
            "请确认该 provider 已在 设置 → 模型 配置（OpenAI 兼容端点）。",
        );
      }
      let apiKey = "";
      try {
        const cred = await credentialGet(cfg.provider);
        apiKey = cred?.apiKey?.trim() ?? "";
      } catch {
        // 凭据通道失败按未配置处理，给模型可转述的文案而不是抛栈
      }
      if (!apiKey) {
        return textResult(
          `provider "${cfg.provider}" 未配置 API 密钥（设置 → 模型），文生图无法调用。`,
        );
      }
      // 底图（图生图）：密钥门后再解析，来源无效就不费一次出图请求
      const imageRaw = typeof p.image === "string" ? p.image.trim() : "";
      let input: ResolvedInputImage | null = null;
      if (imageRaw) {
        const r = await resolveInputImage(imageRaw, cwd, signal ?? new AbortController().signal);
        if ("err" in r) return textResult(r.err, { error: true });
        input = r;
      }
      const req = buildImagesRequest(cfg, { ...p, prompt }, baseUrl, apiKey);
      const mkSignal = () =>
        mergeSignals([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(GENERATE_TIMEOUT_MS),
        ]);
      let res: Response;
      let text: string;
      try {
        res = await fetch(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(input ? attachImageToBody(req.body, input.b64) : req.body),
          signal: mkSignal(),
        });
        text = await res.text();
      } catch (err) {
        if (signal?.aborted) throw err; // 用户中断：照抛，走既有取消路径
        const why = err instanceof Error ? err.message : String(err);
        return textResult(`文生图请求失败：${why}`, { error: true });
      }
      // generations+image 形态被 4xx 拒（如 OpenAI 官方）→ 回落官方 /images/edits
      // multipart。4xx = 请求被拒未处理未计费，重试安全；5xx 不重试以免双计费。
      if (input && !res.ok && res.status < 500) {
        const edits = buildEditsRequest(
          cfg,
          { ...p, prompt },
          baseUrl,
          apiKey,
          Buffer.from(input.b64, "base64"),
          input.mime,
        );
        try {
          res = await fetch(edits.url, {
            method: "POST",
            headers: edits.headers,
            body: edits.form,
            signal: mkSignal(),
          });
          text = await res.text();
        } catch (err) {
          if (signal?.aborted) throw err;
          const why = err instanceof Error ? err.message : String(err);
          return textResult(`图生图（edits 回落）请求失败：${why}`, { error: true });
        }
      }
      if (!res.ok) {
        return textResult(
          `文生图接口返回 HTTP ${res.status}${text ? `：${text.slice(0, 300)}` : ""}` +
            (input ? "（generations+image 与 edits 两种形态均被拒绝）" : ""),
          { status: res.status, error: true },
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return textResult(`文生图响应不是 JSON：${text.slice(0, 200)}`, { error: true });
      }
      const items = parseGenerationItems(json);
      if (items.length === 0) {
        const em = (json as { error?: { message?: unknown } })?.error?.message;
        const suffix = typeof em === "string" && em.trim() ? `：${em.slice(0, 300)}` : "";
        return textResult(`文生图响应中没有图片数据${suffix}`, { error: true });
      }
      const sizeUsed = req.body.size as string;
      const wanted = req.body.n as number;
      // 逐条消化：b64 直取；url 立即取字节（链接有时效，别把 url 塞给模型）。
      // 单条失败不带走整批（批量里坏一张是网关常态），全坏才算错。
      type Generated = { b64: string; mime: string; bytes: number; path: string };
      const generated: Generated[] = [];
      const failures: string[] = [];
      for (const [k, item] of items.entries()) {
        let b64 = item.b64 ?? "";
        let mime: string | null = null;
        if (!b64 && item.url) {
          try {
            const dl = await fetch(item.url, {
              signal: mergeSignals([
                signal ?? new AbortController().signal,
                AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
              ]),
            });
            if (!dl.ok) {
              failures.push(`第 ${k + 1} 张下载失败 HTTP ${dl.status}`);
              continue;
            }
            mime = normalizeMime((dl.headers.get("content-type") ?? "").split(";")[0]);
            b64 = Buffer.from(await dl.arrayBuffer()).toString("base64");
          } catch (err) {
            if (signal?.aborted) throw err; // 用户中断：照抛，走既有取消路径
            failures.push(
              `第 ${k + 1} 张下载失败：${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
        }
        if (!b64) {
          failures.push(`第 ${k + 1} 张数据为空`);
          continue;
        }
        if (!mime) mime = sniffImageMime(b64);
        const bytes = Math.floor((b64.length * 3) / 4);
        let path = "";
        try {
          path = await saveGeneratedImage(cwd, cfg.modelId, mime, b64, k);
        } catch {
          // 落盘失败不影响上屏，只是少了下轮迭代引用的路径
        }
        generated.push({ b64, mime, bytes, path });
      }
      if (generated.length === 0) {
        return textResult(
          `生图结果处理失败：${failures.join("；") || "响应中没有有效图片"}`,
          { error: true },
        );
      }
      const totalBytes = generated.reduce((s, g) => s + g.bytes, 0);
      const multi = generated.length > 1;
      const verb = input ? "已基于底图生成" : "已生成";
      const headline = multi
        ? `${verb} ${generated.length} 张图片 ${cfg.modelId}（${sizeUsed}，合计约 ${fmtSize(totalBytes)}）`
        : `${verb}图片 ${cfg.modelId}（${sizeUsed}，约 ${fmtSize(totalBytes)}）`;
      const shortfall =
        wanted > items.length
          ? `（请求 ${wanted} 张，网关仅回 ${items.length} 张）`
          : "";
      const lost = failures.length
        ? `（${failures.length} 张结果获取失败：${failures.join("；")}）`
        : "";
      const pathLines = generated
        .filter((g) => g.path)
        .map((g) => `\n→ 已保存 ${g.path}`)
        .join("");
      const iterNote = generated.some((g) => g.path)
        ? multi
          ? "\n（把其中任意一条路径作为 image 参数传回即可迭代修改）"
          : "（下一轮把它作为 image 参数传回即可迭代修改）"
        : "";
      return {
        content: [
          { type: "text" as const, text: headline + shortfall + lost + pathLines + iterNote },
          ...generated.map((g) => ({
            type: "image" as const,
            data: g.b64,
            mimeType: g.mime,
          })),
        ],
        details: {
          model: `${cfg.provider}/${cfg.modelId}`,
          size: sizeUsed,
          bytes: totalBytes,
          count: generated.length,
          imageToImage: !!input,
          ...(generated.some((g) => g.path)
            ? { paths: generated.filter((g) => g.path).map((g) => g.path) }
            : {}),
        },
      };
    },
  };
}
