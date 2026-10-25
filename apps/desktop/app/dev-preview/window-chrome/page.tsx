"use client";

/**
 * 【临时验证页】Windows/Linux 自绘窗口三键的右缘让位对照。
 *
 * 用途：Windows/Linux 是 frame:false + 前端自绘三键（window-controls.tsx，
 * 簇宽 CLUSTER_W=100，钉在窗口右上）。任何贴窗口右缘画顶栏的页面都必须给它
 * 留位，否则输入框/按钮会被压在关闭按钮下面。本页把各宿主顶栏的**真实
 * class 几何**摆在一起，并在同一坐标（相对窗口右上）叠一个三键簇，肉眼即可
 * 看出哪一页没让位。
 *
 * 用法：`/dev-preview/window-chrome?platform=windows`（?platform 是 dev-only
 * 平台覆盖，见 lib/desktop-env.ts）。不加参数时三键不画，作为基线对照。
 *
 * 已确认让位的宿主（改动史）：
 * - 聊天/整页顶栏 header.tsx：WindowControls top=8 right=24
 * - Agent 面板顶栏：WindowControls top=8（right 默认 16）
 * - 设置页顶栏：WindowControls 默认 top=0 right=16
 * - 全局搜索顶栏（覆盖层贴窗口边缘）：input 行 paddingRight=132
 *   （24 + CLUSTER_W 100 + 8 呼吸）；macOS 折叠侧栏另 paddingLeft=96 让红绿灯
 */

import { useState } from "react";
import { MinusIcon, SearchIcon, SquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { GlobalSearchView } from "@/components/search/global-search-view";

/** 与 window-controls.tsx 的 CLUSTER_W 对齐（3×size-8 + 2×gap-0.5） */
const CLUSTER_W = 100;

/** 三键簇的视觉复刻（只画样子，不接窗口 API） */
const FakeWindowsControls = ({ top = 0, right = 16 }: { top?: number; right?: number }) => (
  <div
    aria-hidden
    className="pointer-events-none absolute z-50 flex h-12 items-center gap-0.5"
    style={{ top, right, width: CLUSTER_W }}
  >
    <button className="pointer-events-auto grid size-8 place-items-center rounded-md text-foreground/80 hover:bg-muted">
      <MinusIcon className="size-3.5" />
    </button>
    <button className="pointer-events-auto grid size-8 place-items-center rounded-md text-foreground/80 hover:bg-muted">
      <SquareIcon className="size-3" />
    </button>
    <button className="pointer-events-auto grid size-8 place-items-center rounded-md text-foreground/80 hover:bg-red-500 hover:text-white">
      <XIcon className="size-3.5" />
    </button>
  </div>
);

const Specimen = ({
  title,
  note,
  children,
  danger,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
  danger?: boolean;
}) => (
  <section className="mb-6">
    <div className="mb-1.5 flex items-baseline gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      <span className={cn("text-xs", danger ? "text-destructive" : "text-muted-foreground")}>
        {note}
      </span>
    </div>
    <div className="bg-muted/40 relative overflow-hidden rounded-lg border">
      {children}
    </div>
  </section>
);

/** 顶栏右侧的几个占位动作（真实宿主里是终端/面板/更多按钮） */
const RightActions = () => (
  <div className="ml-auto flex items-center gap-0.5">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="grid size-8 place-items-center rounded-md text-muted-foreground"
      >
        <span className="size-3.5 rounded-sm border border-current" />
      </span>
    ))}
  </div>
);

