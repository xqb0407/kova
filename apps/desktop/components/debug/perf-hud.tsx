"use client";

/**
 * 屏上性能自检：左下角一行实时数字 + 把汇总写进应用自己的日志。
 *
 * 两个出口，都**不需要 devtools**：
 *  1. 屏幕上那一行（仅开发构建）：`fps 57 · 最长帧 42ms · 卡顿 3 · 渲染 消息流 216ms`
 *     点一下就复制整段会话汇总。
 *  2. `console.warn` 定期上报（**所有构建**）→ 桌面端的 frontend-logging 会把它
 *     转发到 `~/Library/Logs/com.kova.assistant/<日期>/web.log`（见
 *     lib/frontend-logging.ts 与 src-tauri/src/logging.rs）。这样打包版的真实
 *     运行数据也能被直接读到，不必让用户开 devtools 或复述数字。
 *
 * 为什么不能用 devtools 测：Web Inspector 挂在 WKWebView 上本身就会让页面明显
 * 变慢（录制 Timeline、尤其带截图采集更是重上加重）——用它测性能等于测它自己。
 * 这个模块量的就是平时（无 devtools）的真实环境。
 *
 * 读法：**fps 低但「渲染」很小 → 瓶颈在布局/绘制；「渲染」在刷大数字 → 组件重渲**。
 * 两者修法完全不同，先分清再动手。
 *
 * 关掉它：把 REPORT 改 false（上报）或删掉 layout 里的 <PerfHud />（屏幕那行）。
 */

import { useEffect, useRef, useState } from "react";
import { takeFacts, takeWorst } from "./perf-store";

/** 屏幕那行只在开发构建显示；日志上报所有构建都跑（fps 不需要 Profiler） */
const SHOW_HUD = process.env.NODE_ENV !== "production";
const REPORT = true;
/** 无卡顿时最多这么久上报一次；有卡顿则每个结算窗口都报 */
const REPORT_IDLE_MS = 10_000;
const WINDOW_MS = 500;

type Session = {
  worstFps: number;
  worstFrame: number;
  janks: number;
  windows: number;
  renders: Map<string, number>;
  /** 最近若干窗口的 fps（取最小 = 近况最差帧率），随汇总行上报 */
  recentFps: number[];
  /** 最近 30 个窗口的「本窗口最慢渲染」，用于在**同一会话内**读改动前后——
   *  会话累计最大值会把历史峰值一直带着，改完就再也看不出变化（踩过）。 */
  recent: { ms: number; label: string }[];
  facts: Map<string, number>;
};

const newSession = (): Session => ({
  worstFps: Infinity,
  worstFrame: 0,
  janks: 0,
  windows: 0,
  renders: new Map(),
  recent: [],
  recentFps: [],
  facts: new Map(),
});

const sessionText = (s: Session): string =>
  [
    `窗口 ${s.windows}`,
    `最差 fps ${s.worstFps === Infinity ? "-" : s.worstFps.toFixed(1)}`,
    `最长帧 ${s.worstFrame.toFixed(0)}ms`,
    `卡顿帧 ${s.janks}`,
    `最慢渲染 ${[...s.renders].map(([l, ms]) => `${l}=${ms.toFixed(0)}ms`).join(",") || "-"}`,
    `近况最慢 ${(() => {
      const r = (s.recent ?? []).slice(-60);
      if (r.length === 0) return "-";
      const top = [...r].sort((a, b) => b.ms - a.ms)[0]!;
      return `${top.label}=${top.ms.toFixed(0)}ms（最近 ${new Set(r.map((x) => x.label)).size} 项中的峰值）`;
    })()}`,
    `近况最差fps ${(() => {
      const r = (s.recentFps ?? []).slice(-120);
      return r.length ? `${Math.min(...r).toFixed(1)}（最近 ${r.length} 窗口）` : "-";
    })()}`,
    `上下文 ${[...s.facts].map(([l, v]) => `${l}=${v}`).join(",") || "-"}`,
  ].join(" ");

