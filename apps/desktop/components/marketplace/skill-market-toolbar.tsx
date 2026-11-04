"use client";

/**
 * 技能/MCP 市场共用的工具行：搜索框 + 可选说明 + 右端控件组
 * （排序等自定义控件 → 源切换 → 刷新）。
 *
 * 抽出来的目的：三个技能面板与 MCP 市场的工具行原本各写一份，源切换在不同
 * 面板里位置不一致，切源时控件会横跳。这里固定右端顺序，保证视觉稳定。
 */
import type { FC, ReactNode } from "react";
import { RefreshCwIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  SkillSourceSelect,
  type SkillSource,
} from "@/components/marketplace/skill-source-select";

export const SkillMarketToolbar: FC<{
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  loading: boolean;
  onRefresh: () => void;
  refreshTitle?: string;
  /** 排序、添加仓库等自定义控件，排在源切换左边 */
  children?: ReactNode;
  /** 搜索框右侧的说明文字（如「仅 HTTPS 远程」） */
  hint?: string;
  /** 技能源的切换；不传则不显示（如 MCP 市场只有官方 Registry） */
  source?: SkillSource;
  onSourceChange?: (next: SkillSource) => void;
  inputClassName?: string;
}> = ({
  query,
  onQueryChange,
  placeholder,
  ariaLabel,
  loading,
  onRefresh,
  refreshTitle,
  children,
  hint,
  source,
  onSourceChange,
  inputClassName,
}) => (
  <div className="flex flex-wrap items-center gap-2">
    <div className="relative">
      <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input
        className={cn("bg-muted/50 h-8 w-64 pl-8", inputClassName)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
    </div>
    {hint && (
      <span className="text-muted-foreground hidden text-xs sm:inline">{hint}</span>
    )}
    <div className="ml-auto flex items-center gap-1.5">
      {children}
      {source && onSourceChange && (
        <SkillSourceSelect value={source} onChange={onSourceChange} />
      )}
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground size-8"
        disabled={loading}
        onClick={onRefresh}
        aria-label="刷新"
        title={refreshTitle ?? "刷新目录"}
      >
        <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
      </Button>
    </div>
  </div>
);
