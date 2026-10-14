"use client";

import { SparklesIcon } from "lucide-react";
import type { FC } from "react";

/**
 * 提示词优化进行中的边框遮罩（配合 composer shell 的 data-optimizing）：
 * 这里只放**盖在内容之上**的两件东西——
 * - 边框贪吃蛇（.aui-optimize-ring：同色族长尾 + 亮头绕边跑 + 双层外发光）；
 * - 底栏状态行（不带胶囊外壳：悬浮圆角盒压在按钮行上像外来物）。
 * 卡内的淡彩流动（壁纸）不在这里：它要垫在正文下面而不是盖住正文，由
 * composer.tsx 作为 shell 的首个子节点渲染（见 .aui-optimize-flow）。
 * 遮罩层本身透明但吃点击（下层输入/按钮全部不可达），配合 ImeEnterGuard/
 * CmComposerInput 的 blocked 构成"全锁"。芯片由 [data-optimizing="true"]
 * .aui-directive-chip 的脉冲发光规则点亮——芯片不动是承诺，就让它们亮给用户看。
 * reduced-motion 时动效停住（静态渐变与静态高光边），状态行与锁定仍在。
 */
type PromptOptimizeOverlayProps = {
  onCancel: () => void;
};

export const PromptOptimizeOverlay: FC<PromptOptimizeOverlayProps> = ({
  onCancel,
}) => {
  return (
    <div
      data-slot="aui_prompt-optimize-overlay"
      className="absolute inset-0 z-20 rounded-[inherit]"
    >
      {/* 边框渐变贪吃蛇（多色长尾 + 亮头绕圈 + 外发光） */}
      <div aria-hidden className="aui-optimize-ring" />
      {/* 底部状态行：不带胶囊外壳（悬浮圆角盒压在按钮行上很像外来物），
          直接落在底栏那条带里；底栏按钮由 [data-optimizing] 规则压暗让位，
          状态行读起来就是"这一行现在在说优化进度" */}
      <div className="pointer-events-none absolute inset-x-0 bottom-2 flex items-center justify-center gap-2 text-xs">
        {/* <SparklesIcon className="animate-optimize-float text-(--color-accent) size-3.5 shrink-0" /> */}
        <span className="text-foreground/75 font-medium whitespace-nowrap">
          正在优化提示词…
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground pointer-events-auto shrink-0 cursor-pointer rounded-full px-1.5 py-0.5 whitespace-nowrap underline-offset-2 transition-colors hover:underline"
        >
          取消
        </button>
      </div>
    </div>
  );
};
