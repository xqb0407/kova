"use client";

/**
 * Markdown → 原生笔记迁移验收页：内存假宿主模拟资料库 fs / scan / 别名命令，
 * 验证备份、转换、跳过不兼容、目标冲突不覆盖、marker 与报告。
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  markdownMigrationStatus,
  migrateMarkdownToNative,
  MARKDOWN_MIGRATION_MARKER,
  type MigrationReport,
} from "@/lib/notes/migrate-markdown";

const FILES = new Map<string, string>([
  [
    "docs/guide.md",
    `---
title: 指南
tags: [docs]
---

# 指南

这是普通 Markdown，迁移后应保持标题/列表/表格。

| A | B |
| --- | --- |
| 1 | 2 |
`,
  ],
  [
    "docs/incompatible.md",
    `# 不兼容

<details>
<summary>裸 HTML</summary>
这段无法交给富文本。
</details>
`,
  ],
  ["notes/plain.md", "只有一行正文。\n"],
  ["notes/collision.md", "# 冲突\n\n同名 .knote 已存在时不能覆盖。\n"],
  ["notes/collision.knote", '{"format":"kova-note","version":1}\n'],
]);

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToText(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

if (typeof window !== "undefined") {
  (window as unknown as { __KOVA_DESKTOP__?: unknown }).__KOVA_DESKTOP__ = true;
  (window as unknown as { kovaHost?: unknown }).kovaHost = {
    async invoke(cmd: string, args: Record<string, unknown>) {
      const path = String(args.path ?? args.rel ?? "");
      if (cmd === "fs_read_file") {
        const text = FILES.get(path);
        if (text === undefined) return { ok: false, error: "not-found" };
        return {
          ok: true,
          value: { content: text, truncated: false, binary: false },
        };
      }
      if (cmd === "fs_read_file_base64") {
        const text = FILES.get(path);
        if (text === undefined) return { ok: false, error: "not-found" };
        return {
          ok: true,
          value: { base64: textToBase64(text), size: text.length },
        };
      }
      if (cmd === "fs_write_file" || cmd === "fs_write_file_base64") {
        const base64 = String(args.base64 ?? "");
        FILES.set(path, cmd === "fs_write_file" ? base64ToText(base64) : base64ToText(base64));
        return { ok: true, value: null };
      }
      if (cmd === "fs_delete") {
        FILES.delete(path);
        return { ok: true, value: null };
      }
      if (cmd === "library_scan") {
        return {
          ok: true,
          value: {
            truncated: false,
            entries: [...FILES.keys()]
              .sort()
              .filter((rel) => !rel.startsWith(".kova/"))
              .map((rel) => ({
                rel,
                name: rel.split("/").pop() ?? rel,
                size: FILES.get(rel)?.length ?? 0,
                modified: null,
              })),
          },
        };
      }
      return { ok: true, value: null };
    },
    eventsOn() {},
    channelsOn() {},
  };
}

export default function MarkdownMigrationPreviewPage() {
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [status, setStatus] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [version, setVersion] = useState(0);

  const refresh = async () => {
    setStatus(JSON.stringify(await markdownMigrationStatus("/mock/library")));
    setVersion((n) => n + 1);
  };

  return (
    <div className="bg-background flex h-dvh flex-col">
      <header className="border-border/60 flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Markdown 迁移验收</h1>
          <p className="text-muted-foreground text-xs">
            备份 / 转换 / 跳过 / 冲突 / marker
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          查看状态
        </Button>
        <Button
          size="sm"
          disabled={running}
          onClick={() => {
            setRunning(true);
            void migrateMarkdownToNative("/mock/library", {
              onProgress: ({ done, total, currentRel }) =>
                setStatus(`${done}/${total} ${currentRel ?? ""}`),
            })
              .then((r) => {
                setReport(r);
                void refresh();
              })
              .finally(() => setRunning(false));
          }}
        >
          {running ? "迁移中…" : "开始迁移"}
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <div className="min-h-0 overflow-auto border-r p-3">
          <div className="text-muted-foreground mb-1 text-xs">状态</div>
          <pre className="mb-3 text-xs whitespace-pre-wrap">{status}</pre>
          <div className="text-muted-foreground mb-1 text-xs">文件（{version}）</div>
          <pre className="text-xs whitespace-pre-wrap">
            {[...FILES.keys()].sort().join("\n")}
          </pre>
        </div>
        <div className="min-h-0 overflow-auto p-3">
          <div className="text-muted-foreground mb-1 text-xs">迁移报告</div>
          <pre className="text-xs whitespace-pre-wrap">
            {report ? JSON.stringify(report, null, 2) : "尚未迁移"}
          </pre>
          <div className="text-muted-foreground mt-3 mb-1 text-xs">Marker</div>
          <pre className="text-xs whitespace-pre-wrap">
            {FILES.get(MARKDOWN_MIGRATION_MARKER) ?? "（无）"}
          </pre>
        </div>
      </div>
    </div>
  );
}
