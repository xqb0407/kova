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
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Loader2Icon,
  MousePointer2Icon,
  RotateCwIcon,
  SmartphoneIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useAui } from "@assistant-ui/react";
import { openExternal } from "@/lib/external-link";
import { isResizing, onResizeSettled } from "@/lib/ui/resize-session";
import { putElementRef } from "@/lib/element-refs";
import { toast } from "@/components/ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { updatePanelTab, type PanelTab } from "@/lib/panels/panel-tabs";
import { isDesktop } from "@/lib/desktop-env";
import { cn } from "@/lib/utils";
import type { ElectronWebviewElement } from "@/types/electron-webview";
import {
  BrowserDeviceToolbar,
  type ViewportState,
} from "./browser-device-toolbar";
import { BrowserConsolePanel } from "./browser-console-panel";

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

const desktopCore = () => import("@/desktop-bridge/core");

/**
 * 地址栏右侧「浏览器工具」下拉（仿 Trae）：
 * - 选择元素 → 自研页面拾取器（Chrome 元素拾取同款交互，见 browser.ts 的
 *   browser_pick_element）：点中的元素做成对话框芯片，芯片可点开详情
 *   （截图/选择器/HTML），并随消息发送（token = :element[标签]{name=选择器}）；
 * - 设备工具栏 / 控制台 / 开发者工具 → DevTools 定向命令（Electron 没有这些
 *   动作的 API，主进程把 DevTools 打开后往它的 webContents 发前端快捷键）。
 * Trae 菜单里的「CSS 检查器」在 Electron 里与「开发者工具」同义（DevTools
 * 默认面板就是 Elements/Styles），不摆重复项，改成独立的「控制台」。
 */
const TOOLS_ITEMS = [
  { kind: "pick", label: "选择元素", icon: MousePointer2Icon },
  // 设备工具栏是**应用自己的**开关（不是 DevTools 的）：开=固定尺寸模式并显示
  // 设备行（预设/W×H/旋转/拖拽手柄），关=回自适应并收起整行
  { kind: "device", label: "设备工具栏", icon: SmartphoneIcon },
  { kind: "command", command: "console", label: "控制台", icon: TerminalIcon },
  { kind: "command", command: "open", label: "开发者工具", icon: WrenchIcon },
] as const;

/** 设备工具栏默认档（开启时用；之后记住最后一次用过的尺寸） */
const DEFAULT_DEVICE = { width: 1280, height: 800 };

/** DevTools 同款点阵抓手（竖带 2×3、横带 3×2、角 2×2）；纯装饰，不吃指针 */
const GripDots: FC<{ cols: number; rows: number }> = ({ cols, rows }) => (
  <span
    aria-hidden
    className="pointer-events-none grid gap-[2px]"
    style={{
      gridTemplateColumns: `repeat(${cols}, 2px)`,
      gridTemplateRows: `repeat(${rows}, 2px)`,
    }}
  >
    {/* bg-current：颜色由外层容器给（默认浅、悬浮加深），点阵跟着走 */}
    {Array.from({ length: cols * rows }).map((_, i) => (
      <span key={i} className="bg-current block size-[2px] rounded-full" />
    ))}
  </span>
);

/** 拾取结果（主进程 browser_pick_element 的返回形状） */
type PickResult = {
  ok: boolean;
  cancelled?: boolean;
  timeout?: boolean;
  tag?: string;
  id?: string;
  classes?: string[];
  selector?: string;
  text?: string;
  html?: string;
  url?: string;
  title?: string;
  rect?: { x: number; y: number; width: number; height: number } | null;
  shot?: string | null;
};

