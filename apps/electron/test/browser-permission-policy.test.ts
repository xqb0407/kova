import { describe, expect, test } from "bun:test";
import {
  applyBrowserPermissionPolicy,
  originFromUrl,
  type BrowserPermissionAction,
  type BrowserPermissionRequestDetails,
  type BrowserPermissionSessionLike,
} from "../main/browser-permission-policy";

type GrantCallback = (granted: boolean) => void;
type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: GrantCallback,
  details: BrowserPermissionRequestDetails,
) => void;
type CheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details?: unknown,
) => boolean;

class FakeSession implements BrowserPermissionSessionLike {
  requestHandler: RequestHandler | null = null;
  checkHandler: CheckHandler | null = null;
  deviceHandler: ((details: unknown) => boolean) | null = null;
  displayHandler: ((request: unknown, callback: (streams: unknown) => void) => void) | null = null;
  listeners = new Map<string, (...args: unknown[]) => void>();

  setPermissionRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
  }
  setPermissionCheckHandler(handler: CheckHandler): void {
    this.checkHandler = handler;
  }
  setDevicePermissionHandler(handler: (details: unknown) => boolean): void {
    this.deviceHandler = handler;
  }
  setDisplayMediaRequestHandler(
    handler: (request: unknown, callback: (streams: unknown) => void) => void,
  ): void {
    this.displayHandler = handler;
  }
  on(event: "select-hid-device" | "select-usb-device" | "select-serial-port", listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener);
  }

  request(permission: string, details: BrowserPermissionRequestDetails): Promise<boolean> {
    if (!this.requestHandler) throw new Error("request handler missing");
    return new Promise((resolve) => {
      this.requestHandler!({}, permission, resolve, details);
    });
  }

  check(permission: string, origin: string): boolean {
    if (!this.checkHandler) throw new Error("check handler missing");
    return this.checkHandler({}, permission, origin);
  }
}

const ORIGIN = "https://example.com";
const PAGE = `${ORIGIN}/page`;

function setup(options?: {
  prompt?: (request: { origin: string; permission: string; mediaTypes?: readonly string[] }) => Promise<BrowserPermissionAction>;
  automation?: boolean;
  site?: Map<string, "allow" | "deny">;
}) {
  const session = new FakeSession();
  const site = options?.site ?? new Map<string, "allow" | "deny">();
  const writes: Array<{ origin: string; permission: string; state: "allow" | "deny" }> = [];
  const prompts: Array<{ origin: string; permission: string; mediaTypes?: readonly string[] }> = [];
  applyBrowserPermissionPolicy(session, {
    logger: { info: () => {}, warn: () => {} },
    prompt: options?.prompt
      ? (request) => {
          prompts.push(request);
          return options.prompt!(request);
        }
      : undefined,
    getSitePermission: (origin, permission) => site.get(`${origin}|${permission}`),
    writeSitePermission: (origin, permission, state) => {
      site.set(`${origin}|${permission}`, state);
      writes.push({ origin, permission, state });
    },
    isAutomationActive: options?.automation ? () => true : undefined,
  });
  return { session, site, writes, prompts };
}

