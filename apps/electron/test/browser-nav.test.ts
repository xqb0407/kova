import { describe, expect, test } from "bun:test";
import { classifyNavigation, isSamePage, navigationFailure } from "../main/browser-nav";

describe("browser navigation outcome", () => {
  test("同页（仅尾部斜杠差异）不算重定向", () => {
    expect(isSamePage("https://example.com/", "https://example.com")).toBe(true);
    const outcome = classifyNavigation({
      requested: "https://example.com/",
      landed: "https://example.com",
      readyState: "complete",
      sawPage: true,
    });
    expect(outcome).toEqual({ ok: true, url: "https://example.com", redirected: false });
  });

  test("http→https / 登录跳转算成功并标注 redirected", () => {
    const outcome = classifyNavigation({
      requested: "http://example.com/",
      landed: "https://example.com/",
      readyState: "complete",
      sawPage: true,
    });
    expect(outcome).toEqual({ ok: true, url: "https://example.com/", redirected: true });

    const login = classifyNavigation({
      requested: "https://app.test/dashboard",
      landed: "https://app.test/login?next=%2Fdashboard",
      readyState: "complete",
      sawPage: true,
    });
    expect(login.ok).toBe(true);
    expect(login.ok && login.redirected).toBe(true);
  });

  test("错误页 / about:blank / 未见页面判失败", () => {
    expect(
      classifyNavigation({
        requested: "https://nope.test",
        landed: "chrome-error://chromewebdata/",
        readyState: "complete",
        sawPage: true,
      }),
    ).toEqual({ ok: false, reason: "error-page" });
    expect(
      classifyNavigation({
        requested: "https://nope.test",
        landed: "about:blank",
        readyState: "complete",
        sawPage: false,
      }),
    ).toEqual({ ok: false, reason: "no-page" });
    expect(
      classifyNavigation({
        requested: "https://nope.test",
        landed: "https://nope.test/",
        readyState: "loading",
        sawPage: false,
      }),
    ).toEqual({ ok: false, reason: "no-page" });
  });

  test("失败原因为可读错误串", () => {
    expect(navigationFailure("error-page")).toContain("error page");
    expect(navigationFailure("no-page")).toContain("about:blank");
  });
});
