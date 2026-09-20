"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAui, type ThreadMessage } from "@assistant-ui/react";
import { promptFileKind } from "@/lib/prompt-attachments";

/**
 * 会话「引用文件」派生层（活动面板数据源）：扫描当前线程所有 user 消息的
 * file parts——用户粘贴 / 附件按钮上传的图片与文档。与 panel-activity
 * （工具调用流水）互补：附件在 user 消息里而非 tool-call，单独成源。
 *
 * url 两种形态：file://（dialog 直选，可重新打开预览）与 data:（粘贴，内容
 * 随消息转录取存）。按 url 去重（同一份文件多次粘贴只算一条），按聊天时间线
 * 排序。user 消息 parts 是静态的，派生按 messages 引用 memo，流式期间重扫
 * 代价可忽略（只过 user 角色）。
 */

export type ThreadAttachment = {
  /** file part url（file:// 或 data:），去重键 */
  url: string;
  name: string;
  mediaType: string;
  kind: "image" | "document";
};

function pushAttachment(
  byUrl: Map<string, ThreadAttachment>,
  wire: unknown,
  mimeType: unknown,
  filename: unknown,
): void {
  // data 装线上字符串（data: / file://），同 pi-transport 的 UIMessage url 一个值
  const url = typeof wire === "string" && wire ? wire : "";
  if (!url || byUrl.has(url)) return;
  const mediaType = typeof mimeType === "string" ? mimeType : "";
  const name = typeof filename === "string" && filename ? filename : "";
  const kind = promptFileKind(name || undefined, mediaType || undefined);
  byUrl.set(url, {
    url,
    name: name || (kind === "image" ? "图片" : "附件"),
    mediaType,
    kind: kind ?? "document",
  });
}

function deriveAttachments(messages: readonly ThreadMessage[]): ThreadAttachment[] {
  const byUrl = new Map<string, ThreadAttachment>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    // 主源：ThreadUserMessage.attachments（composer 附件挂这里，content parts
    // 里的 file part 会被转换层过滤掉——消息区附件 chip 就从这渲染）
    const attachments = (message as { attachments?: readonly unknown[] })
      .attachments;
    for (const att of attachments ?? []) {
      const a = att as {
        name?: unknown;
        contentType?: unknown;
        content?: readonly { type?: unknown; data?: unknown; mimeType?: unknown; filename?: unknown }[];
      };
      const filePart = (a.content ?? []).find((p) => p?.type === "file");
      pushAttachment(
        byUrl,
        filePart?.data ?? null,
        filePart?.mimeType ?? a.contentType ?? null,
        filePart?.filename ?? a.name ?? null,
      );
    }
    // 兜底：任何保留在 content parts 里的 file part（历史重建管道形状不保证）
    for (const part of message.content) {
      if (part.type !== "file") continue;
      const p = part as { data?: unknown; mimeType?: unknown; filename?: unknown };
      pushAttachment(byUrl, p.data, p.mimeType, p.filename);
    }
  }
  return [...byUrl.values()];
}

/** 订阅当前线程用户上传的附件清单（引用文件区） */
export function useThreadAttachments(): ThreadAttachment[] {
  const aui = useAui();
  const getSnapshot = useCallback(
    () => aui.thread.getState().messages,
    [aui],
  );
  const messages = useSyncExternalStore(aui.subscribe, getSnapshot, () => []);
  return useMemo(() => deriveAttachments(messages), [messages]);
}
