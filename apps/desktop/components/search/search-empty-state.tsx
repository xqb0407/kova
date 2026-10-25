"use client";

/**
 * 空态视觉：monocode 同款「点阵云 + 毛玻璃图标」。
 *
 * 点阵用**单个元素**的 radial-gradient 平铺实现，而不是 513 个 span——
 * 视觉等价（10px 步距 / 3px 圆点 / 径向渐隐 mask），但 DOM 节点从 513 个
 * 降到 1 个，打开搜索页时的首帧挂载成本基本归零。
 */
import { memo, type FC } from "react";
import { SearchIcon, SearchXIcon } from "lucide-react";

const DotCloud: FC = memo(function DotCloud() {
  return (
    <div
      aria-hidden
      className="h-48 w-72 text-foreground opacity-[0.14] [mask-image:radial-gradient(ellipse_72%_68%_at_50%_50%,#000_18%,transparent_76%)]"
      style={{
        backgroundImage:
          "radial-gradient(circle, currentColor 1.5px, transparent 1.5px)",
        backgroundSize: "10px 10px",
        backgroundPosition: "5px 5px",
      }}
    />
  );
});

/** 默认页缺省（空查询且无最近内容） */
export const SearchEmptyState: FC = memo(function SearchEmptyState() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 pb-24">
      <div className="relative mb-2 grid place-items-center">
        <DotCloud />
        <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
          <SearchIcon
            className="size-6 text-muted-foreground/70"
            strokeWidth={1.75}
          />
        </div>
      </div>
      <p className="max-w-xs text-center text-sm text-muted-foreground">
        搜索会话、消息、产物、资料库与项目
      </p>
    </div>
  );
});

/** 有查询但无命中 */
export const SearchNoResults: FC<{ query: string }> = memo(
  function SearchNoResults({ query }) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-6 pb-24">
        <div className="relative mb-2 grid place-items-center">
          <DotCloud />
          <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
            <SearchXIcon
              className="size-6 text-muted-foreground/50"
              strokeWidth={1.75}
            />
          </div>
        </div>
        <p className="text-sm">没有找到「{query}」</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          试试其他 scope，或用 &gt; 前缀执行操作
        </p>
      </div>
    );
  },
);
