"use client";

/**
 * 图片标签：磁盘图片的看图器（面包屑顶栏 + 点阵画布 + 底部缩放条）。
 *
 * 独立成文件而不是塞进 file-view：图片是**另一条读取路径**（
 * fs_read_file_base64 → data URL），且这里多了一套缩放/平移状态机；两种视图
 * 的状态机不一样，放一起只会让 file-view 同时背两份。
 *
 * 看图能力（原先只有「撑不破容器」：小图贴原位、大图缩到容器，1:1 的像素
 * 看不到，也无法放大核对细节）：
 *   · 适应窗口（默认，只缩不放）/ 1:1 / 连续缩放（−、＋、Cmd/Ctrl+滚轮、
 *     触控板捏合）/ 双击在「适应 ↔ 1:1」间切换 / 放大溢出后按住拖动平移；
 *   · 尺寸全走像素：内容按 natural × 倍率显式定宽高，溢出交给画布滚动条。
 *     适应倍率由容器与图片尺寸实时算（面板拖宽、换图都跟着重算），
 *     所以百分比读数在适应态也是真值，不是写死的 100%。
 *   · SVG 预览复用同一组件（见 file-view 的 SvgPreview）：矢量图「适应」允许
 *     放大（贴满容器才是原来的观感），拿不到固有尺寸时退回「撑满容器 + 无缩放条」。
 *
 * 顶栏取系统看图器的形态（`dir › file.png` 面包屑 + 右侧「格式 · 体积 · 尺寸」
 * 与复制路径）：图片没有源码态/行号，路径与元信息就是它的身份，不再单列一行
 * 提示条。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CopyIcon,
  ImageOffIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { fsReadFileBase64 } from "@/lib/workspace/fs";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "./file-type-icon";
import { splitPath } from "./git-files";
import { TabEmpty } from "./tab-empty";

/** 画布内边距（p-4）：算适应倍率时要把它从可视区里扣掉，否则贴边溢出 */
const PAD = 16;
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
/** 按钮与滚轮同一档缩放比例 */
const STEP = 1.25;

const clampScale = (v: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(v * 100) / 100));

type Natural = { w: number; h: number };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 可缩放图片：画布自己撑满容器（flex-1），缩放条浮在画布底部。
 * 尺寸未知（未加载完 / SVG 无固有尺寸）时不接管：按 max-w/h-full 撑进容器，
 * 缩放条也不显示——宁可不给，也不给一个倍率算假的控件。
 */
