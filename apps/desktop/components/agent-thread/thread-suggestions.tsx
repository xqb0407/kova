"use client";

/**
 * 新会话欢迎建议（composer 为空时显示在输入框下方）。
 *
 * 结构：分组胶囊（横向滚动）→ 点开展开该组的提示词胶囊 → 点击直发。
 * 内容对齐产品实际能力（编码 / 插件 / 技能 / 研究 / 写作），随产品演进维护
 * 这份静态清单即可；纯前端动作，无额外请求。
 */
import { useState, type FC, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAui } from "@assistant-ui/react";
import {
  ChartColumnIcon,
  CodeXmlIcon,
  LightbulbIcon,
  PencilLineIcon,
  PuzzleIcon,
} from "lucide-react";

type SuggestionGroup = {
  label: string;
  icon: ReactNode;
  options: { label: string; prompt: string }[];
};

const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    label: "写代码",
    icon: <CodeXmlIcon />,
    options: [
      { label: "解释这段代码", prompt: "逐段解释当前打开文件里的核心逻辑，指出潜在问题" },
      { label: "写一个防抖函数", prompt: "用 TypeScript 写一个带立即执行选项的 debounce 函数，附使用示例" },
      { label: "审查未提交改动", prompt: "审查当前仓库未提交的改动，按严重程度列出问题和建议" },
      { label: "补单元测试", prompt: "为最近改动的模块补充单元测试，覆盖边界情况" },
    ],
  },
  {
    label: "插件",
    icon: <PuzzleIcon />,
    options: [
      { label: "做一个技能插件", prompt: "帮我创建一个「会议纪要整理」技能插件，生成后告诉我怎么安装" },
      { label: "看看市场里有什么", prompt: "列出已添加的插件市场和可安装的插件，推荐一个适合写代码的" },
      { label: "管理已装插件", prompt: "列出当前已安装的插件和它们的组件，指出哪些长期没用了" },
    ],
  },
  {
    label: "分析",
    icon: <ChartColumnIcon />,
    options: [
      { label: "项目结构总览", prompt: "梳理当前仓库的目录结构和技术栈，画出模块依赖关系" },
      { label: "对比技术选型", prompt: "用表格对比 React、Vue、Svelte 的优缺点和适用场景" },
      { label: "找出性能瓶颈", prompt: "分析当前项目里可能的性能瓶颈，给出排查步骤" },
    ],
  },
  {
    label: "写作",
    icon: <PencilLineIcon />,
    options: [
      { label: "写周报", prompt: "根据本周的 git 提交记录，帮我起草一份周报" },
      { label: "写发布说明", prompt: "为最近的改动写一段面向用户的发布说明" },
      { label: "写 PR 描述", prompt: "为当前改动写一份 PR 描述：改动点、动机、影响面" },
    ],
  },
  {
    label: "灵感",
    icon: <LightbulbIcon />,
    options: [
      { label: "头脑风暴", prompt: "头脑风暴五个适合独立开发者的小工具创意，说明切入点" },
      { label: "给产品起名", prompt: "为一个 AI 编程助手产品起十个名字，每个附一句理由" },
    ],
  },
];

const suggestionChipClass =
  "aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors [&_svg]:size-4";

export const ThreadSuggestions: FC = () => {
  const aui = useAui();
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const expandedGroup = SUGGESTION_GROUPS.find(
    (group) => group.label === expandedLabel,
  );

  /** 填入输入框而不直发：用户可改完再发（与排队条回填/自动化页同款 setText） */
  const fillComposer = (prompt: string) => {
    if (aui.thread.getState().isRunning) return;
    aui.composer.setText(prompt);
  };

  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col gap-2 px-4">
      <div className="w-full scrollbar-none overflow-x-auto">
        <div className="mx-auto flex w-max items-center gap-2">
          {SUGGESTION_GROUPS.map((group) => (
            <Button
              key={group.label}
              variant="ghost"
              className={cn(
                suggestionChipClass,
                group.label === expandedLabel && "bg-muted",
              )}
              onClick={() =>
                setExpandedLabel(
                  group.label === expandedLabel ? null : group.label,
                )
              }
            >
              {group.icon}
              {group.label}
            </Button>
          ))}
        </div>
      </div>
      {expandedGroup && (
        <div
          key={expandedGroup.label}
          className="fade-in slide-in-from-top-1 animate-in w-full scrollbar-none overflow-x-auto duration-200"
        >
          <div className="mx-auto flex w-max items-center gap-2">
            {expandedGroup.options.map((option) => (
              <Button
                key={option.label}
                variant="ghost"
                className={suggestionChipClass}
                onClick={() => fillComposer(option.prompt)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