export default function WindowChromePreview() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">窗口三键让位对照（Windows/Linux）</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          三键簇 = 100px 宽，钉在窗口右上（top 8 / right 24 或 16，按宿主不同）。
          每块右缘叠的就是真实位置；输入框或按钮被压在下面即为未适配。
        </p>
        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            当前平台判定：{typeof window !== "undefined" && new URLSearchParams(window.location.search).get("platform") === "windows"
              ? "windows（已覆盖）"
              : "未覆盖（浏览器 UA）"}
          </span>
          <a
            className="text-primary underline"
            href="?platform=windows"
          >
            ?platform=windows
          </a>
        </div>
      </header>

      <Specimen
        title="聊天顶栏（session）"
        note="header.tsx：pr-4 内容 + WindowControls top=8 right=24 —— 已让位"
      >
        <div className="pt-2">
          <div className="flex h-12 items-center gap-2 pl-4 pr-4">
            <span className="text-sm font-medium">会话标题</span>
            <RightActions />
          </div>
        </div>
        <FakeWindowsControls top={8} right={24} />
      </Specimen>

      <Specimen
        title="整页视图顶栏（page：自动化 / 资料库等）"
        note="header.tsx variant=page：pr-4 + WindowControls top=8 right=24 —— 已让位"
      >
        <div className="pt-2">
          <div className="flex h-12 items-center gap-2 pl-4 pr-4">
            <span className="text-sm font-medium text-muted-foreground">
              整页视图（无标题）
            </span>
            <RightActions />
          </div>
        </div>
        <FakeWindowsControls top={8} right={24} />
      </Specimen>

      <Specimen
        title="Agent 面板顶栏"
        note="agent-panel：pr-2 + WindowControls top=8（right 16）—— 已让位"
      >
        <div className="pt-2">
          <div className="flex h-12 items-center gap-2 pl-4 pr-2">
            <span className="text-sm font-medium">面板标签</span>
            <RightActions />
          </div>
        </div>
        <FakeWindowsControls top={8} right={16} />
      </Specimen>

      <Specimen
        title="设置页顶栏"
        note="settings-page：h-12 justify-end pr-4 + WindowControls top=0 right=16 —— 已让位"
      >
        <div className="flex h-12 items-center justify-end pr-4">
          <RightActions />
        </div>
        <FakeWindowsControls top={0} right={16} />
      </Specimen>

      <Specimen
        title="引导向导顶栏（全窗口接管）"
        note="onboarding-flow：h-11 + paddingRight 132（24+100+8）—— 本次补齐"
      >
        <div className="flex h-11 items-center justify-end gap-2 pl-4" style={{ paddingRight: 132 }}>
          <span className="mr-1 text-xs text-muted-foreground tabular-nums">第 2 步，共 4 步</span>
          <span className="rounded-md px-2 py-1 text-xs text-muted-foreground">跳过</span>
        </div>
        <FakeWindowsControls top={0} right={24} />
      </Specimen>

      <Specimen
        title="图片查看器关闭钮（全窗口浮层）"
        note="image-quick-look：关闭钮改 right=132（24+100+8）—— 本次补齐"
      >
        <div className="relative grid h-32 place-items-center bg-neutral-900">
          <span className="text-xs text-white/50">图片区域</span>
          <span
            className="absolute top-4 flex size-9 items-center justify-center rounded-full bg-black/55 text-white"
            style={{ right: 132 }}
          >
            <XIcon className="size-4" />
          </span>
        </div>
        <FakeWindowsControls top={0} right={24} />
      </Specimen>

      <Specimen
        title="全局搜索顶栏（本次改动）"
        note="输入行 paddingRight=132（24+100+8）—— 已让位；对照下方输入框右缘与三键"
      >
        <div className="h-72">
          <GlobalSearchView
            open
            onOpenChange={() => {}}
            onNewThread={() => {}}
            collapsed={collapsed}
          />
        </div>
        <FakeWindowsControls top={0} right={24} />
      </Specimen>

      <div className="mb-6 flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="rounded-md border px-2 py-1"
        >
          切换侧栏折叠态（{collapsed ? "折叠" : "展开"}）→ 影响 macOS 红绿灯让位
        </button>
        <a className="text-primary underline" href="?platform=mac">
          ?platform=mac 查看 macOS 折叠态左侧让位
        </a>
      </div>

      <p className="text-xs text-muted-foreground">
        提示：搜索页的让位在真实窗口里同时作用于「清空按钮 / spinner」所在的右侧槽位；
        输入文字后观察清空按钮是否落在三键之下即可验证。
      </p>
    </div>
  );
}
