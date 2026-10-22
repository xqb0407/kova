"use client";

import type { FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  removeLibraryDirectives,
} from "@/lib/composer/library-reference";
import {
  useMissingLibraryRefs,
} from "@/lib/workspace/library-ref-guard";

/**
 * 失效资料库引用条（composer 区，审批卡同族）：草稿守卫检出引用的文件已
 * 不存在（系统删除/移动、应用内删除后未移除引用）时出现。
 *
 * 只拦截、不自动改写草稿——「移除失效引用」一键精确删掉对应芯片，其余正文
 * 原样保留；用户也可以自己退格删芯片。发送路径（Enter / 发送按钮）在存在
 * 失效引用时统一拦截，防止把死路径发给模型。
 */

const MAX_LABELS = 3;

export const MissingReferencesBar: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const missing = useMissingLibraryRefs(threadId);
  const aui = useAui();
  if (missing.length === 0) return null;

  const labels = missing
    .slice(0, MAX_LABELS)
    .map((item) => item.label || item.rel)
    .join("、");
  const suffix = missing.length > MAX_LABELS ? ` 等 ${missing.length} 个` : "";

  const remove = () => {
    try {
      const text = aui.composer.getState().text ?? "";
      aui.composer.setText(
        removeLibraryDirectives(text, new Set(missing.map((m) => m.id))),
      );
    } catch {
      toast.error("移除失败，请手动删除输入框里的引用");
    }
  };

  return (
    <div
      role="status"
      data-slot="missing-references-bar"
      className="border-amber-500/40 bg-amber-500/10 text-foreground mx-0.5 mb-2 flex w-full items-center gap-2 rounded-lg border px-3 py-2"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {missing.length} 个引用已失效（文件可能已被移动或删除）：{labels}
        {suffix}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={remove}
      >
        移除失效引用
      </Button>
    </div>
  );
};
