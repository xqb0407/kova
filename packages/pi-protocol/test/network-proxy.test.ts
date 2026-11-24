import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  normalizeNetworkProxyUrl,
  parseNetworkProxyConfig,
  serializeNetworkProxyConfig,
} from "../src/network-proxy";

describe("normalizeNetworkProxyUrl", () => {
  test("接受 http(s)，host:port 自动补 http://，去掉末尾斜杠", () => {
    expect(normalizeNetworkProxyUrl("http://127.0.0.1:7897/")).toBe(
      "http://127.0.0.1:7897",
    );
    expect(normalizeNetworkProxyUrl("127.0.0.1:7897")).toBe(
      "http://127.0.0.1:7897",
    );
    expect(normalizeNetworkProxyUrl("HTTPS://proxy.local:8443")).toBe(
      "https://proxy.local:8443",
    );
  });

  test("拒绝 SOCKS、空值、非法值与默认拒绝凭据", () => {
    expect(normalizeNetworkProxyUrl("socks5://127.0.0.1:7897")).toBeNull();
    expect(normalizeNetworkProxyUrl("")).toBeNull();
    expect(normalizeNetworkProxyUrl("http://")).toBeNull();
    expect(normalizeNetworkProxyUrl(undefined)).toBeNull();
    expect(normalizeNetworkProxyUrl("http://user:pass@127.0.0.1:7897")).toBeNull();
    expect(
      normalizeNetworkProxyUrl("http://user:pass@127.0.0.1:7897", {
        allowCredentials: true,
      }),
    ).toBe("http://user:pass@127.0.0.1:7897");
  });
});

describe("parseNetworkProxyConfig", () => {
  test("默认 system；坏 JSON 回落 system", () => {
    expect(parseNetworkProxyConfig(null)).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
    expect(parseNetworkProxyConfig("{")).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
  });

  test("保留 direct/custom；非法 custom 回落 system", () => {
    expect(
      parseNetworkProxyConfig(JSON.stringify({ mode: "direct", url: "" })),
    ).toEqual({ mode: "direct", url: "" });
    expect(
      parseNetworkProxyConfig(
        JSON.stringify({ mode: "custom", url: "127.0.0.1:7897" }),
      ),
    ).toEqual({ mode: "custom", url: "127.0.0.1:7897" });
    expect(
      parseNetworkProxyConfig(
        JSON.stringify({ mode: "custom", url: "socks5://127.0.0.1:7897" }),
      ),
    ).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
  });
});

describe("serializeNetworkProxyConfig", () => {
  test("roundtrip", () => {
    const config = { mode: "custom" as const, url: "http://127.0.0.1:7897" };
    expect(parseNetworkProxyConfig(serializeNetworkProxyConfig(config))).toEqual(
      config,
    );
  });
});
