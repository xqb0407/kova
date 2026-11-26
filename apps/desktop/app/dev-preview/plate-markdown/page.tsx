"use client";

/**
 * Plate 编辑器验收页：直接挂载资料库用的 PlateMarkdownEditor，
 * 验证 Markdown 往返、自动回写、工具栏、斜杠菜单、浮动工具栏与块拖拽。
 */

import { useRef, useState } from "react";
import { PlateMarkdownEditor } from "@/components/files/plate-editor/markdown-editor";

const FIXTURE_RAW = `---
title: Plate 验收
---

# Plate 标题

这是**加粗**、*斜体*、~~删除线~~、\`行内代码\`。

## 二级标题

> 引用一段话。

- 第一项
- 第二项

1. 第一步
2. 第二步

- [ ] 待办
- [x] 已完成

\`\`\`ts
const answer = 42;
\`\`\`

| A | B |
| --- | --- |
| 1 | 2 |

[链接](https://example.com)

---

结尾段落。
`;

export default function PlateMarkdownPreviewPage() {
  const [value, setValue] = useState(FIXTURE_RAW);
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="bg-background flex h-dvh flex-col">
      <header className="border-border/60 flex shrink-0 items-center border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Plate 验收</h1>
          <p className="text-muted-foreground text-xs">
            块 / 列表 / 代码 / 表格 / 图片 / 工具栏 / 斜杠 / 拖拽
          </p>
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {value.length} 字符
        </span>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <PlateMarkdownEditor
          value={value}
          cwd=""
          rel=""
          scrollContainerRef={scrollRef}
          onChange={setValue}
        />
      </div>
    </div>
  );
}
