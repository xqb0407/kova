import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_IDENTITY } from "@earendil-works/pi-agent-core";
import {
  formatUserAgent,
  getAttributionHeaders,
  getIdentityHeaders,
  mergeClientIdentity,
} from "@earendil-works/pi-ai";
import { KOVA_CLIENT_IDENTITY } from "../../src/model/client-identity";

describe("client identity", () => {
  test("names kova, not pi", () => {
    const ua = formatUserAgent(KOVA_CLIENT_IDENTITY);
    expect(ua).toMatch(/^kova(\/| \(|$)/);
    expect(ua).not.toContain("pi/");
  });

  test("overrides pi's default agent identity field by field", () => {
    // Agent 层收到的就是这份合并结果：pi 的 attribution 必须被 null 盖掉
    const merged = mergeClientIdentity(DEFAULT_AGENT_IDENTITY, KOVA_CLIENT_IDENTITY);
    expect(merged?.attribution).toBeNull();
    expect(formatUserAgent(merged)).toBe(formatUserAgent(KOVA_CLIENT_IDENTITY));
  });

  test("sends no pi attribution", () => {
    const target = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
    expect(getAttributionHeaders(target, KOVA_CLIENT_IDENTITY)).toEqual({});
    expect(getIdentityHeaders(target, KOVA_CLIENT_IDENTITY)["HTTP-Referer"]).toBeUndefined();
  });
});