/** 芯片 token 的字符约束：cm-directive 的正则禁止 label/name 含 ] { } 与换行 */
const cleanTokenText = (s: string) =>
  s.replace(/[[\]{}\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

/** 芯片可见文案：tag#id / tag.class / tag（对齐 Trae 那枚「a」芯片的信息密度） */
function pickChipLabel(r: PickResult): string {
  const tag = r.tag || "element";
  if (r.id) return `${tag}#${r.id}`;
  const cls = r.classes?.[0];
  return cls ? `${tag}.${cls}` : tag;
}

/**
 * 浏览器标签：地址栏 + `<webview>`（DOM 嵌入渲染，对齐参考实现的内置浏览器）。
 *
 * 为什么不是原生 WebContentsView：原生子视图合成在主 webview 之上，任何
 * React z-index 都压不住——历史上要靠「浮层出现即隐藏整个浏览器」补位，
 * 打开任意弹窗/菜单浏览器就空白，层级观感也是"浏览器永远在最上面"。
 * `<webview>` 是主文档里的普通元素：弹窗/菜单/遮罩天然盖在它上面、面板
 * 圆角与溢出裁剪随卡片走、切标签保留页面只需 CSS 隐藏而非销毁子视图。
 *
 * guest 的 webContents 由主进程驱动（did-attach 后经 browser_bind_guest
 * 绑定 id，agent 的 browser_* 工具驱动同一个 guest）；本组件负责：加载 URL、
 * 导航事件回流地址栏/历史栈/标签记录、视口档位的 CSS 尺寸。引擎自身历史
 * 不作事实源，前进/后退走本组件自维护的访问栈（与旧实现同口径）。
 *
 * `hidden`：pane 常驻面板（切到别的标签时由宿主绝对定位覆盖并隐藏），
 * guest 只有留在 DOM 里才保留页面状态——这是切标签不重载的关键。
 */
export const BrowserView: FC<{ tab: PanelTab; hidden?: boolean }> = ({
  tab,
  hidden = false,
}) => {
  const initial = tab.url ? normalizeUrl(tab.url) : null;
  const [url, setUrl] = useState<string | null>(initial);
  const [input, setInput] = useState(tab.url ?? "");
  const [loading, setLoading] = useState(false);
  /** 复制地址反馈态：打勾变绿 1.5s 后复原 */
  const [copied, setCopied] = useState(false);
  /** 页面元素拾取进行中（提示条 + 取消入口） */
  const [picking, setPicking] = useState(false);
  const aui = useAui();
  /** 视口模式（主进程为事实源，经 browser:viewport 事件同步；AI resize 同一状态） */
  const [vp, setVp] = useState<ViewportState>({
    mode: "fill",
    width: null,
    height: null,
  });
  /** 设备舞台尺寸：算缩放比用（固定尺寸大于舞台时按比例缩小显示） */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** 拖拽期间冻结的缩放（手放开置 null 回落到自动缩放） */
  const [dragScale, setDragScale] = useState<number | null>(null);
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  /**
   * 导航唯一通道 = `src` 属性（下面 navSrc 状态驱动）：Electron 的 webview
   * 「方法」（loadURL/reload/getWebContentsId）在 dom-ready 之前调用会**同步抛错**
   * （"must be attached to the DOM and the dom-ready event emitted"）——不是
   * Promise reject，`.catch` 接不住。属性通道由元素内部排队到 guest 就绪，
   * 任何时机都安全。导航一律 setNavSrc，绝不直接 loadURL。
   */
  const [navSrc, setNavSrc] = useState<string | null>(initial);
  /** 自维护访问栈（引擎历史不作事实源） */
  const [stack, setStack] = useState<string[]>(initial ? [initial] : []);
  const [cursor, setCursor] = useState(initial ? 0 : -1);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const stackRef = useRef(stack);
  stackRef.current = stack;

  /** 记录一次（导航事件 → 地址栏/栈/标签记录），同址去重 */
  const record = useCallback(
    (u: string) => {
      if (!/^(https?|file):\/\//.test(u)) return;
      setUrl(u);
      setInput(u);
      if (stackRef.current[cursorRef.current] !== u) {
        const next = [...stackRef.current.slice(0, cursorRef.current + 1), u];
        setStack(next);
        setCursor(next.length - 1);
        cursorRef.current = next.length - 1;
      }
      updatePanelTab(tab.id, { url: u, title: hostOf(u) });
    },
    [tab.id],
  );

  /**
   * 导航到 u：只走 src 属性通道（见 navSrc 注释）。两处防呆：
   * - 与实际页比对（agent 直接驱动 guest 后，navSrc 可能停留在旧值）：已在
   *   目标页则不动，否则会被 React 的"同值不写属性"吃掉这一次导航——后退
   *   按钮跳回一个恰与旧 navSrc 相同的 URL 时表现为"点了没反应"；
   * - 属性值恰好相同时先清空再写回（下一拍），强制产生一次属性变更。
   */
  const navigateTo = useCallback(
    (u: string) => {
      setInput(u);
      setUrl(u);
      const el = webviewRef.current;
      let current = "";
      try {
        current = el?.getURL() ?? "";
      } catch {
        current = "";
      }
      const norm = (s: string) => s.trim().replace(/\/+$/, "");
      if (current && norm(current) === norm(u)) return;
      if (navSrc === u) {
        setNavSrc(null);
        setTimeout(() => setNavSrc(u), 0);
        return;
      }
      setNavSrc(u);
    },
    [navSrc],
  );

  // 绑定 guest（主进程校验 getType；agent 工具靠它拿到句柄）。
  // getWebContentsId 也受「dom-ready 前不可调」约束：did-attach / dom-ready /
  // 挂载探测三处都试，成功即绑定（主进程侧幂等）
  useEffect(() => {
    if (!isDesktop()) return;
    const el = webviewRef.current;
    if (!el) return;
    let alive = true;
    const bindGuest = () => {
      if (!alive) return;
      let id = 0;
      try {
        id = el.getWebContentsId();
      } catch {
        return; // 还没 dom-ready：后续事件会再进
      }
      void desktopCore()
        .then(({ invoke }) => invoke("browser_bind_guest", { webContentsId: id }))
        .catch(() => {});
    };
    const onDidAttach = () => bindGuest();
    const onStartLoad = () => {
      setLoading(true);
    };
    const onStopLoad = () => {
      setLoading(false);
      // 地址栏信息以引擎实际落点为准（重定向/页面内跳转都覆盖）
      try {
        record(el.getURL());
      } catch {
        /* ignore */
      }
    };
    const onNavigate = (e: Event) => {
      const u = String((e as unknown as { url?: string }).url ?? "");
      if (u) record(u);
    };
    const onTitle = (e: Event) => {
      const title = String((e as unknown as { title?: string }).title ?? "");
      if (title) updatePanelTab(tab.id, { title });
    };
    el.addEventListener("did-attach", onDidAttach);
    el.addEventListener("dom-ready", onDidAttach);
    el.addEventListener("did-start-loading", onStartLoad);
    el.addEventListener("did-stop-loading", onStopLoad);
    el.addEventListener("did-navigate", onNavigate);
    el.addEventListener("did-navigate-in-page", onNavigate);
    el.addEventListener("page-title-updated", onTitle);
    // StrictMode 重放/挂载晚于 attach 时的兜底（未就绪时 bindGuest 自会返回）
    onDidAttach();
    return () => {
      alive = false;
      el.removeEventListener("did-attach", onDidAttach);
      el.removeEventListener("dom-ready", onDidAttach);
      el.removeEventListener("did-start-loading", onStartLoad);
      el.removeEventListener("did-stop-loading", onStopLoad);
      el.removeEventListener("did-navigate", onNavigate);
      el.removeEventListener("did-navigate-in-page", onNavigate);
      el.removeEventListener("page-title-updated", onTitle);
    };
  }, [record, tab.id]);

  // 切换浏览器标签：本组件是常驻单实例（跨标签复用同一个 `<webview>`），
  // 换标签必须按新标签重置本地视图状态——**空白新标签要回到空态**，否则
  // 上一个标签的页面残影会留在 <webview> 里，看起来像"新标签打开了旧页面"；
  // 带 url 的标签交给下面的 tab.url 效应导航过去。navSrc 刻意不动：
  // 清掉 src 属性有触发 about:blank 导航的风险，留着不影响显示
  const prevTabIdRef = useRef(tab.id);
  useEffect(() => {
    if (prevTabIdRef.current === tab.id) return;
    prevTabIdRef.current = tab.id;
    const next = tab.url ? normalizeUrl(tab.url) : null;
    setUrl(next);
    setInput(tab.url ?? "");
    if (next) {
      setStack([next]);
      setCursor(0);
      cursorRef.current = 0;
    } else {
      setStack([]);
      setCursor(-1);
      cursorRef.current = -1;
    }
  }, [tab.id, tab.url]);

  // 外部改写 tab.url（消息里 WebFetch 行 / agent 的 data-panelOpen 唤起）：
  // 与当前实际页面不同才导航，避免 record 写回 store 后触发自己形成回环
  useEffect(() => {
    if (!tab.url) return;
    const el = webviewRef.current;
    let current = "";
    try {
      current = el?.getURL() ?? "";
    } catch {
      current = "";
    }
    if (tab.url === current) return;
    const u = normalizeUrl(tab.url);
    if (u) navigateTo(u);
  }, [tab.url, navigateTo]);

  // 视口模式：挂载取当前值（AI resize 的面板外落位也回读），并跟随主进程事件
  useEffect(() => {
    if (!isDesktop()) return;
    desktopCore()
      .then(({ invoke }) => invoke<ViewportState>("browser_viewport_get"))
      .then((v) => setVp(v))
      .catch(() => {});
    let unlisten: (() => void) | undefined;
    import("@/desktop-bridge/event")
      .then(({ listen }) =>
        listen<ViewportState>("browser:viewport", (e) => setVp(e.payload)),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  const navigate = (raw: string) => {
    const u = normalizeUrl(raw);
    if (!u) return;
    navigateTo(u);
  };

  const go = (delta: -1 | 1) => {
    const next = cursor + delta;
    if (next < 0 || next >= stack.length) return;
    setCursor(next);
    cursorRef.current = next;
    navigateTo(stack[next]);
  };

  const reload = () => {
    try {
      webviewRef.current?.reload();
    } catch {
      /* ignore */
    }
  };

  /** 复制地址的短暂反馈：打勾变绿 1.5s 后复原 */
  const copyFeedbackTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );
  const pageUrl = (url ?? input).trim();
  /** 外链白名单同主进程 open_external：只有 http(s) 才给"在浏览器中打开" */
  const canOpenInBrowser = /^https?:\/\//i.test(pageUrl);

  const copyAddress = () => {
    if (!pageUrl) return;
    const done = () => {
      setCopied(true);
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    };
    // execCommand 兜底：非 secure 上下文/剪贴板被拒时（同 input-copy 的写法）
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = pageUrl;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) done();
      } catch {
        /* 复制失败静默：不打断浏览 */
      }
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(pageUrl).then(done).catch(fallback);
    } else {
      fallback();
    }
  };

  const openInSystemBrowser = () => {
    if (canOpenInBrowser) openExternal(pageUrl);
  };

  /** 浏览器工具下拉：主进程把 DevTools 打开并转发前端快捷键 */
  const runDevtoolsCommand = (command: string) => {
    if (!isDesktop()) return;
    desktopCore()
      .then(({ invoke }) => invoke("browser_devtools_command", { command }))
      .catch(() => {});
  };

  const cancelPick = () => {
    desktopCore()
      .then(({ invoke }) => invoke("browser_pick_cancel"))
      .catch(() => {});
  };

  /** 设备工具栏：**独立开关**（与"自适应/固定"解耦，DevTools 的 Responsive 同款语义）
   *  ——行内选「自适应（填满面板）」只退回填充视口，工具栏与 W×H 输入仍在；只有行上
   *  ✕ 才收起整行。任何来源把视口设成固定尺寸（AI resize/预设/输入/拖拽）自动点亮它 */
  const [deviceToolbar, setDeviceToolbar] = useState(false);
  const lastDeviceRef = useRef(DEFAULT_DEVICE);
  useEffect(() => {
    if (vp.mode === "fixed" && vp.width && vp.height) {
      lastDeviceRef.current = { width: vp.width, height: vp.height };
      setDeviceToolbar(true);
    }
  }, [vp]);
  const showDeviceToolbar = () => {
    setDeviceToolbar(true);
    applyVp({ mode: "fixed", ...lastDeviceRef.current });
  };
  const hideDeviceToolbar = () => {
    applyVp({ mode: "fill", width: null, height: null });
    setDeviceToolbar(false);
  };

  /** 页面元素拾取（Chrome 元素拾取同款）：选中 → 元素引用芯片进输入框。
   *  芯片 token `:element[标签]{name=选择器}` 随消息发送（模型可按选择器复核，
   *  浏览器工具随时可查）；点芯片弹详情 Dialog（截图/HTML，见 element-ref-dialog） */
  const pickElement = async () => {
    if (!isDesktop() || picking) return;
    setPicking(true);
    try {
      const { invoke } = await desktopCore();
      const res = await invoke<PickResult>("browser_pick_element");
      if (!res || res.ok !== true) {
        if (res?.timeout) toast.add({ title: "选择元素超时，已取消", type: "warning" });
        return; // 用户取消（Esc）不打扰
      }
      const label = pickChipLabel(res);
      const selector = cleanTokenText(res.selector || label) || label;
      putElementRef({
        label,
        selector,
        tag: res.tag ?? "",
        id: res.id ?? "",
        classes: res.classes ?? [],
        text: res.text ?? "",
        html: res.html ?? "",
        url: res.url ?? "",
        title: res.title ?? "",
        rect: res.rect ?? null,
        shot: res.shot ?? null,
      });
      const token = `:element[${cleanTokenText(label) || "element"}]{name=${selector}}`;
      let current = "";
      try {
        current = (aui.composer.getState() as { text?: string })?.text ?? "";
      } catch {
        current = "";
      }
      aui.composer.setText(
        current.trim() ? `${current.trimEnd()} ${token}` : token,
      );
      toast.add({ title: `已添加元素 ${label} 到输入框`, type: "success" });
    } catch {
      toast.add({ title: "选择元素失败（面板未就绪？）", type: "warning" });
    } finally {
      setPicking(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    navigate(input);
  };

  /** 同步视口到主进程（AI 尺寸认知一致性） */
  const syncVpToMain = (next: ViewportState) => {
    if (!isDesktop()) return;
    desktopCore()
      .then(({ invoke }) =>
        invoke("browser_viewport_set", {
          mode: next.mode,
          ...(next.mode === "fixed"
            ? { width: next.width ?? undefined, height: next.height ?? undefined }
            : {}),
        }),
      )
      .catch(() => {});
  };

  /** 应用视口（预设/自定义输入/旋转等显式动作）：回到居中并同步主进程。
   *  拖拽改写尺寸走 syncVpToMain——刻意**不**重置偏移，保住用户拖出来的位置 */
  const applyVp = (next: ViewportState) => {
    setVp(next);
    syncVpToMain(next);
  };

  // 设备舞台尺寸测量：固定尺寸大于舞台时按比例缩放（DevTools 同款，避免
  // 大设备在窄面板里溢出）；缩放只影响显示，网页视口按逻辑尺寸走
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () =>
      setStage({ w: el.clientWidth, h: el.clientHeight });
    // 宽度每帧变化时逐帧 setState 会重渲染整个浏览器面板（含 webview 包装
    // 层）；去抖到 100ms。拖拽调宽期间内容区已冻结，直接跳过，松手补一次
    let timer: number | undefined;
    const schedule = () => {
      if (isResizing()) return;
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        measure();
      }, 100);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    measure();
    const offSettled = onResizeSettled(measure);
    return () => {
      ro.disconnect();
      offSettled();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);
  const fixed = vp.mode === "fixed" && !!vp.width && !!vp.height;
  const scale =
    fixed && stage.w > 0 && stage.h > 0
      ? Math.min(
          1,
          (stage.w - 24) / (vp.width as number),
          (stage.h - 24) / (vp.height as number),
        )
      : 1;
  /** 渲染用缩放：拖拽中冻结（见 startResize），其余时候自动 */
  const effScale = dragScale ?? scale;
  /** 展示尺寸 = 真实尺寸：拖拽**实时回流**（Chrome DevTools 同款）——
   *  页面永远填满框，没有空白兜底、没有缩放变形。代价是重页面拖拽会掉帧
   *  （用户明确选择这条：观感正确优先于帧率）。 */
  const dispW = fixed ? (vp.width as number) : 0;
  const dispH = fixed ? (vp.height as number) : 0;
  /** 设备框在舞台里的屏幕坐标：**永远居中**（显式定位，左上角为原点）。
   *  "居中"是硬约束：拖任意一条边都是对称伸缩（两边同时变／上下同时变），
   *  不存在把框拖离中心的路径——也就没有"拖完停不到中间/跑到角落"的问题 */
  const frameLeft = fixed ? (stage.w - dispW * effScale) / 2 : 0;
  const frameTop = fixed ? (stage.h - dispH * effScale) / 2 : 0;

  /** 拖拽调整设备尺寸（左右下三边 + 四角抓手；顶部不可拖——与 DevTools 同）。
   *  **等高线式对称伸缩**：设备框永远居中，拖左/右缘宽度按 2×指针位移变化
   *  （拖的那条边 1:1 跟手、对边镜像跟随），拖下缘高度同理，四角两轴合并；
   *  尺寸顶到上下限时两边同时停住（不累计偏移）。
   *  性能：拖拽期间**只更新预览值**（transform 缩放，合成器负担），
   *  `<webview>` 的真实尺寸与主进程同步都推迟到松手一次完成。
   *  指针捕获（setPointerCapture）：松手/滑出窗口/触摸取消都能可靠收尾。 */
  const dragSizeRef = useRef<{ w: number; h: number } | null>(null);
  const startResize =
    (ax: "e" | "w" | null, ay: "n" | "s" | null) => (e: React.PointerEvent) => {
      if (!fixed || !vp.width || !vp.height) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败仍可拖：window 监听兜底 */
      }
      const pid = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = vp.width;
      const startH = vp.height;
      // 拖拽期间冻结缩放：尺寸变大触发的自动缩放会让"跟手"的几何前提失效
      // （渲染尺寸跟着缩放跳），冻结后拖拽全程 1:1 跟手，松手再按新尺寸重算
      const k = effScale || 1;
      setDragScale(k);
      dragSizeRef.current = { w: startW, h: startH };
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor =
        ax && ay
          ? (ax === "e") === (ay === "s")
            ? "nwse-resize"
            : "nesw-resize"
          : ax
            ? "ew-resize"
            : "ns-resize";
      const clampSize = (v: number) => Math.max(200, Math.min(4000, Math.round(v)));
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        const dxs = ev.clientX - startX;
        const dys = ev.clientY - startY;
        const dx = dxs / k;
        const dy = dys / k;
        // 对称伸缩：拖的那条边 1:1 跟手 ⇒ 尺寸按 2×位移变（对边镜像跟随=居中）。
        // 钳制在 w/h 上完成，两边同时停住，没有任何累计量
        let w = startW;
        let h = startH;
        if (ax === "e") w = startW + dx * 2;
        if (ax === "w") w = startW - dx * 2;
        if (ay === "s") h = startH + dy * 2;
        if (ay === "n") h = startH - dy * 2;
        w = clampSize(w);
        h = clampSize(h);
        dragSizeRef.current = { w, h };
        // 实时回流：直接改真实尺寸（webview 每帧随指针重排，DevTools 同款）
        setVp({ mode: "fixed", width: w, height: h });
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          el.releasePointerCapture(pid);
        } catch {
          /* ignore */
        }
        document.body.style.cursor = prevCursor;
        const final = dragSizeRef.current;
        dragSizeRef.current = null;
        setDragScale(null);
        if (final) {
          // 尺寸过程已实时写进 vp，这里只补一次主进程同步与解冻缩放
          applyVp({ mode: "fixed", width: final.w, height: final.h });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

  // inline-flex 居中：preflight 把 svg 变 display:block，普通按钮里图标会贴左上角
  const navBtn =
    "inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent size-7 shrink-0 rounded-md";

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col",
        hidden && "invisible pointer-events-none",
      )}
      aria-hidden={hidden || undefined}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <button
          type="button"
          aria-label="Back"
          title="后退"
          disabled={cursor <= 0}
          onClick={() => go(-1)}
          className={cn(navBtn)}
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="前进"
          disabled={cursor >= stack.length - 1}
          onClick={() => go(1)}
          className={cn(navBtn)}
        >
          <ArrowRightIcon className="size-4" />
        </button>
        {/* 刷新与加载状态共用这一个按钮（浏览器惯例）：加载中转圈，点击即刷新。
            原先地址栏右侧还有一个独立加载图标，已并入这里 */}
        <button
          type="button"
          aria-label={loading ? "加载中，点击刷新" : "刷新"}
          title="刷新"
          disabled={!url}
          onClick={reload}
          className={cn(navBtn)}
        >
          {loading ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <RotateCwIcon className="size-4" />
          )}
        </button>
        <form onSubmit={onSubmit} className="group/addr relative min-w-0 flex-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="输入网址后回车"
            spellCheck={false}
            /* 不要 focus 激活态（用户点名）：聚焦不换底色、不加 ring，
               鼠标点进来与静止时完全一致。pr-16 给右侧悬浮工具留位 */
            className="bg-muted h-7 w-full rounded-full  py-0 pr-16 pl-3 font-mono text-xs outline-none"
          />
          {/* 悬浮工具（仿 Trae）：复制地址 + 在系统浏览器打开。
              复制成功变绿勾 1.5s（期间保持可见）；file:// 不给外链入口
              （open_external 白名单只放 http(s)） */}
          {pageUrl ? (
            <div
              className={cn(
                "absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5 transition-opacity",
                copied ? "opacity-100" : "opacity-0 group-hover/addr:opacity-100",
              )}
            >
              <button
                type="button"
                aria-label={copied ? "已复制" : "复制地址"}
                title={copied ? "已复制" : "复制地址"}
                onClick={copyAddress}
                className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
              >
                {copied ? (
                  <CheckIcon className="size-3.5 text-green-600 dark:text-green-400" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </button>
              {canOpenInBrowser ? (
                <button
                  type="button"
                  aria-label="在浏览器中打开"
                  title="在浏览器中打开"
                  onClick={openInSystemBrowser}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
        {/* 地址栏右侧浏览器工具（仿 Trae）：DOM 下拉天然盖在 webview 之上
            （这正是迁 <webview> 换来的能力，旧的浮层让位机制已退役） */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="浏览器工具"
                title="浏览器工具"
                className={cn(navBtn)}
              >
                <ChevronDownIcon className="size-4" />
              </button>
            }
          />
          <DropdownMenuContent align="end" sideOffset={6} className="w-48">
            {TOOLS_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <DropdownMenuItem
                  key={item.label}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
                  onClick={() => {
                    if (item.kind === "pick") void pickElement();
                    else if (item.kind === "device") showDeviceToolbar();
                    else runDevtoolsCommand(item.command);
                  }}
                >
                  <Icon className="size-4" />
                  {item.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* 设备工具栏（仿 DevTools 设备模式）：独立开关，不常驻——⌄ 菜单进入、
          行上 ✕ 退出；行内选「自适应（填满面板）」只改视口，不收行 */}
      {deviceToolbar ? (
        <BrowserDeviceToolbar
          vp={vp}
          scale={effScale}
          onApply={applyVp}
          onClose={hideDeviceToolbar}
        />
      ) : null}
      {/* 设备舞台：fill 撑满面板；fixed 固定逻辑尺寸居中，超出舞台按 scale 缩放
          显示（只影响显示，网页视口按逻辑尺寸走）。空态为覆盖层 */}
      <div
        ref={stageRef}
        className={cn(
          "relative min-h-0 flex-1",
          fixed && "bg-muted/40 overflow-hidden",
        )}
      >
        {isDesktop() ? (
          // 两层结构：**外壳**管定位/变换并挂抓手（抓手有一半在框外，
          // 挂在外壳才不会被内盒的裁剪切掉），**内盒**管裁剪/底色/描边
          <div
            className={cn(!fixed && "relative h-full w-full")}
            style={
              fixed
                ? {
                    // 显式绝对定位 + 左上角为缩放原点：居中（两边对称伸缩）的
                    // 几何关系直接落在 left/top 上，一眼可验。
                    // 拖拽期间盒子用预览尺寸（跟手），webview 内容自持原尺寸
                    // （下面单独钉），多出区域由内盒底色兜住 + 裁剪
                    position: "absolute",
                    left: frameLeft,
                    top: frameTop,
                    width: dispW || undefined,
                    height: dispH || undefined,
                    transform: effScale !== 1 ? `scale(${effScale})` : undefined,
                    transformOrigin: "top left",
                  }
                : undefined
            }
          >
            {/* 护边框（DevTools 设备模式同款，**一体成形**）：左右下三边连成
                一条灰环、转角自然相接（三条独立的带子会看出接缝）；顶部不包
                ——上缘就是页面顶，交给设备工具栏那一条。抓点就落在它上面。
                必须排在内盒之前：同为定位元素、后者按 DOM 顺序压在上面 */}
            {fixed ? (
              <div
                aria-hidden
                className="bg-foreground/10 pointer-events-none absolute top-0 -right-2.5 -bottom-2.5 -left-2.5 rounded-b-xl"
              />
            ) : null}
            {/* 内盒：页面所在的矩形本体（裁剪 + 页面底色） */}
            <div
              className={cn(
                "relative h-full w-full",
                fixed && "overflow-hidden bg-white dark:bg-black",
              )}
            >
              <webview
                ref={webviewRef}
                src={navSrc ?? undefined}
                partition="persist:browser-panel"
                // 与旧原生视图同口径：隔离 + 无 node；guest 的 window.open 由
                // 主进程在绑定时统一拒绝（browser.ts）
                webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
                // 铺满内盒：内盒尺寸拖拽时实时变化 ⇒ 页面实时回流（DevTools 同款）
                className="border-0 bg-white dark:bg-black h-full w-full"
              />
            </div>
            {fixed ? (
              // 包装层不定位（抓手仍相对设备框绝对定位），只为统一施加
              // touch-action:none——触摸拖动走 resize 而不是被当成页面滚动
              <div className="[&>div]:touch-none">
                {/* 抓手（DevTools 设备模式同款）：**只有左右下三边 + 左下/右下
                    两角**（顶部连角点都不给，上缘交给设备工具栏那条）。
                    抓点直接落在护边框灰环上（热区比抓点宽，好点中）：
                    边 16px 热区、角 20px 热区；点阵颜色 default/悬浮两档 */}
                {/* 右缘 */}
                <div
                  onPointerDown={startResize("e", null)}
                  title="拖动调整尺寸"
                  className="group/rz text-foreground/40 hover:text-foreground/70 absolute top-3 bottom-3 -right-2 flex w-4 cursor-ew-resize items-center justify-end"
                >
                  <span className="flex h-10 w-2 items-center justify-center">
                    <GripDots cols={2} rows={3} />
                  </span>
                </div>
                {/* 左缘 */}
                <div
                  onPointerDown={startResize("w", null)}
                  title="拖动调整尺寸"
                  className="group/rz text-foreground/40 hover:text-foreground/70 absolute top-3 bottom-3 -left-2 flex w-4 cursor-ew-resize items-center justify-start"
                >
                  <span className="flex h-10 w-2 items-center justify-center">
                    <GripDots cols={2} rows={3} />
                  </span>
                </div>
                {/* 下缘 */}
                <div
                  onPointerDown={startResize(null, "s")}
                  title="拖动调整尺寸"
                  className="group/rz text-foreground/40 hover:text-foreground/70 absolute right-3 left-3 -bottom-2 flex h-4 cursor-ns-resize items-end justify-center"
                >
                  <span className="flex h-2 w-10 items-center justify-center">
                    <GripDots cols={3} rows={2} />
                  </span>
                </div>
                {/* 左下 / 右下两角（顶部两角不设） */}
                <div
                  onPointerDown={startResize("e", "s")}
                  title="拖动调整尺寸"
                  className="group/rz text-foreground/40 hover:text-foreground/70 absolute -right-2.5 -bottom-2.5 flex size-5 cursor-nwse-resize items-center justify-center"
                >
                  <GripDots cols={2} rows={2} />
                </div>
                <div
                  onPointerDown={startResize("w", "s")}
                  title="拖动调整尺寸"
                  className="group/rz text-foreground/40 hover:text-foreground/70 absolute -bottom-2.5 -left-2.5 flex size-5 cursor-nesw-resize items-center justify-center"
                >
                  <GripDots cols={2} rows={2} />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {!url ? (
          <div className="bg-background text-muted-foreground/60 absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center text-sm">
            <GlobeIcon className="size-10" />
            <p className="font-medium text-foreground/80">浏览器</p>
            <p className="text-muted-foreground/50 text-xs">
              粘贴或输入 URL 以打开网页，AI 也可通过 browser 工具驱动。
            </p>
          </div>
        ) : null}
        {/* 拾取中的操作提示条：页面里已有高亮与标签徽标，这里给全局状态与取消入口 */}
        {picking ? (
          <div className="bg-foreground/90 text-background absolute top-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1 text-xs shadow-lg">
            <MousePointer2Icon className="size-3.5" />
            点击页面中的元素以选中（Esc 取消）
            <button
              type="button"
              onClick={cancelPick}
              className="hover:bg-background/20 ml-1 rounded-full px-1.5 py-0.5"
            >
              取消
            </button>
          </div>
        ) : null}
      </div>
      {/* 底部控制台（替代原视口档位条）：日志列表 / 级别过滤 / 清除 / 添加到对话 */}
      <BrowserConsolePanel pageUrl={pageUrl} />
    </div>
  );
};