export function PerfHud() {
  const [line, setLine] = useState("采样中…");
  const [copied, setCopied] = useState(false);
  const sessionRef = useRef<Session>(newSession());

  useEffect(() => {
    if (!REPORT) return;
    let frames = 0;
    let worstFrame = 0;
    let janks = 0;
    let last = performance.now();
    let windowStart = last;
    let lastReport = last;
    let raf = 0;

    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      frames += 1;
      if (dt > worstFrame) worstFrame = dt;
      if (dt > 33) janks += 1;

      if (now - windowStart >= WINDOW_MS) {
        const secs = (now - windowStart) / 1000;
        const fps = frames / secs;
        const renders = takeWorst().sort((a, b) => b[1] - a[1]);
        const s = sessionRef.current;
        // HMR 换模块后旧组件实例的 session 可能缺新字段（facts 就是这么崩的：
        // 一次 TypeError 打断 rAF 循环，采样从此静默死去）。缺失就地补齐。
        s.facts ??= new Map();
        s.renders ??= new Map();
        for (const [label, value] of takeFacts()) {
          if (value > (s.facts.get(label) ?? 0)) s.facts.set(label, value);
        }
        s.windows += 1;
        if (fps < s.worstFps) s.worstFps = fps;
        s.recentFps ??= [];
        s.recentFps.push(fps);
        if (s.recentFps.length > 120) s.recentFps.splice(0, 60);
        if (worstFrame > s.worstFrame) s.worstFrame = worstFrame;
        s.janks += janks;
        for (const [label, ms] of renders) {
          if (ms > (s.renders.get(label) ?? 0)) s.renders.set(label, ms);
          s.recent ??= [];
          s.recent.push({ ms, label });
          if (s.recent.length > 300) s.recent.splice(0, 150); // 约近 30 个窗口
        }

        if (SHOW_HUD) {
          setLine(
            `fps ${fps.toFixed(0)} · 最长帧 ${worstFrame.toFixed(0)}ms · 卡顿 ${janks}` +
              (renders.length
                ? ` · 渲染 ${renders.map(([l, ms]) => `${l} ${ms.toFixed(0)}ms`).join(" / ")}`
                : ""),
          );
        }

        // 上报：有卡顿就报，否则闲时每 REPORT_IDLE_MS 报一次。console.warn 会被
        // 桌面端转发进 web.log（浏览器里就是普通 console，无害）。
        // 内联图片体检（每 10 个窗口一次）：base64 data URL 直接挂在 img.src 上，
        // 它的总量就是浏览器每帧要背负的解码/绘制/内存量
        if (s.windows % 10 === 0 && typeof document !== "undefined") {
          let count = 0;
          let dataBytes = 0;
          let dataCount = 0;
          // 解码像素总量才是绘制的真实成本：一张 2000×2000 的图是 400 万像素，
          // 240 的缩略图是 5.7 万——差 70 倍。只数 data: 的张数会漏掉 blob: 的
          // （Blob URL 改动生效后图都变 blob:，那一栏会假装"没图"）
          let px = 0;
          let loaded = 0;
          for (const img of document.querySelectorAll("img")) {
            const src = img.getAttribute("src") ?? "";
            count += 1;
            if (src.startsWith("data:")) {
              dataCount += 1;
              dataBytes += src.length;
            }
            if (img.complete && img.naturalWidth > 0) {
              px += img.naturalWidth * img.naturalHeight;
              loaded += 1;
            }
          }
          s.facts ??= new Map();
          s.facts.set("图张数", count);
          s.facts.set("其中data", dataCount);
          s.facts.set("data_MB", Math.round((dataBytes / 1024 / 1024) * 10) / 10);
          s.facts.set("已解码张数", loaded);
          s.facts.set("解码像素_MP", Math.round(px / 1e6));
        }

        const idle = now - lastReport >= REPORT_IDLE_MS;
        if (janks > 0 || idle) {
          lastReport = now;
          console.warn(`[perf] ${sessionText(s)}`);
        }

        frames = 0;
        worstFrame = 0;
        janks = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!SHOW_HUD) return null;

  const copy = async () => {
    const text = `[perf] ${sessionText(sessionRef.current)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      console.log(text);
    }
  };

  return (
    <div
      onClick={copy}
      title="点一下复制性能汇总"
      className="bg-background/80 text-muted-foreground border-border fixed bottom-1 left-1 z-100 max-w-[80vw] cursor-pointer truncate rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums backdrop-blur-sm select-none"
    >
      {copied ? "已复制到剪贴板 ✓" : line}
    </div>
  );
}
