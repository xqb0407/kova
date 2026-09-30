"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
  type FormEvent,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  Loader2Icon,
  RotateCwIcon,
} from "lucide-react";
import { updatePanelTab, type PanelTab } from "@/lib/panels/panel-tabs";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** 无协议输入补 https://;非法输入返回 null。file:// 放行（产物浏览器预览本地文件） */
function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (
      u.protocol !== "http:" &&
      u.protocol !== "https:" &&
      u.protocol !== "file:"
    )
      return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    // file:// 无 hostname，标题取文件名末段
    if (u.protocol === "file:") {
      const segs = u.pathname.split("/").filter(Boolean);
      const last = segs[segs.length - 1];
      return last ? decodeURIComponent(last) : url;
    }
    return u.hostname;
  } catch {
    return url;
  }
}

const tauriCore = () => import("@tauri-apps/api/core");

type VpState = {
  mode: "fill" | "fixed";
  width: number | null;
  height: number | null;
};

type VpPreset =
  | { label: string; mode: "fill" }
  | { label: string; mode: "fixed"; width: number; height: number };

/** 视口预设档位：填满面板，或固定逻辑尺寸居中显示（响应式查看） */
const VP_PRESETS: VpPreset[] = [
  { label: "填满", mode: "fill" },
  { label: "桌面", mode: "fixed", width: 1280, height: 800 },
  { label: "平板", mode: "fixed", width: 768, height: 1024 },
  { label: "手机", mode: "fixed", width: 375, height: 812 },
];

/**
 * 浏览器标签:地址栏 + Tauri 子 webview（unstable 多 webview，宿主侧 browser.rs 管理）。
 * React 渲染一个常驻占位容器，ResizeObserver/resize/scroll 驱动 browser_sync_bounds
 * 把物理像素 bounds 同步给宿主；页面导航经 "browser:navigated" 事件回推维护
 * 地址栏、历史栈与 tab 记录。相比原 iframe：X-Frame-Options 站点（GitHub 等）
 * 可正常嵌入，且 agent 的 browser_* 工具能驱动同一个 webview。
 * 占位容器必须常驻（不能等有 url 才渲染）：bounds 同步 effect 只挂载一次，
 * 若空态时 div 不存在，之后创建的 webview 会停在宿主兜底位置（窗口右半屏），
 * 盖到面板外——即"溢出面板"。attach 一律排在首次有效 bounds 同步之后；
 * 面板收起（占位 0 尺寸）时隐藏 webview 保留页面，展开后重新落位显示。
 * 跨标签只有一个子 webview：激活的浏览器 tab 胜出，切换 tab 重新 attach 导航。
 * 前进/后退用本组件自维护的访问栈（引擎自身历史不作事实源）。
 *
 * 全屏视图（设置等）覆盖主窗口时隐藏子 webview：原生层 z 序高于任何 React
 * 元素，不隐藏会悬浮盖在其上（base.tsx 广播 browser:occluded）。
 */
