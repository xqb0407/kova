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

/**
 * 自绘窗口控制按钮（最小化/最大化/关闭），Windows 风格。
 *
 * 仅在「桌面端且非 macOS」时渲染（Windows/Linux 由 旧桌面壳窗口配置 关闭系统
 * 标题栏 decorations:false）；macOS 使用系统红绿灯，网页端无窗口 chrome。
 * 按钮内部自行判定环境，父组件可直接渲染，无需条件包裹。
 *
 * 结构是「原位占位 + 全局唯一浮层」：按钮簇本身 portal 到 body 末尾、
 * fixed 钉在窗口右上角、z-[120]——高于 dialog/sheet/alert-dialog 的 z-50、
 * 新手引导的 z-[60]、toast 的 z-[90]，任何浮层打开时三键仍可见可点；
 * 外层 pointer-events:none、按钮本体 auto，既穿透浮层模态对 body 的
 * pointer-events 封锁，又不挡顶栏其余区域的拖窗命中（拖窗走 preload 的
 * IPC 方案，见 apps/electron/preload/index.ts，不依赖 app-region）。
 * 原调用点位置留同尺寸空占位，四个宿主顶栏的右缘布局零改动。
 *
 * top/right 对齐各宿主顶栏的实际槽位（聊天/设置：窗口顶缘 top=0、pr-4=16；
 * 停靠面板顶栏：header 之下 top=56、卡片边距+pr-2 也恰是 right=16），
 * 浮层按钮与占位槽像素级重合，宿主交接（停靠/收起）不跳位。
 */

/** 按钮簇占宽：3 × size-8(32) + 2 × gap-0.5(2px) = 100px */
const CLUSTER_W = 100;

/**
 * 唯一层认领：聊天顶栏 / 面板顶栏 / 设置顶栏随视图切换换挂载点，正常互斥；
 * 加保险防同帧双挂载（按钮簇重叠错位）。挂载实例集合 + 确定性选主：第一个
 * 挂载者画浮层、其余只留占位；持有者卸载时立刻从剩余实例中补位（同提交内
 * 卸载清理先于新挂载 setup，宿主交接时新实例直接接手，不空窗）。
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

export const WindowControls: FC<{ top?: number; right?: number }> = ({
  top = 0,
  right = 16,
}) => {
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
      {/* 原位占位：与浮层按钮簇同宽同高，宿主右缘布局不变 */}
      <div
        aria-hidden
        className="h-12 shrink-0"
        style={{ width: CLUSTER_W }}
      />
      {ownsLayer &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[120] flex h-12 items-center"
            style={{ top, right }}
          >
            <div className="flex h-12 items-center gap-0.5">
              <button
                type="button"
                aria-label="最小化"
                className={`${btn} hover:bg-muted`}
                onClick={() => void win.minimize()}
              >
                <MinusIcon className="size-4" />
              </button>
              <button
                type="button"
                aria-label={maximized ? "还原" : "最大化"}
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
                aria-label="关闭"
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
