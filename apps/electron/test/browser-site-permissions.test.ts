import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearBrowserSitePermissions,
  createBrowserSitePermissionStore,
  getBrowserSitePermission,
  getBrowserSitePermissionSnapshot,
  initBrowserSitePermissions,
  resetBrowserSitePermissionsForTest,
  writeBrowserSitePermission,
} from "../main/browser-site-permissions";

const dirs: string[] = [];

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "kova-browser-perms-"));
  dirs.push(dir);
  const file = join(dir, "browser-site-permissions.json");
  return { dir, file, store: createBrowserSitePermissionStore(file) };
}

afterEach(() => {
  resetBrowserSitePermissionsForTest();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("browser site permissions", () => {
  test("write → persist → reload 保留记录的 allow/deny", async () => {
    const { file, store } = tempStore();
    await initBrowserSitePermissions({ store });
    await writeBrowserSitePermission("https://example.com", "geolocation", "allow");
    await writeBrowserSitePermission("https://example.com", "media", "deny");

    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw["https://example.com"]).toEqual({ geolocation: "allow", media: "deny" });

    resetBrowserSitePermissionsForTest();
    await initBrowserSitePermissions({ store });
    expect(getBrowserSitePermission("https://example.com", "geolocation")).toBe("allow");
    expect(getBrowserSitePermission("https://example.com", "media")).toBe("deny");
    expect(getBrowserSitePermission("https://other.test", "media")).toBeUndefined();
  });

  test("清空后记录与磁盘都归零", async () => {
    const { file, store } = tempStore();
    await initBrowserSitePermissions({ store });
    await writeBrowserSitePermission("https://example.com", "media", "allow");
    await clearBrowserSitePermissions();
    expect(getBrowserSitePermissionSnapshot()).toEqual({});
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  test("脏 JSON / 非法值按空记录处理，不会错误放行", async () => {
    const { dir, file, store } = tempStore();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "{not json");
    await initBrowserSitePermissions({ store });
    expect(getBrowserSitePermissionSnapshot()).toEqual({});

    resetBrowserSitePermissionsForTest();
    writeFileSync(
      file,
      JSON.stringify({
        "https://example.com": { geolocation: "yes", media: "deny" },
        "https://bad.test": "oops",
        "https://array.test": ["allow"],
      }),
    );
    await initBrowserSitePermissions({ store });
    expect(getBrowserSitePermissionSnapshot()).toEqual({
      "https://example.com": { media: "deny" },
    });
  });
});
