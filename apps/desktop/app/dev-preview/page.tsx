"use client";

/**
 * 【临时验证页,验证后删除】
 * 「我的文件」预览弹窗两种渲染分支的实际效果:
 * 左 = .md 文件(MarkdownText 整篇渲染分支,含 frontmatter 卡片)
 * 右 = 代码文件(CodeMirrorCode,height 内部滚动)
 */

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { CodeMirrorCode } from "@/components/code/cm-code";

const MD_SAMPLE = `---
title: 产品需求文档
tags: [v2, 队列]
status: draft
---

# 队列 v2 设计说明

## 概述

支持 **加粗**、*斜体*、\`行内代码\`、[链接](https://example.com)。

## 特性列表

- [x] 默认排队
- [x] 并入当前轮
- [ ] 立即发送
- [ ] 删除排队项

## 参数表

| 参数 | 类型 | 说明 |
| ---- | ---- | ---- |
| mode | string | 发送模式 |
| retry | number | 重试次数 |

## 代码示例

\`\`\`ts
export function enqueue(item: Task) {
  queue.push({ ...item, at: Date.now() });
}
\`\`\`

> 引用块:排队项在暂停闸开启时不会进入当前轮。

$$E = mc^2$$
`;

const TS_SAMPLE = `import { invoke } from "@tauri-apps/api/core";

/** 队列条目:一次待发送的用户输入 */
export interface QueueEntry {
  id: string;
  text: string;
  createdAt: number;
}

export async function listQueued(threadId: string): Promise<QueueEntry[]> {
  const r = await invoke<{ entries: QueueEntry[] }>("queue_list", { threadId });
  return r.entries;
}

export function formatEta(ms: number): string {
  if (ms < 60_000) return \`\${Math.round(ms / 1000)}s\`;
  return \`\${Math.floor(ms / 60_000)}m \${Math.round((ms % 60_000) / 1000)}s\`;
}
`.repeat(6);

export default function DevPreviewPage() {
  return (
    <div className="bg-background text-foreground min-h-screen p-8">
      <h1 className="mb-4 text-lg font-semibold">「我的文件」预览效果验证</h1>
      <div className="grid grid-cols-2 gap-6">
        <section>
          <h2 className="text-muted-foreground mb-2 text-sm">.md → Markdown 渲染</h2>
          <div className="aui-markdown max-h-[72vh] overflow-y-auto rounded-md border p-5">
            <MarkdownText text={MD_SAMPLE} />
          </div>
        </section>
        <section>
          <h2 className="text-muted-foreground mb-2 text-sm">.ts → CodeMirror 高亮</h2>
          <CodeMirrorCode
            value={TS_SAMPLE}
            path="queue.ts"
            height="72vh"
            className="rounded-md border"
          />
        </section>
      </div>
    </div>
  );
}
