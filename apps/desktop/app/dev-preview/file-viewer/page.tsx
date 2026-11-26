"use client";

/**
 * FileViewer 集成验收页（浏览器，不接真实桌面桥）。
 *
 * 用内存里的假 kovaHost 提供 fs_read_file / fs_write_file，把真实 FileViewer
 * 挂起来：验证「预览 / 编辑 / 源码」三段、富文本挂载、自动保存、外部重载、
 * 目录与状态行。右侧显示磁盘内容，可模拟外部修改。
 *
 * 跑法：cd apps/desktop && bun run dev
 *      → http://localhost:3000/dev-preview/file-viewer
 */

import { useEffect, useState } from "react";
import { FileViewer } from "@/components/files/file-viewer";
import { Button } from "@/components/ui/button";

const FIXTURE = `---
title: 集成验收
---

# 集成验收

这是**富文本编辑**的集成测试。

## 目录一

- 第一项
- 第二项

## 目录二

- [ ] 待办
- [x] 已完成

\`\`\`ts
const answer = 42;
\`\`\`

| A | B |
| --- | --- |
| 1 | 2 |

结尾。
`;

const EXTERNAL = `---
title: 集成验收
---

# 外部修改

这份内容由「模拟外部修改」按钮写入，用来验证 watcher 重载不会覆盖正在编辑的草稿。
`;

const INCOMPATIBLE = `# 不兼容语法

<details>
<summary>裸 HTML</summary>
富文本不支持这段结构。
</details>
`;

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
  // isDesktop() 只看标记是否存在；这里给 dev-preview 一个假宿主
  (window as unknown as { __KOVA_DESKTOP__?: unknown }).__KOVA_DESKTOP__ = true;
  (window as unknown as { kovaHost?: unknown }).kovaHost = {
    async invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === "fs_read_file") {
        return {
          ok: true,
          value: { content, truncated: false, binary: false },
        };
      }
      if (cmd === "fs_write_file") {
        const base64 = String(args.base64 ?? "");
        publish(decodeBase64(base64));
        return { ok: true, value: null };
      }
      if (cmd === "bridge_dialog_open") {
        return { ok: true, value: "/mock/picked file (1).png" };
      }
      if (cmd === "library_import") {
        return {
          ok: true,
          value: {
            imported: ["picked file (1).png"],
            renamed: [],
            failed: [],
          },
        };
      }
      return { ok: true, value: null };
    },
    eventsOn() {},
    channelsOn() {},
  };
}

export default function FileViewerPreviewPage() {
  const [saved, setSaved] = useState(content);
  const [reloadSignal, setReloadSignal] = useState(0);

  useEffect(() => {
    const listener = (text: string) => setSaved(text);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const externalEdit = () => {
    publish(EXTERNAL);
    setReloadSignal((n) => n + 1);
  };

  const incompatible = () => {
    publish(INCOMPATIBLE);
    setReloadSignal((n) => n + 1);
  };

  const reset = () => {
    publish(FIXTURE);
    setReloadSignal((n) => n + 1);
  };

  return (
    <div className="bg-background flex h-dvh flex-col">
      <header className="border-border/60 flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">FileViewer 集成验收</h1>
          <p className="text-muted-foreground text-xs">
            所见即所得 · 自动保存 · 外部重载 · 目录
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={externalEdit}>
          模拟外部修改
        </Button>
        <Button variant="outline" size="sm" onClick={incompatible}>
          不兼容内容
        </Button>
        <Button variant="outline" size="sm" onClick={reset}>
          重置
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <FileViewer
          className="min-w-0 flex-1"
          cwd="/mock/library"
          rel="demo.md"
          name="demo.md"
          metaEnabled
          reloadSignal={reloadSignal}
          onRenamed={() => {}}
        />
        <aside className="border-border/60 flex w-[360px] shrink-0 flex-col border-l">
          <div className="text-muted-foreground border-border/60 shrink-0 border-b px-3 py-2 text-xs">
            假磁盘内容
          </div>
          <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
            {saved}
          </pre>
        </aside>
      </div>
    </div>
  );
}
