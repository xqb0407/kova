"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FC,
} from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@/desktop-bridge/window";
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { isMacPlatform, isDesktop } from "@/lib/desktop-env";
import { useT } from "@/lib/i18n";

/**
 * 自绘窗口控制按钮（最小化/最大化/关闭），Windows 风格。
 *
 * 仅在「桌面端且非 macOS」时渲染（Windows/Linux 由 旧桌面壳窗口配置 关闭系统
 * 标题栏 decorations:false）；macOS 使用系统红绿灯，网页端无窗口 chrome。
 * 按钮内部自行判定环境，父组件可直接渲染，无需条件包裹。
 *
 * 结构是「原位占位 + 常驻单浮层」：按钮簇本身 portal 到 body 末尾、
 * fixed 钉在窗口右上角、z-[120]——高于 dialog/sheet/alert-dialog 的 z-50、
 * 新手引导的 z-[60]、toast 的 z-[90]，任何浮层打开时三键仍可见可点；
 * 外层 pointer-events:none、按钮本体 auto，既穿透浮层模态对 body 的
 * pointer-events 封锁，又不挡顶栏其余区域的拖窗命中（拖窗走 preload 的
 * IPC 方案，见 apps/electron/preload/index.ts，不依赖 app-region）。
 * 各宿主在原调用点留同尺寸空占位，右缘布局零改动。
 *
 * 浮层固定钉在窗口顶缘（top: 0），right 统一为窗口右缘内 16px
 * （聊天/设置/停靠面板顶栏都是 pr-4）。聊天顶栏的实例常驻并绘制浮层；
 * 面板/设置实例只留占位，不再做宿主交接。面板作为右列时 Header 传
 * collapsed：占位宽度与宿主的 8px flex gap 一起 300ms 收放，终端按钮
 * 随面板动画滑到聊天列右缘。
 */

/** 按钮簇占宽：3 × size-8(32) + 2 × gap-0.5(2px) = 100px
 *  （导出供 onboarding-flow / image-quick-look 等贴右缘元素换算让位；
 *   search-header 另有同值常量，改动时需同步） */
export const CLUSTER_W = 100;

/**
 * 聊天顶栏实例常驻（App 生命周期内唯一绘制者），面板/设置只留占位。
 * 仍保留挂载实例集合 + 确定性选主作兜底：不同路由下第一个挂载者画浮层、
 * 其余只留占位；持有者卸载时立刻从剩余实例中补位（同提交内卸载清理先于
 * 新挂载 setup，不空窗）。各宿主 right 一致，兜底切换也不跳位。
 */
const instances = new Set<symbol>();
let layerOwner: symbol | null = null;
let layerVersion = 0;
const ownerListeners = new Set<() => void>();
const pickOwner = () => {
  const next = instances.values().next().value ?? null;
  if (next !== layerOwner) {
    layerOwner = next;
    layerVersion += 1;
    for (const l of ownerListeners) l();
  }
};
const subscribeOwner = (cb: () => void) => {
  ownerListeners.add(cb);
  return () => ownerListeners.delete(cb);
};

export const WindowControls: FC<{
  right?: number;
  /** 宿主右侧空间收没（面板作为右列时由 Header 传入）：占位 100→0，
   *  同时抵消宿主的 8px flex gap，避免终端按钮瞬移 */
  collapsed?: boolean;
}> = ({ right = 16, collapsed = false }) => {
  const t = useT();
  const enabled = isDesktop() && !isMacPlatform();
  const selfRef = useRef<symbol | null>(null);
  if (!selfRef.current) selfRef.current = Symbol("window-controls");
  // SSR/预渲染：Portal 只在 document 就绪后挂（首帧无按钮不闪内容，本来就要等判环境）
  const [mounted, setMounted] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // 选主态走版本号快照：渲染期读模块变量，订阅只认版本自增重渲染
  useSyncExternalStore(subscribeOwner, () => layerVersion, () => 0);
  const ownsLayer = enabled && mounted && layerOwner === selfRef.current;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const self = selfRef.current!;
    instances.add(self);
    pickOwner();
    return () => {
      instances.delete(self);
      if (layerOwner === self) layerOwner = null;
      pickOwner();
    };
  }, [enabled]);

  // 跟随窗口尺寸变化同步最大化状态（最大化/还原均有 resize 事件）
  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then((v) => {
      if (!disposed) setMaximized(v);
    });
    void win
      .onResized(async () => {
        try {
          const v = await win.isMaximized();
          if (!disposed) setMaximized(v);
        } catch {
          // 窗口关闭过程中查询可能失败，忽略
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  if (!enabled) return null;

  const win = getCurrentWindow();
  // 尺寸/圆角/hover 与顶栏其他图标按钮（全屏、收起面板等）同规格：
  // size-8 + rounded-md + hover:bg-muted，避免三键在 h-12 顶栏里显得又宽又方
  const btn =
    "pointer-events-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/80 transition-colors";
  return (
    <>
      {/* 原位占位：与浮层按钮簇同宽同高；collapsed 时宽度和宿主 gap 一起
          收没，让宿主的右侧按钮随面板动画滑到新右缘 */}
      <div
        aria-hidden
        className="h-12 shrink-0 transition-[width,margin] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{
          width: collapsed ? 0 : CLUSTER_W,
          marginLeft: collapsed ? -8 : 0,
        }}
      />
      {ownsLayer &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[120] flex h-12 items-center"
            style={{ top: 0, right }}
          >
            <div className="flex h-12 items-center gap-0.5">
              <button
                type="button"
                aria-label={t("common.windowControls.minimize")}
                className={`${btn} hover:bg-muted`}
                onClick={() => void win.minimize()}
              >
                <MinusIcon className="size-4" />
              </button>
              <button
                type="button"
                aria-label={t(
                  maximized
                    ? "common.windowControls.restore"
                    : "common.windowControls.maximize",
                )}
                className={`${btn} hover:bg-muted`}
                onClick={() => void win.toggleMaximize()}
              >
                {maximized ? (
                  <CopyIcon className="size-3.5" />
                ) : (
                  <SquareIcon className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                aria-label={t("common.windowControls.close")}
                className={`${btn} hover:bg-red-600 hover:text-white`}
                onClick={() => void win.close()}
              >
                <XIcon className="size-4" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