describe("browser permission policy", () => {
  test("无害白名单静默放行", async () => {
    const { session, prompts } = setup();
    for (const permission of [
      "clipboard-sanitized-write",
      "fullscreen",
      "pointerLock",
      "mediaKeySystem",
    ]) {
      expect(await session.request(permission, { requestingUrl: PAGE })).toBe(true);
      expect(session.check(permission, ORIGIN)).toBe(true);
    }
    expect(prompts).toHaveLength(0);
  });

  test("敏感权限经弹窗：仅本次允许在会话内复用，不重复询问", async () => {
    const { session, prompts } = setup({ prompt: async () => "allow-session" });
    expect(await session.request("geolocation", { requestingUrl: PAGE })).toBe(true);
    expect(await session.request("geolocation", { requestingUrl: PAGE })).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].origin).toBe(ORIGIN);
    expect(prompts[0].permission).toBe("geolocation");
    expect(session.check("geolocation", ORIGIN)).toBe(true);
  });

  test("始终允许写入站点记录，后续请求不再询问", async () => {
    const { session, prompts, site, writes } = setup({ prompt: async () => "allow-always" });
    expect(await session.request("media", { requestingUrl: PAGE, mediaTypes: ["audio"] })).toBe(true);
    expect(writes).toEqual([{ origin: ORIGIN, permission: "media", state: "allow" }]);
    expect(site.get(`${ORIGIN}|media`)).toBe("allow");
    expect(await session.request("media", { requestingUrl: PAGE })).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  test("始终阻止写入 deny；dismiss 只拒绝本次", async () => {
    const blocked = setup({ prompt: async () => "block-always" });
    expect(await blocked.session.request("clipboard-read", { requestingUrl: PAGE })).toBe(false);
    expect(blocked.site.get(`${ORIGIN}|clipboard-read`)).toBe("deny");
    expect(await blocked.session.request("clipboard-read", { requestingUrl: PAGE })).toBe(false);
    expect(blocked.prompts).toHaveLength(1);

    const dismissed = setup({ prompt: async () => "dismiss" });
    expect(await dismissed.session.request("clipboard-read", { requestingUrl: PAGE })).toBe(false);
    expect(dismissed.writes).toHaveLength(0);
    expect(await dismissed.session.request("clipboard-read", { requestingUrl: PAGE })).toBe(false);
    expect(dismissed.prompts).toHaveLength(2);
  });

  test("已有站点 allow 直接放行，不弹窗", async () => {
    const site = new Map<string, "allow" | "deny">([[`${ORIGIN}|geolocation`, "allow"]]);
    const { session, prompts } = setup({ site });
    expect(await session.request("geolocation", { requestingUrl: PAGE })).toBe(true);
    expect(prompts).toHaveLength(0);
  });

  test("自动化期间直接拒绝，不弹窗", async () => {
    const { session, prompts } = setup({ prompt: async () => "allow-session", automation: true });
    expect(await session.request("media", { requestingUrl: PAGE })).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  test("没有弹窗层时敏感权限默认拒绝", async () => {
    const { session } = setup();
    expect(await session.request("geolocation", { requestingUrl: PAGE })).toBe(false);
    expect(session.check("geolocation", ORIGIN)).toBe(false);
  });

  test("未识别权限 fail-closed", async () => {
    const { session } = setup({ prompt: async () => "allow-session" });
    expect(await session.request("some-future-permission", { requestingUrl: PAGE })).toBe(false);
    expect(session.check("some-future-permission", ORIGIN)).toBe(false);
  });

  test("并发同 origin+permission 只弹一次", async () => {
    let release!: (action: BrowserPermissionAction) => void;
    const pending = new Promise<BrowserPermissionAction>((resolve) => {
      release = resolve;
    });
    const { session, prompts } = setup({ prompt: () => pending });
    const first = session.request("media", { requestingUrl: PAGE });
    const second = session.request("media", { requestingUrl: PAGE });
    expect(prompts).toHaveLength(1);
    release("allow-session");
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  test("设备 check 放行到 chooser，但 select-* 未接入时显式取消", () => {
    const { session } = setup();
    expect(session.check("usb", ORIGIN)).toBe(true);
    expect(session.check("hid", ORIGIN)).toBe(true);
    expect(session.check("serial", ORIGIN)).toBe(true);

    const hid = session.listeners.get("select-hid-device")!;
    let prevented = 0;
    let hidArg: string | undefined = "sentinel";
    hid(
      { preventDefault: () => (prevented += 1) },
      { deviceList: [] },
      (value?: string) => (hidArg = value),
    );
    expect(prevented).toBe(1);
    expect(hidArg).toBeUndefined();

    const serial = session.listeners.get("select-serial-port")!;
    let serialArg: string | undefined = "sentinel";
    serial({ preventDefault: () => {} }, [], {}, (value?: string) => (serialArg = value));
    expect(serialArg).toBe("");
  });

  test("屏幕共享默认拒绝", () => {
    const { session } = setup();
    let streams: unknown = "sentinel";
    session.displayHandler!({}, (value) => (streams = value));
    expect(streams).toEqual({});
  });

  test("originFromUrl 对非法 URL 返回 unknown", () => {
    expect(originFromUrl(PAGE)).toBe(ORIGIN);
    expect(originFromUrl("not a url")).toBe("unknown");
    expect(originFromUrl(undefined)).toBe("unknown");
  });
});
