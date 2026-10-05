import { generateId, type AttachmentAdapter } from "@assistant-ui/react";
import {
  PROMPT_ATTACHMENT_ACCEPT,
  docMimeFromName,
  imageMimeFromName,
  promptFileKind,
  promptFileKindFromName,
} from "./prompt-attachments";

// Uint8Array → base64（分段 btoa，避免大文件展开超调用栈）——与 prompt-attachments 同款
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Pi 链路的 composer AttachmentAdapter（File 入口：粘贴、网页端文件选择）。
 *
 * 它有两个职责：
 * 1. 让 `composer.addAttachment(File)` 真正可用——ExternalStoreRuntime 的
 *    composer 对 File 调 `adapter.add` 拿 Pending、发送前调 `adapter.send`
 *    换成 Complete，没有 adapter 时整条 File 路径抛「Attachments are not
 *    supported」（被各入口的 catch 吞掉，表现为粘贴无反应）。
 * 2. 打开 `thread.capabilities.attachments`——ExternalStoreThreadRuntimeCore
 *    按 `!!store.adapters?.attachments` 推导该能力，cm-composer-input 的粘贴
 *    闸门吃的就是它。react-pi 迁移后 runtime 不再内置 attachments 支持，
 *    能力恒 false、粘贴静默丢文件，即源于此。
 *
 * **add 直接返回 complete（带 content）**——这是排队链路的关键约束，别改回
 * 「requires-action + send 里读文件」（2026-10-05「排队消息多出一条已发送气泡」
 * 根因）：附件不完整时，composer 的 send 走**异步准备提交**（_prepareSubmission
 * → _dispatch(isSubmission=true)），框架会把这条提交登记进 composer 的
 * in-transit 台账，而 @assistant-ui/core 的 store 层把 in-transit 提交
 * **当作线程消息渲染**（store/clients/submission-message.js，id = 草稿 id）。
 * 直接发送时它随回显落位消失；**排队发送时那条 user 行要等队列派发才出现，
 * 于是气泡永久挂在队列条旁边，删队列行也撤不回**。纯文本与 dialog 直选文档
 * 都是同步提交（不登记 in-transit），所以只有粘贴/拖入的图片看着有病。
 * 立即内联的代价是粘贴瞬间读一次文件（≤2MiB 图 / 网页端 ≤8MiB 文档，桌面端
 * 文档走 dialog 对象形态不经过这里），换来发送路径同步、状态单一。
 *
 * content 的形状对齐 ThreadController.buildPiSendInput 的消费契约：
 * - 图片：[{type:"image", image: dataURL}] → toImageContent 解出裸 base64，
 *   内联进 prompt attachments（多模态上下文）；
 * - 文档：[{type:"file", data: dataURL, mimeType, filename}] → pi-client-base
 *   识别 data: 后原样交给 extractPromptAttachments——桌面端 attachment_stage
 *   落盘中转只带路径，网页端回退内联 base64。
 * 种类/大小前置校验仍在各添加入口（validatePromptFile），add 里的判类只是
 * 最后一道防线；dialog 直选的 file:// 路径对象（addAttachment 对象形态）不过
 * add/send，但 adapter 就位后同样过 accept 闸，故 accept 用白名单同源串，
 * 扩展名与 MIME 双保险。
 */
export const piPromptAttachmentAdapter: AttachmentAdapter = {
  accept: PROMPT_ATTACHMENT_ACCEPT,
  async add({ file }) {
    // file.type 可带参数（text/plain;charset=utf-8）且白名单是全等匹配，
    // 必须剥参归一后再判类与进载荷，否则带参 MIME 过不了白名单、
    // 进协议后 sidecar 端同样拒收
    const baseMime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
    // 无 MIME 的剪贴板图片只能按扩展名判类（promptFileKind 认图只认 MIME，
    // 扩展名那条路只兜文档——见 prompt-attachments 的 FromName 注释）
    const kind = baseMime
      ? promptFileKind(file.name, baseMime)
      : promptFileKindFromName(file.name);
    if (!kind) {
      throw new Error(`「${file.name || "文件"}」不是支持的附件`);
    }
    const mimeRaw =
      baseMime ||
      (kind === "image" ? imageMimeFromName(file.name) : docMimeFromName(file.name)) ||
      "application/octet-stream";
    const mime = mimeRaw === "image/jpg" ? "image/jpeg" : mimeRaw;
    const name = file.name || (kind === "image" ? "image" : "attachment");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
    const content =
      kind === "image"
        ? [{ type: "image" as const, image: dataUrl }]
        : [
            {
              type: "file" as const,
              data: dataUrl,
              mimeType: mime,
              filename: name,
            },
          ];
    // 类型上 add 的契约是 PendingAttachment（status 非 complete），运行时
    // upsertAttachment/isAttachmentComplete 只看 status.type——这里刻意越过
    // 契约返回 complete，理由见头注（排队幽灵气泡）；改回 pending 会让
    // 「带图排队消息多一条已发送气泡」复现
    return {
      id: generateId(),
      type: kind,
      name,
      contentType: mime,
      file,
      status: { type: "complete" as const },
      content,
    } as unknown as ReturnType<AttachmentAdapter["add"]> extends Promise<infer T>
      ? T
      : never;
  },
  // 兜底 send（complete 附件不会被框架调用，见头注）：把 File 读成 content。
  // 保留这份实现是防「某天又回到延迟准备路径」时内容不丢
  async send(attachment, options) {
    const abort = () => {
      const error = new Error("附件读取已取消");
      error.name = "AbortError";
      return error;
    };
    if (options?.signal?.aborted) throw abort();
    const bytes = new Uint8Array(await attachment.file.arrayBuffer());
    if (options?.signal?.aborted) throw abort();
    const mime = attachment.contentType ?? "application/octet-stream";
    const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
    const content =
      attachment.type === "image"
        ? [{ type: "image" as const, image: dataUrl }]
        : [
            {
              type: "file" as const,
              data: dataUrl,
              mimeType: mime,
              filename: attachment.name,
            },
          ];
    return { ...attachment, status: { type: "complete" as const }, content } as unknown as Awaited<
      ReturnType<AttachmentAdapter["send"]>
    >;
  },
  async remove() {
    // File 全在前端内存，无远端副作用可撤
  },
};

/**
 * 挂进 usePiRuntime options 的 adapters 字段（store 会原样透传给
 * ExternalStoreRuntime）。模块级稳定引用：store 的 useMemo 把 adapters 列为
 * 依赖，每渲染新建对象会让 store（乃至 runtime 内部状态）每渲染重建。
 */
export const piRuntimeAdapters = {
  attachments: piPromptAttachmentAdapter,
} as const;
