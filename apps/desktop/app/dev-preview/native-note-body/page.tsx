"use client";

/**
 * NativeNoteBody 集成验收页：用内存假宿主挂真实 FileViewer，
 * 验证 `.knote` 解析、Plate 编辑、自动保存回写 envelope、外部重载。
 */

import { useEffect, useState } from "react";
import { FileViewer } from "@/components/files/file-viewer";
import { Button } from "@/components/ui/button";
import { nativeNoteFromMarkdown } from "@/lib/notes/native-markdown";
import {
  serializeNativeNote,
  type NativeNoteFile,
} from "@/lib/notes/native-note";

const BASE = {
  ...nativeNoteFromMarkdown({
    title: "原生集成验收",
    markdown: `# 原生集成验收

这是 **.knote envelope** 直接驱动的正文。

## 表格

| A | B |
| --- | --- |
| 1 | 2 |

## 收尾

改这段文字，右侧应看到 JSON 里的 blocks / markdown 缓存同步更新。
`,
  }),
  // 预览 fixture 必须是确定性的：createNativeNote 默认用 crypto.randomUUID()
  // 和当前时间，服务端渲染与客户端 hydration 各生成一份会让 <pre> 里的
  // JSON 文本不一致，Next dev 报 hydration mismatch。
  id: "dev-preview-native-note",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const FIXTURE = serializeNativeNote(BASE);

function externalNote(base: NativeNoteFile): string {
  const next = nativeNoteFromMarkdown({
    title: "外部修改",
    markdown: `# 外部修改

这份内容由「模拟外部修改」写入，用来验证 watcher 重载。
`,
  });
  return serializeNativeNote({ ...next, id: base.id });
}

const listeners = new Set<(text: string) => void>();
let content = FIXTURE;

function publish(text: string): void {
  content = text;
  for (const listener of listeners) listener(text);
}

function decodeBase64(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

if (typeof window !== "undefined") {
  (window as unknown as { __KOVA_DESKTOP__?: unknown }).__KOVA_DESKTOP__ = true;
  (window as unknown as { kovaHost?: unknown }).kovaHost = {
    async invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === "fs_read_file") {
        return {
          ok: true,
          value: { content, truncated: false, binary: false },
        };
      }
      if (cmd === "fs_read_file_base64") {
        return {
          ok: true,
          value: { base64: btoa(unescape(encodeURIComponent(content))), size: content.length },
        };
      }
      if (cmd === "fs_write_file") {
        publish(decodeBase64(String(args.base64 ?? "")));
        return { ok: true, value: null };
      }
      if (cmd === "fs_rename") return { ok: true, value: null };
      if (cmd === "library_file_meta_get") return { ok: true, value: null };
      if (cmd === "library_import") {
        return {
          ok: true,
          value: { imported: ["picked.png"], renamed: [], failed: [] },
        };
      }
      if (cmd === "bridge_dialog_open") {
        return { ok: true, value: "/mock/picked.png" };
      }
      return { ok: true, value: null };
    },
    eventsOn() {},
    channelsOn() {},
  };
}

export default function NativeNoteBodyPreviewPage() {
  const [saved, setSaved] = useState(content);
  const [reloadSignal, setReloadSignal] = useState(0);

  useEffect(() => {
    const listener = (text: string) => setSaved(text);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <div className="bg-background flex h-dvh flex-col">
      <header className="border-border/60 flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">NativeNoteBody 集成验收</h1>
          <p className="text-muted-foreground text-xs">
            .knote 解析 · 自动保存 · envelope 回写 · 外部重载 · 损坏保护
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            publish(externalNote(BASE));
            setReloadSignal((n) => n + 1);
          }}
        >
          模拟外部修改
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            publish("{broken json");
            setReloadSignal((n) => n + 1);
          }}
        >
          模拟损坏
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            publish(FIXTURE);
            setReloadSignal((n) => n + 1);
          }}
        >
          重置
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <FileViewer
          className="min-w-0 flex-1"
          cwd="/mock/library"
          rel="demo.knote"
          name="demo.knote"
          metaEnabled
          reloadSignal={reloadSignal}
          onRenamed={() => {}}
        />
        <aside className="border-border/60 flex w-[360px] shrink-0 flex-col border-l">
          <div className="text-muted-foreground border-border/60 shrink-0 border-b px-3 py-2 text-xs">
            假磁盘内容（.knote JSON）
          </div>
          <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
            {saved}
          </pre>
        </aside>
      </div>
    </div>
  );
}