export const ZoomableImage: FC<{
  src: string;
  alt: string;
  /** 适应窗口时是否允许放大（矢量图用；位图保持「只缩不放」） */
  upscaleToFit?: boolean;
  /** 固有尺寸就位（顶栏拿它显示 W × H） */
  onNatural?: (size: Natural) => void;
  /** 图片解码失败（SVG 预览据此出占位） */
  onError?: () => void;
}> = ({ src, alt, upscaleToFit = false, onNatural, onError }) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  /** "fit" = 适应窗口；数字 = 具体倍率（1 = 100%） */
  const [scale, setScale] = useState<number | "fit">("fit");
  /** 锚点缩放：缩放前记下光标处的内容坐标，提交后按新倍率把它贴回原位 */
  const anchorRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  /** 切回适应时把滚动位置归零（让居中版式生效，而不是停在旧的滚动位置） */
  const recenterRef = useRef(true);

  // 换图（SVG 预览会在 text 变化时换 src）：尺寸与缩放都重置
  useEffect(() => {
    setNatural(null);
    setScale("fit");
    anchorRef.current = null;
    recenterRef.current = true;
  }, [src]);

  // 容器尺寸：适应倍率随面板宽度实时变，百分比读数也跟着变
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const sync = () =>
      setViewport((cur) =>
        cur.w === el.clientWidth && cur.h === el.clientHeight
          ? cur
          : { w: el.clientWidth, h: el.clientHeight },
      );
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 读一次固有尺寸。不能只靠 <img onLoad>：SSR/已缓存的图在 React 挂上
   *  监听之前就把 load 烧掉了（本地 data URL 尤其快），事件不再来，缩放条
   *  与像素定尺就永远不出现——挂载后补一次 complete 检查兜住这种情况。
   *  onNatural 走 ref：调用方传内联箭头时若进依赖链（syncNatural → effect），
   *  每次渲染的新引用会把 effect 带进无限重渲染（setState 回调又触发渲染）。 */
  const onNaturalRef = useRef(onNatural);
  onNaturalRef.current = onNatural;
  const syncNatural = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const size = { w: img.naturalWidth, h: img.naturalHeight };
    if (size.w <= 0 || size.h <= 0) return;
    setNatural((cur) =>
      cur && cur.w === size.w && cur.h === size.h ? cur : size,
    );
    onNaturalRef.current?.(size);
  }, []);

  useEffect(() => {
    syncNatural();
  }, [src, syncNatural]);

  const sized = !!natural && natural.w > 0 && natural.h > 0;

  const fitScale = useMemo(() => {
    if (!sized || viewport.w === 0 || viewport.h === 0) return 1;
    const availW = Math.max(1, viewport.w - PAD * 2);
    const availH = Math.max(1, viewport.h - PAD * 2);
    const fit = Math.min(availW / natural.w, availH / natural.h);
    return upscaleToFit ? fit : Math.min(fit, 1);
  }, [sized, natural, viewport, upscaleToFit]);

  const effective = scale === "fit" ? fitScale : scale;
  // 事件回调（滚轮/按钮）要读当前倍率：走 ref，避免每次缩放都重建监听
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;

  const zoomTo = useCallback(
    (next: number, anchor?: { x: number; y: number }) => {
      const el = canvasRef.current;
      if (!el || !sized) return;
      const before = effectiveRef.current || 1;
      if (anchor) {
        anchorRef.current = {
          x: anchor.x,
          y: anchor.y,
          cx: (el.scrollLeft + anchor.x) / before,
          cy: (el.scrollTop + anchor.y) / before,
        };
      } else {
        recenterRef.current = true;
      }
      setScale(clampScale(next));
    },
    [sized],
  );

  /** 以画布中心为锚点缩放：内容放大后仍停在原来盯着的那块 */
  const zoomBy = useCallback(
    (factor: number) => {
      const el = canvasRef.current;
      zoomTo(
        (effectiveRef.current || 1) * factor,
        el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : undefined,
      );
    },
    [zoomTo],
  );

  const fitToWindow = useCallback(() => {
    recenterRef.current = true;
    setScale("fit");
  }, []);
  const actualSize = useCallback(() => {
    const el = canvasRef.current;
    zoomTo(1, el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : undefined);
  }, [zoomTo]);

  // 提交后再动滚动位置：此刻新倍率已经落在 DOM 上，锚点才算得对
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    if (recenterRef.current) {
      recenterRef.current = false;
      el.scrollLeft = 0;
      el.scrollTop = 0;
      return;
    }
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    el.scrollLeft = a.cx * effective - a.x;
    el.scrollTop = a.cy * effective - a.y;
  }, [effective, sized]);

  // Cmd/Ctrl+滚轮 = 缩放手势（触控板捏合在 Chromium 里也走这条通道）。
  // 必须挂非 passive 的原生监听：React 的 onWheel 在根节点上是 passive 的，
  // 里面 preventDefault 会被浏览器忽略（缩放手势同时把页面滚走）。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      // 指数缩放：捏合是连续量，按档位跳会抖
      const factor = Math.exp(-event.deltaY * 0.012);
      zoomTo((effectiveRef.current || 1) * factor, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  // 溢出时拖动平移。用 window 上的 move/up 而不是 pointer capture：
  // capture 会把后续 click/dblclick 重定向到捕获元素，双击切换就废了。
  const panRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = canvasRef.current;
    // 鼠标才接管：触摸留给系统滚动（拖动图片和滚页面在触屏上分不清）
    if (!el || event.pointerType !== "mouse" || event.button !== 0) return;
    const overflowing =
      el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
    if (!overflowing) return;
    panRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
    };
    const move = (e: PointerEvent) => {
      const p = panRef.current;
      const node = canvasRef.current;
      if (!p || !node) return;
      node.scrollLeft = p.left - (e.clientX - p.x);
      node.scrollTop = p.top - (e.clientY - p.y);
      event.currentTarget?.setAttribute?.("data-panning", "true");
    };
    const up = () => {
      panRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      canvasRef.current?.removeAttribute("data-panning");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const overflowing = useMemo(() => {
    if (!sized) return false;
    return (
      natural.w * effective > viewport.w - PAD * 2 + 1 ||
      natural.h * effective > viewport.h - PAD * 2 + 1
    );
  }, [sized, natural, effective, viewport]);

  const percent = Math.max(1, Math.round(effective * 100));
  const atFit = scale === "fit";
  const atActual = !atFit && Math.abs(effective - 1) < 0.005;

  return (
    // h-full 与 flex-1 同时给：面板标签里是 flex 子项（flex-1 定高），
    // SVG 预览那侧塞在块级容器里（height:100% 定高），两种父容器都兜住
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {/* 点阵底：透明 PNG 也能看清边界（对齐系统看图器）；图案挂在滚动容器上，
          不随内容滚动。颜色由 --foreground 低比例混出，亮暗主题同一套规则 */}
      <div
        ref={canvasRef}
        // eslint-disable-next-line tailwindcss/no-custom-classname
        className={cn(
          "min-h-0 flex-1 overflow-auto bg-muted",
          "[background-image:radial-gradient(color-mix(in_oklab,var(--foreground)_9%,transparent)_1px,transparent_1px)] [background-size:16px_16px]",
          overflowing && "cursor-grab data-panning:cursor-grabbing",
        )}
        onPointerDown={onPointerDown}
        onDoubleClick={(event) => {
          if (!sized) return;
          event.preventDefault();
          if (atFit) actualSize();
          else fitToWindow();
        }}
      >
        {/* 居中的可滚动内容用 grid + w-max/min-w-full：内容比可视区小就居中，
            比可视区大时容器跟着内容长大——换成 flex 居中会让溢出部分**够不到**
            （justify-content:center 的溢出只往右可滚，左边被裁掉且滚不回），
            锚点缩放也会跟着错位 */}
        <div className="grid h-max min-h-full w-max min-w-full place-items-center p-4">
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={syncNatural}
            onError={() => {
              setNatural(null);
              onError?.();
            }}
            style={
              sized
                ? { width: natural.w * effective, height: natural.h * effective }
                : undefined
            }
            className={cn(
              "outline outline-1 outline-foreground/10 select-none",
              !sized && "max-h-full max-w-full object-contain",
            )}
          />
        </div>
      </div>
      {sized ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
          <div className="bg-popover/90 text-popover-foreground border-border/70 pointer-events-auto flex items-center gap-0.5 rounded-full border px-1 py-0.5 shadow-lg backdrop-blur-sm">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="缩小"
              title="缩小"
              disabled={effective <= MIN_SCALE + 1e-6}
              onClick={() => zoomBy(1 / STEP)}
            >
              <MinusIcon />
            </Button>
            <span className="w-11 text-center text-xs tabular-nums">{percent}%</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="放大"
              title="放大"
              disabled={effective >= MAX_SCALE - 1e-6}
              onClick={() => zoomBy(STEP)}
            >
              <PlusIcon />
            </Button>
            <span aria-hidden className="bg-border mx-1 h-4 w-px" />
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={atFit}
              className={cn(atFit && "bg-muted text-foreground")}
              onClick={fitToWindow}
            >
              适应
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={atActual}
              className={cn(atActual && "bg-muted text-foreground")}
              onClick={actualSize}
            >
              1:1
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

/**
 * 图片顶栏：面包屑路径（`dir › base`）+ 右侧元信息与复制路径。
 * 路径段整体截断、文件名优先保住（窄面板时先牺牲目录）。
 */
const ImageTopBar: FC<{ path: string; meta: string | null }> = ({ path, meta }) => {
  const { dir, base } = splitPath(path);
  const segments = dir ? dir.split("/").filter(Boolean) : [];
  return (
    <div
      className="border-border/60 flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5"
      title={path}
    >
      <FileTypeIcon path={path} />
      {segments.length ? (
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {segments.join(" › ")} ›
        </span>
      ) : null}
      <span className="text-foreground/90 truncate text-ui font-medium">
        {base}
      </span>
      {meta ? (
        <span className="text-muted-foreground ml-auto hidden shrink-0 text-xs tabular-nums @sm:inline">
          {meta}
        </span>
      ) : null}
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip="复制路径"
        side="bottom"
        className={cn("size-6 shrink-0", !meta && "ml-auto")}
        onClick={() => {
          void navigator.clipboard
            .writeText(path)
            .then(() => toast.success("已复制路径"))
            .catch(() => toast.error("复制失败"));
        }}
      >
        <CopyIcon className="size-3.5" />
      </TooltipIconButton>
    </div>
  );
};

type ImageLoadState =
  | { status: "loading" }
  | { status: "ready"; src: string; size: number }
  | { status: "too-large" }
  | { status: "error" };

/** 磁盘图片标签：字节走 base64 → data URL（图片上下文不执行脚本、不加载外链） */
export const ImageView: FC<{ cwd: string; path: string; mime: string }> = ({
  cwd,
  path,
  mime,
}) => {
  const [state, setState] = useState<ImageLoadState>({ status: "loading" });
  const [natural, setNatural] = useState<Natural | null>(null);
  useEffect(() => {
    let alive = true;
    void fsReadFileBase64(cwd, path).then((r) => {
      if (!alive) return;
      if (r === "too-large") setState({ status: "too-large" });
      else if (r)
        setState({
          status: "ready",
          src: `data:${mime};base64,${r.base64}`,
          size: r.size,
        });
      else setState({ status: "error" });
    });
    return () => {
      alive = false;
    };
  }, [cwd, path, mime]);

  const ext = path.slice(path.lastIndexOf(".") + 1).toUpperCase();
  const meta =
    state.status === "ready"
      ? [
          ext,
          formatBytes(state.size),
          natural ? `${natural.w} × ${natural.h}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <ImageTopBar path={path} meta={meta} />
      {state.status === "ready" ? (
        <ZoomableImage
          src={state.src}
          alt={path}
          onNatural={setNatural}
        />
      ) : state.status === "loading" ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center gap-1.5 text-xs">
          <Loader2Icon className="size-3.5 animate-spin" />
          读取图片…
        </div>
      ) : (
        <TabEmpty
          icon={ImageOffIcon}
          text={
            state.status === "too-large"
              ? "图片超过 20MB，暂不预览"
              : "读取失败（文件可能已被删除，或无权限访问）"
          }
        />
      )}
    </div>
  );
};
