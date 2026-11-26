"use client";

/**
 * 原生笔记验收页：直接挂载 NativeNoteEditor，验证 envelope blocks 加载、
 * 工具栏/斜杠/表格、图标与标题编辑。
 */

import { useRef, useState } from "react";
import { NativeNoteEditor } from "@/components/files/plate-editor/native-note-editor";
import { nativeNoteFromMarkdown } from "@/lib/notes/native-markdown";

const FIXTURE = `# 原生笔记

这是 **Plate Value 直接落盘** 的正文，不经过 Markdown 往返。

## 待办

- [ ] 合并单元格
- [x] 单元格背景

| 功能 | 状态 |
| --- | --- |
| 表格 | 基础可用 |
| callout | 下一阶段 |

\`\`\`ts
const note = { format: "kova-note" };
\`\`\`
`;

export default function NativeNotePreviewPage() {
  const [note] = useState(() =>
    nativeNoteFromMarkdown({ title: "原生笔记", markdown: FIXTURE }),
  );
  const [blocks, setBlocks] = useState(note.blocks);
  const [title, setTitle] = useState(note.title);
  const [icon, setIcon] = useState<string | null>(note.icon ?? "📝");
  const [markdown, setMarkdown] = useState(note.markdown);
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="bg-background flex h-dvh flex-col">
      <header className="border-border/60 flex shrink-0 items-center border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">原生笔记验收</h1>
          <p className="text-muted-foreground text-xs">
            .knote envelope / 块编辑 / 表格 / 图标 / 标题
          </p>
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {blocks.length} blocks · {markdown.length} md
        </span>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <NativeNoteEditor
          blocks={blocks}
          cwd=""
          rel=""
          title={title}
          onRename={async (next) => {
            setTitle(next);
            return true;
          }}
          icon={icon}
          onIconChange={setIcon}
          onChange={(nextBlocks, nextMarkdown) => {
            setBlocks(nextBlocks);
            setMarkdown(nextMarkdown);
          }}
        />
      </div>
    </div>
  );
}
