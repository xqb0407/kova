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

function deriveAttachments(messages: readonly ThreadMessage[]): ThreadAttachment[] {
  const byUrl = new Map<string, ThreadAttachment>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      // ThreadMessage 的 file part = FileMessagePart：data 装线上字符串
      //（data: 或 file://，同 pi-transport 的 UIMessage url 一个值）
      if (part.type !== "file") continue;
      const url = typeof part.data === "string" ? part.data : "";
      if (!url || byUrl.has(url)) continue;
      const mediaType = typeof part.mimeType === "string" ? part.mimeType : "";
      const filename = typeof part.filename === "string" ? part.filename : "";
      const kind = promptFileKind(filename || undefined, mediaType || undefined);
      byUrl.set(url, {
        url,
        name: filename || (kind === "image" ? "图片" : "附件"),
        mediaType,
        kind: kind ?? "document",
      });
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
