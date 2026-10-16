/**
 * Electron `<webview>` 的 JSX 类型声明（主窗口 webPreferences.webviewTag=true）。
 *
 * 面板内置浏览器走 `<webview>`（DOM 嵌入渲染，对齐 ZCode 内置浏览器）：
 * guest 的 webContents 由主进程经 did-attach 上报的 id 绑定驱动
 * （apps/electron/main/browser.ts 的 browser_bind_guest），渲染端只用到下面
 * 这些属性与方法。只声明用得到的部分——Electron 的完整 webview API 面很大，
 * 照抄一遍只会让类型漂移没人维护。
 */
import type { DetailedHTMLProps, HTMLAttributes } from "react";

/** `<webview>` 元素实例（自定义元素，方法由 Electron 注入到原型） */
export interface ElectronWebviewElement extends HTMLElement {
  src: string;
  /** 导航到 url；返回 Promise（失败 reject 一个 Error） */
  loadURL(url: string, options?: Record<string, unknown>): Promise<void>;
  /** 当前页 url（未加载时为空串） */
  getURL(): string;
  reload(): void;
  /** guest 的 webContents id（did-attach 后才有；用于主进程绑定） */
  getWebContentsId(): number;
}

type WebviewProps = DetailedHTMLProps<
  HTMLAttributes<ElectronWebviewElement>,
  ElectronWebviewElement
> & {
  src?: string;
  partition?: string;
  /** Electron 的布尔属性以字符串存在（"true"） */
  allowpopups?: string;
  /** guest 的 webPreferences 覆写，形如 "contextIsolation=yes,sandbox=yes" */
  webpreferences?: string;
  useragent?: string;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps;
    }
  }
}