export const BrowserView: FC<{ tab: PanelTab }> = ({ tab }) => {
  const initial = tab.url ? normalizeUrl(tab.url) : null;
  const [url, setUrl] = useState<string | null>(initial);
  const [input, setInput] = useState(tab.url ?? "");
  const [loading, setLoading] = useState(false);
  /** 视口模式（Rust 为事实源，经 browser:viewport 事件同步；AI resize 同一状态） */
  const [vp, setVp] = useState<VpState>({
    mode: "fill",
    width: null,
    height: null,
  });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const stack = useRef<string[]>(initial ? [initial] : []);
  const cursor = useRef(initial ? 0 : -1);
  /** 最近一次已同步给 webview 的 url（attach 去重，防事件回写形成导航回环） */
  const attached = useRef<string | null>(null);
  /** 挂载时的初始 url（mount 语义只看首帧，外部后续改 tab.url 走导航链路） */
  const initialRef = useRef(initial);
  /** 当前 url 的 ref：syncBounds 的"收起隐藏/展开恢复"转换在渲染时机之外读它 */
  const urlRef = useRef<string | null>(initial);
  /** webview 是否因占位 0 尺寸（面板收起）被隐藏；恢复可见后据此重新显示 */
  const hiddenRef = useRef(false);
  /** 全屏视图（设置等）正覆盖主窗口时为 true：冻结 bounds 同步并隐藏 webview */
  const occludedRef = useRef(false);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  /** 占位容器 → 宿主 bounds 同步：物理像素（视口坐标 × DPR，客户区两端一致）。
   *  宿主把 bounds 存进 BrowserState：webview 尚未创建时先记着，创建即落位。
   *  返回是否完成一次有效同步（false = 不可见，调用方据此不创建 webview，
   *  否则宿主按"窗口右半屏"兜底创建——原生层盖在 React 之上，即"溢出面板"）。
   *  占位 0 尺寸（面板收起）时顺带隐藏 webview（保留页面状态），恢复可见时
   *  先落位再重新 attach 显示。 */
  const syncBounds = useCallback((): Promise<boolean> => {
    const el = hostRef.current;
    if (!isTauri() || !el) return Promise.resolve(false);
    // 全屏视图覆盖期间（设置等）主视图不可见：冻结同步，恢复时统一补一次
    if (occludedRef.current) return Promise.resolve(false);
    cancelAnimationFrame(rafRef.current);
    return new Promise<boolean>((resolve) => {
      rafRef.current = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        if (r.width < 1 || r.height < 1) {
          // 不可见：隐藏（幂等），不动宿主 bounds
          hiddenRef.current = true;
          tauriCore()
            .then(({ invoke }) => invoke("browser_detach", { destroy: false }))
            .catch(() => {})
            .finally(() => resolve(false));
          return;
        }
        tauriCore()
          .then(({ invoke }) =>
            invoke("browser_sync_bounds", {
              x: Math.round(r.left * dpr),
              y: Math.round(r.top * dpr),
              width: Math.round(r.width * dpr),
              height: Math.round(r.height * dpr),
            }),
          )
          .then(() => {
            if (hiddenRef.current) {
              hiddenRef.current = false;
              // 收起期间被隐藏过：落位后恢复（attach 幂等：同址仅显示不重载；
              // webview 不存在则按刚同步的 frame 创建）。空 tab 无 url 保持隐藏。
              if (urlRef.current) {
                tauriCore()
                  .then(({ invoke }) =>
                    invoke("browser_attach", { url: urlRef.current }),
                  )
                  .catch(() => {});
              }
            }
            resolve(true);
          })
          .catch(() => resolve(false));
      });
    });
  }, []);

  /** 隐藏/恢复 webview（恢复时走 syncBounds 状态机重新落位显示）。
   *  定义在 syncBounds 之后：deps 引用它。 */
  const setOccluded = useCallback(
    (occluded: boolean) => {
      if (occludedRef.current === occluded || !isTauri()) return;
      occludedRef.current = occluded;
      if (occluded) {
        hiddenRef.current = true; // 恢复时走"收起隐藏"分支重新落位显示
        tauriCore()
          .then(({ invoke }) => invoke("browser_detach", { destroy: false }))
          .catch(() => {});
      } else {
        void syncBounds();
      }
    },
    [syncBounds],
  );

  const show = (u: string) => {
    urlRef.current = u;
    setUrl(u);
    setInput(u);
    updatePanelTab(tab.id, { url: u, title: hostOf(u) });
  };

  // 外部改写 tab.url（消息里 WebFetch 行 / agent 的 data-panelOpen 唤起）：
  // 与当前栈顶不同才导航，避免 show 写回 store 后又触发自己形成回环
  useEffect(() => {
    if (!tab.url || tab.url === stack.current[cursor.current]) return;
    const u = normalizeUrl(tab.url);
    if (!u) return;
    stack.current = [...stack.current.slice(0, cursor.current + 1), u];
    cursor.current = stack.current.length - 1;
    setUrl(u);
    setInput(tab.url);
  }, [tab.url]);

  // 挂载：先完成一次有效 bounds 同步，再 attach/detach——attach 先于同步发出时
  // 宿主没有任何 frame 记录，会按"窗口右半屏"兜底创建 webview（即"溢出面板"）；
  // 同步成功后创建则直接落到存好的面板矩形。空 tab 则隐藏残留页面。
  // attach 必须带初始 url 而非 null：StrictMode setup→cleanup→setup 重放保留 ref，
  // 下面的 url→attach effect 会因 attached 去重被跳过，传 null 时宿主在 webview
  // 不存在的情况下拒绝创建——表现为首次「浏览器预览」空白，点刷新才出现。
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void syncBounds().then(() => {
      if (!alive) return;
      tauriCore().then(({ invoke }) => {
        if (!alive) return;
        if (initialRef.current) {
          invoke("browser_attach", { url: initialRef.current }).catch(() => {});
        } else {
          invoke("browser_detach", { destroy: false }).catch(() => {});
        }
      });
    });
    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      tauriCore()
        .then(({ invoke }) => invoke("browser_detach", { destroy: false }))
        .catch(() => {});
    };
  }, [syncBounds]);

  // url 变化 → 先落位再 attach 导航（同址去重交给宿主 current_page 比对）。
  // 同步无效（面板收起等）就不创建：展开后的 ResizeObserver 同步会经
  // hiddenRef 恢复路径按 urlRef 重新 attach。
  useEffect(() => {
    if (!isTauri() || !url || attached.current === url) return;
    attached.current = url;
    void syncBounds().then((ok) => {
      if (!ok) return;
      tauriCore()
        .then(({ invoke }) => invoke("browser_attach", { url }))
        .catch(() => {});
    });
  }, [url, syncBounds]);

  // 布局/滚动跟随：窗口缩放、面板宽度动画、容器滚动都会改变占位区域
  useEffect(() => {
    if (!isTauri()) return;
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(syncBounds);
    ro.observe(el);
    window.addEventListener("resize", syncBounds);
    // 面板容器/主布局滚动时占位 div 位移（capture 捕获所有内层滚动）
    document.addEventListener("scroll", syncBounds, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
      document.removeEventListener("scroll", syncBounds, true);
    };
  }, [syncBounds]);

  // 跨屏拖动（两屏缩放比例不同）时 DPR 变化、物理 bounds 全变，但占位容器
  // 的 CSS 尺寸基本不变（WM_DPICHANGED 建议矩形按视觉尺寸换算）——上面的
  // ResizeObserver/resize 都不触发，子 webview 停在旧物理矩形上，悬浮在
  // 错误区域（z 序在 DOM 之上）盖住 panel/composer 吞点击。监听 DPR 变化
  // 立即重同步（matchMedia 一次性监听：注册当前分辨率，偏离即触发重挂）
  useEffect(() => {
    if (!isTauri()) return;
    let mq: MediaQueryList | null = null;
    const onChange = () => {
      mq?.removeEventListener("change", onChange);
      mq = null;
      void syncBounds();
      watch();
    };
    const watch = () => {
      const dpr = window.devicePixelRatio || 1;
      mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
      mq.addEventListener("change", onChange);
    };
    watch();
    return () => mq?.removeEventListener("change", onChange);
  }, [syncBounds]);

  // 视口模式：挂载取当前值（AI resize 的面板外落位也回读），并跟随宿主事件
  useEffect(() => {
    if (!isTauri()) return;
    tauriCore()
      .then(({ invoke }) => invoke<VpState>("browser_viewport_get"))
      .then((v) => setVp(v))
      .catch(() => {});
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<VpState>("browser:viewport", (e) => setVp(e.payload)),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // 宿主导航事件：started/finished/title 三阶段，维护地址栏、栈与 tab 记录
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ url: string; phase: string; title?: string | null }>(
          "browser:navigated",
          (e) => {
            const u = e.payload.url;
            if (!/^(https?|file):\/\//.test(u)) return;
            setLoading(e.payload.phase === "started");
            if (u !== stack.current[cursor.current]) {
              stack.current = [...stack.current.slice(0, cursor.current + 1), u];
              cursor.current = stack.current.length - 1;
            }
            attached.current = u; // webview 已在此 url
            setUrl(u);
            setInput(u);
            // agent 的 browser_navigate 直接在宿主侧导航子 webview，不经过上面
            // 的 url→attach effect（本回调已把 attached 置位，那边会去重跳过）。
            // 面板收起过/切过 tab/被浮层遮挡过时子 webview 处于隐藏态，不重新
            // 落位显示就是一片白，点刷新才出现——同款症状在挂载路径已修过一次。
            //
            // 只 syncBounds、**不**再调 browser_attach：syncBounds 内部已经会在
            // "收起期间隐藏过"时按 urlRef 重新 attach 显示，够了。多这一次调用
            // 会在 current_page 读不到地址时触发宿主再导航一次，而那又发一次
            // started —— 变成面板无限刷新的回环。
            if (e.payload.phase === "started" && alive) {
              void syncBounds();
            }
            const title =
              e.payload.phase === "title"
                ? e.payload.title || hostOf(u)
                : undefined;
            updatePanelTab(tab.id, {
              url: u,
              ...(title !== undefined ? { title } : {}),
            });
          },
        ),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [tab.id, syncBounds]);

  // 全屏视图（设置等）覆盖主窗口时隐藏子 webview（base.tsx 广播）；
  // 返回应用后由 syncBounds 状态机恢复显示（面板展开 → 落位+attach）。
  useEffect(() => {
    if (!isTauri()) return;
    const onOccluded = (e: Event) => {
      setOccluded(
        (e as CustomEvent<{ occluded?: boolean }>).detail?.occluded ?? true,
      );
    };
    window.addEventListener("browser:occluded", onOccluded);
    return () => window.removeEventListener("browser:occluded", onOccluded);
  }, [setOccluded]);

  const navigate = (raw: string) => {
    const u = normalizeUrl(raw);
    if (!u) return;
    stack.current = [...stack.current.slice(0, cursor.current + 1), u];
    cursor.current = stack.current.length - 1;
    show(u);
  };

  const go = (delta: -1 | 1) => {
    const next = cursor.current + delta;
    if (next < 0 || next >= stack.current.length) return;
    cursor.current = next;
    show(stack.current[next]);
  };

  const reload = () => {
    if (!url) return;
    tauriCore()
      .then(({ invoke }) => invoke("browser_attach", { url, force: true }))
      .catch(() => {});
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    navigate(input);
  };

  const applyViewport = (p: VpPreset) => {
    setVp(
      p.mode === "fill"
        ? { mode: "fill", width: null, height: null }
        : { mode: "fixed", width: p.width, height: p.height },
    );
    if (!isTauri()) return;
    tauriCore()
      .then(({ invoke }) =>
        invoke("browser_viewport_set", {
          mode: p.mode,
          ...(p.mode === "fixed" ? { width: p.width, height: p.height } : {}),
        }),
      )
      .catch(() => {});
  };

  // inline-flex 居中：preflight 把 svg 变 display:block，普通按钮里图标会贴左上角
  const navBtn =
    "inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent size-7 shrink-0 rounded-md";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <button
          type="button"
          aria-label="Back"
          title="后退"
          disabled={cursor.current <= 0}
          onClick={() => go(-1)}
          className={cn(navBtn)}
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="前进"
          disabled={cursor.current >= stack.current.length - 1}
          onClick={() => go(1)}
          className={cn(navBtn)}
        >
          <ArrowRightIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="刷新"
          disabled={!url}
          onClick={reload}
          className={cn(navBtn)}
        >
          <RotateCwIcon className="size-4" />
        </button>
        <form onSubmit={onSubmit} className="min-w-0 flex-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="输入网址后回车"
            spellCheck={false}
            className="border-border/60 bg-muted/30 focus:bg-background focus:ring-ring/40 h-7 w-full rounded-full border px-3 font-mono text-xs outline-none transition-colors focus:ring-2"
          />
        </form>
        {loading ? (
          <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />
        ) : null}
      </div>
      {/* 常驻占位容器：子 webview 覆盖其上（宿主按 bounds 定位）；空态为覆盖层。
          固定视口时容器居中钳制一帧（CSS 表达），webview 跟随该帧 */}
      <div
        className={cn(
          "relative min-h-0 flex-1",
          vp.mode === "fixed" &&
            "bg-muted/40 flex items-center justify-center overflow-hidden",
        )}
      >
        <div
          ref={hostRef}
          style={
            vp.mode === "fixed"
              ? { width: vp.width ?? undefined, height: vp.height ?? undefined }
              : undefined
          }
          className={
            vp.mode === "fixed"
              ? "ring-border/60 relative max-h-full max-w-full bg-white ring-1 dark:bg-black"
              : "absolute inset-0 bg-white dark:bg-black"
          }
        />
        {!url ? (
          <div className="bg-background text-muted-foreground/60 absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center text-sm">
            <GlobeIcon className="size-10" />
            <p className="font-medium text-foreground/80">浏览器</p>
            <p className="text-muted-foreground/50 text-xs">
              粘贴或输入 URL 以打开网页，AI 也可通过 browser 工具驱动。
            </p>
          </div>
        ) : null}
      </div>
      {/* 视口档位条：填满 / 桌面 / 平板 / 手机 */}
      <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-1 border-t px-2 text-xs">
        <span className="text-muted-foreground/70 mr-1">视口</span>
        {VP_PRESETS.map((p) => {
          const active =
            p.mode === "fill"
              ? vp.mode === "fill"
              : vp.mode === "fixed" &&
                vp.width === p.width &&
                vp.height === p.height;
          return (
            <button
              key={p.label}
              type="button"
              title={
                p.mode === "fixed" ? `${p.width} × ${p.height}` : "填满面板"
              }
              onClick={() => applyViewport(p)}
              className={cn(
                "rounded px-1.5 py-0.5 transition-colors",
                active
                  ? "bg-muted text-foreground font-medium"
                  : "hover:bg-muted",
              )}
            >
              {p.label}
            </button>
          );
        })}
        {vp.mode === "fixed" && vp.width && vp.height ? (
          <span className="text-muted-foreground/60 ml-auto font-mono">
            {vp.width} × {vp.height}
          </span>
        ) : null}
      </div>
    </div>
  );
};
