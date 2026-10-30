/**
 * 导航结果判定（纯函数，bun test 直接覆盖）：
 * 以前 browser_navigate 要求最终 URL 与请求 URL 完全一致，任何正常重定向
 * （http→https、/→/login、短链）都会被当成错误抛给模型。现在重定向算成功，
 * 只在结果里标注最终落点；真正失败（空页、错误页、readyState 未完成）才报错。
 */

export function normalizeUrlForCompare(raw: string): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

export function isSamePage(a: string, b: string): boolean {
  const na = normalizeUrlForCompare(a);
  return na.length > 0 && na === normalizeUrlForCompare(b);
}

export type NavigationOutcome =
  | { ok: true; url: string; redirected: boolean }
  | { ok: false; reason: "no-page" | "error-page" | "empty-url" };

export function classifyNavigation(input: {
  requested: string;
  landed: string;
  readyState: string;
  /** waitStable 是否看到过 complete + 非 about:blank 的页面 */
  sawPage: boolean;
}): NavigationOutcome {
  const landed = (input.landed ?? "").trim();
  if (!input.sawPage || landed.length === 0 || landed === "about:blank") {
    return { ok: false, reason: "no-page" };
  }
  if (/^chrome-error:\/\//i.test(landed)) {
    return { ok: false, reason: "error-page" };
  }
  return {
    ok: true,
    url: landed,
    redirected: !isSamePage(input.requested, landed),
  };
}

/** 导航失败时的可读原因（工具错误串，模型按字面理解，别随意改前缀）。 */
export function navigationFailure(reason: Exclude<NavigationOutcome, { ok: true }>["reason"]): string {
  if (reason === "error-page") {
    return "browser navigation did not load: Chromium showed an error page (DNS/refused/security). Check the URL or network and retry.";
  }
  if (reason === "empty-url") {
    return "browser navigation did not load: the panel has no URL after the load. Reopen the browser panel and retry.";
  }
  return "browser navigation did not load: the panel stayed on about:blank or never reached readyState=complete. The browser panel may not be open or attached yet — open it, or retry browser_navigate.";
}
