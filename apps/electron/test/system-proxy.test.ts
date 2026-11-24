import { describe, expect, test } from "bun:test";
import {
  buildSidecarProxyEnv,
  mergeNoProxy,
  proxyUrlFromResolution,
  redactProxyUrl,
} from "../main/system-proxy";

describe("proxyUrlFromResolution", () => {
  test("PROXY / HTTPS 解析为 http 代理；IPv6 主机保留方括号", () => {
    expect(proxyUrlFromResolution("PROXY 127.0.0.1:7897")).toBe(
      "http://127.0.0.1:7897",
    );
    expect(proxyUrlFromResolution("HTTPS proxy.local:8443")).toBe(
      "http://proxy.local:8443",
    );
    expect(proxyUrlFromResolution("PROXY [::1]:7897")).toBe("http://[::1]:7897");
  });

  test("多候选取第一个 HTTP 代理；DIRECT / SOCKS 不当作可用代理", () => {
    expect(
      proxyUrlFromResolution("SOCKS5 127.0.0.1:7897; PROXY 127.0.0.1:7898"),
    ).toBe("http://127.0.0.1:7898");
    expect(proxyUrlFromResolution("SOCKS5 127.0.0.1:7897")).toBeUndefined();
    expect(proxyUrlFromResolution("DIRECT")).toBeUndefined();
    expect(proxyUrlFromResolution(undefined)).toBeUndefined();
  });
});

describe("redactProxyUrl", () => {
  test("去掉代理 URL 里的用户名/密码", () => {
    expect(redactProxyUrl("http://user:pass@127.0.0.1:7897")).toBe(
      "http://***:***@127.0.0.1:7897",
    );
    expect(redactProxyUrl("http://127.0.0.1:7897")).toBe(
      "http://127.0.0.1:7897",
    );
  });
});

describe("mergeNoProxy", () => {
  test("保留已有条目，追加回环地址并去重", () => {
    expect(mergeNoProxy("127.0.0.1, .local")).toBe(
      "127.0.0.1,.local,localhost,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    );
    expect(mergeNoProxy("localhost,10.0.0.0/8")).toBe(
      "localhost,10.0.0.0/8,127.0.0.1,::1,172.16.0.0/12,192.168.0.0/16",
    );
  });
});

describe("buildSidecarProxyEnv", () => {
  test("系统代理注入 HTTP/HTTPS + NO_PROXY", () => {
    const env = buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {});
    expect(env).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY:
        "127.0.0.1,localhost,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
      no_proxy:
        "127.0.0.1,localhost,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    });
  });

  test("用户已显式设置 HTTP(S) 代理时不覆盖", () => {
    expect(
      buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
        HTTPS_PROXY: "http://user-proxy:9000",
      }),
    ).toEqual({});
    expect(
      buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
        https_proxy: "http://user-proxy:9000",
      }),
    ).toEqual({});
    expect(
      buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
        ALL_PROXY: "http://user-proxy:9000",
      }),
    ).toEqual({});
  });

  test("ALL_PROXY / HTTP(S)_PROXY 为 socks5 时不阻止注入（Bun 会忽略 SOCKS）", () => {
    expect(
      buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
        ALL_PROXY: "socks5://127.0.0.1:7897",
      }).HTTPS_PROXY,
    ).toBe("http://127.0.0.1:7897");
    expect(
      buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
        HTTPS_PROXY: "socks5://127.0.0.1:7897",
      }).HTTPS_PROXY,
    ).toBe("http://127.0.0.1:7897");
  });

  test("KOVA_SIDECAR_PROXY=off 关闭；URL/host:port 强制使用；SOCKS 回落系统代理", () => {
    expect(
      buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
        KOVA_SIDECAR_PROXY: "off",
      }),
    ).toEqual({});
    const forced = buildSidecarProxyEnv("DIRECT", {
      KOVA_SIDECAR_PROXY: "http://forced:8000",
    });
    expect(forced.HTTPS_PROXY).toBe("http://forced:8000");
    expect(forced.HTTP_PROXY).toBe("http://forced:8000");
    const bare = buildSidecarProxyEnv("DIRECT", {
      KOVA_SIDECAR_PROXY: "forced:8000",
    });
    expect(bare.HTTPS_PROXY).toBe("http://forced:8000");
    const socks = buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
      KOVA_SIDECAR_PROXY: "socks5://forced:8000",
    });
    expect(socks.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    const invalid = buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
      KOVA_SIDECAR_PROXY: "http://",
    });
    expect(invalid.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
  });

  test("大小写两套 NO_PROXY 都合并", () => {
    const env = buildSidecarProxyEnv("PROXY 127.0.0.1:7897", {
      NO_PROXY: "a.example",
      no_proxy: "b.example",
    });
    expect(env.NO_PROXY).toContain("a.example");
    expect(env.NO_PROXY).toContain("b.example");
  });

  test("DIRECT / 无解析结果不注入", () => {
    expect(buildSidecarProxyEnv("DIRECT", {})).toEqual({});
    expect(buildSidecarProxyEnv(undefined, {})).toEqual({});
  });
});
