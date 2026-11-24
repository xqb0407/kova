/**
 * 拒图修复（多模态降级闭环的响应式安全网）。
 *
 * 降级链分层：视觉辅助开关打开时，streamFn 先把纯文本模型的 image 块换成带
 * imageId 的占位文本（model/image-refs.ts，模型可主动调 see_image 查看）——
 * 本层不再有图可剥，是幂等 no-op。目录元数据驱动的降级在 pi-ai
 * transformMessages 收口（补丁已恢复 user 分支）：
 * input 不含 image 的模型，图片在请求组装阶段就被换成占位文本。这层兜底的是
 * 元数据**反向标错**的残余——目录标成支持图像、端点却真拒图（自定义端点常见）：
 * 那类模型每轮请求都会被 400 打死，会话报废。做法照 provider-retry 里不透明
 * 400 的 limitRepair 先例：流建立前的终态 400/422 且本次请求确实带图时，把
 * 请求 context 里的图片剥成占位文本立即重试一次；成功后由调用方把该模型记入
 * sticky 集合（Running.imageRejectionModels），后续轮次在 streamFn 入口预剥离，
 * 不再浪费那次必败请求。剥图只改发出去的 context，转录与 UI 气泡不动——
 * 切回真正支持视觉的模型后历史图片自动恢复可见。
 */
import type { Context, Message, Model, Api } from "@earendil-works/pi-ai";
import { MEDIA_OMITTED_NOTE } from "@earendil-works/pi-ai/api/transform-messages";
import type { ClassifiedAgentError } from "../agent/agent-errors";

/** 与 pi-ai 请求侧降级共用同一句中性说明，避免两套「看不到图」文案 */
export const IMAGE_REJECTION_PLACEHOLDER = MEDIA_OMITTED_NOTE;

/** sticky 集合的键：provider/modelId */
export function imageModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** 请求 context 里是否还有图片块（user/toolResult 的数组 content） */
export function contextHasImages(context: Context): boolean {
  return context.messages.some(messageHasImages);
}

function messageHasImages(message: Message): boolean {
  if (message.role !== "user" && message.role !== "toolResult") return false;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => block.type === "image");
}

/**
 * 剥掉请求 context 里的全部图片块：user/toolResult 消息中连续的 image 块
 * 合并替换为一条占位 text 块（上游 replaceImagesWithPlaceholder 同款）。
 * 无图消息保持原引用——cacheWarmer 的前缀身份检查、cacheControl 等不受扰动。
 * 泛型返回保留 TranscriptContext 的品牌（streamFn 处的 context 是品牌类型）。
 */
export function stripImagesFromContext<C extends Context>(context: C): C {
  const messages: Message[] = context.messages.map((message) => {
    if (!messageHasImages(message)) return message;
    const content = message.content as Array<
      | { type: "text"; text?: string }
      | { type: "image"; data: string; mimeType: string }
    >;
    const next: Array<{ type: "text"; text: string }> = [];
    let previousWasPlaceholder = false;
    for (const block of content) {
      if (block.type === "image") {
        if (!previousWasPlaceholder) next.push({ type: "text", text: IMAGE_REJECTION_PLACEHOLDER });
        previousWasPlaceholder = true;
        continue;
      }
      next.push(block as { type: "text"; text: string });
      previousWasPlaceholder = false;
    }
    return { ...message, content: next } as Message;
  });
  return { ...context, messages } as C;
}

/** 状态码缺失时的兜底话术：只认明确指向图像/多模态输入的拒收措辞 */
const IMAGE_REJECTION_TEXT_PATTERN =
  /image|图片|multimodal|多模态|vision|image_url|visual/i;

/**
 * 这次失败该不该走拒图修复：流建立前的失败 + 400/422 + 请求里确有图片。
 * 不按 retriable 硬闸——分类器对无前缀的 400 body 常给乐观的 retriable（重试
 * 预算重发同一请求照样撞墙），而本修复在预算认领之前、每请求至多一次，剥错图
 * 的代价只是一次等效重试（错误原样重现并上浮）。status 取 details.providerStatus
 * （分类器从消息前缀/错误对象解析），缺失时退回 fetch 包装捕获的 capturedStatus
 * ——网关可能返回无 `400:` 前缀的 body；再缺失才退回话术匹配。429/5xx/网络层
 * 错误的 status 与话术都不命中，仍走既有重试路径。
 */
export function shouldAttemptImageRepair(
  error: ClassifiedAgentError,
  context: Context,
  capturedStatus?: number,
): boolean {
  if (!contextHasImages(context)) return false;
  const status = error.details?.providerStatus ?? capturedStatus;
  if (status === 400 || status === 422) return true;
  return status === undefined && IMAGE_REJECTION_TEXT_PATTERN.test(error.message);
}
