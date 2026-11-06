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
 * - 聊天/整页顶栏 header.tsx：WindowControls right=16（浮层固定 top 0）
 * - Agent 面板顶栏：WindowControls right=16（只留占位，浮层由 Header 绘制）
 * - 设置页顶栏：WindowControls 默认 right=16
 * - 全局搜索不再自己贴窗口边缘：输入行嵌进主 Header，让位由 Header 承担
 */

import { MinusIcon, SearchIcon, SquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** 与 window-controls.tsx 的 CLUSTER_W 对齐（3×size-8 + 2×gap-0.5） */
const CLUSTER_W = 100;

/** 三键簇的视觉复刻（只画样子，不接窗口 API）；浮层固定 top 0 */
const FakeWindowsControls = ({ right = 16 }: { right?: number }) => (
  <div
    aria-hidden
    className="pointer-events-none absolute z-50 flex h-12 items-center gap-0.5"
    style={{ top: 0, right, width: CLUSTER_W }}
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
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">窗口三键让位对照（Windows/Linux）</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          三键簇 = 100px 宽，浮层固定 top 0，right 统一 16。
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
        note="header.tsx：pr-4 内容 + WindowControls right=16（top 固定 0）—— 已让位"
      >
        <div className="flex h-12 items-center gap-2 pl-4 pr-4">
          <span className="text-sm font-medium">会话标题</span>
          <RightActions />
        </div>
        <FakeWindowsControls right={16} />
      </Specimen>

      <Specimen
        title="整页视图顶栏（page：自动化 / 资料库等）"
        note="header.tsx variant=page：pr-4 + WindowControls right=16（top 固定 0）—— 已让位"
      >
        <div className="flex h-12 items-center gap-2 pl-4 pr-4">
          <span className="text-sm font-medium text-muted-foreground">
            整页视图（无标题）
          </span>
          <RightActions />
        </div>
        <FakeWindowsControls right={16} />
      </Specimen>

      <Specimen
        title="Agent 面板顶栏"
        note="agent-panel：pr-4 + WindowControls right=16（只留占位）—— 已让位"
      >
        <div className="flex h-12 items-center gap-2 pl-4 pr-4">
          <span className="text-sm font-medium">面板标签</span>
          <RightActions />
        </div>
        <FakeWindowsControls right={16} />
      </Specimen>

      <Specimen
        title="设置页顶栏"
        note="settings-page：h-12 justify-end pr-4 + WindowControls right=16（top 固定 0）—— 已让位"
      >
        <div className="flex h-12 items-center justify-end pr-4">
          <RightActions />
        </div>
        <FakeWindowsControls right={16} />
      </Specimen>

      <Specimen
        title="资料库顶栏（页面工具条注入 Header）"
        note="library-view portal 到 page-header-actions 槽位；槽位之后就是 WindowControls 的 100px 占位 —— 自动让位"
      >
        {/* 与真实 Header 同序：折叠槽 → 页面槽位(flex-1, 注入工具条) →
            gap-2 → WindowControls 占位(100px) → pr-4 */}
        <div className="flex h-12 items-center gap-2 pl-4 pr-4">
          <span className="shrink-0 text-sm font-semibold whitespace-nowrap">资料库</span>
          <span className="shrink-0 rounded-md px-1.5 py-1 text-xs">新建笔记</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/60">
            也可以把文件直接拖进来；AI 产物也在同一棵树里
          </span>
          <span className="h-8 w-40 shrink-0 rounded-md bg-muted/60 px-2 text-xs leading-8 text-muted-foreground">
            搜索笔记与文件…
          </span>
          <span className="shrink-0 rounded-md px-1.5 py-1 text-xs">导入</span>
          <span className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground">
            <SearchIcon className="size-3.5" />
          </span>
          {/* WindowControls 的原位占位（真实组件渲染同尺寸空 div） */}
          <div aria-hidden className="h-12 shrink-0" style={{ width: CLUSTER_W }} />
        </div>
        <FakeWindowsControls right={16} />
      </Specimen>

      <Specimen
        title="引导向导顶栏（全窗口接管）"
        note="onboarding-flow：h-11 + paddingRight 124（16+100+8）—— 已让位"
      >
        <div className="flex h-11 items-center justify-end gap-2 pl-4" style={{ paddingRight: 124 }}>
          <span className="mr-1 text-xs text-muted-foreground tabular-nums">第 2 步，共 4 步</span>
          <span className="rounded-md px-2 py-1 text-xs text-muted-foreground">跳过</span>
        </div>
        <FakeWindowsControls right={16} />
      </Specimen>

      <Specimen
        title="图片查看器关闭钮（全窗口浮层）"
        note="image-quick-look：关闭钮改 right=124（16+100+8）—— 已让位"
      >
        <div className="relative grid h-32 place-items-center bg-neutral-900">
          <span className="text-xs text-white/50">图片区域</span>
          <span
            className="absolute top-4 flex size-9 items-center justify-center rounded-full bg-black/55 text-white"
            style={{ right: 124 }}
          >
            <XIcon className="size-4" />
          </span>
        </div>
        <FakeWindowsControls right={16} />
      </Specimen>
    </div>
  );
}
