/**
 * 请求对外身份。pi-agent-core 的 DEFAULT_AGENT_IDENTITY 带的是 pi 自己的身份：
 * User-Agent 默认拼成 `pi/<pi-ai 版本> (…)`，attribution 指向 pi.dev。本 app 跑在
 * 这套库上会原样继承，网关那边按 UA 前缀归类时就把请求记到 pi 名下（magpie 的
 * usage.AgentOf 即如此）。这里换成本 app 自己的 UA 并显式关掉归因，避免流量与
 * OpenRouter / NVIDIA / OpenCode 归因都算到 pi 头上。
 *
 * KOVA_VERSION 由桌面壳拉起 sidecar 时传入；其他宿主（远程 worker、bun test）
 * 没有这个变量时只发产品名。
 */
import type { ClientIdentity } from "@earendil-works/pi-ai";

const APP_NAME = "kova";

function runtimeDescription(): string | undefined {
  const versions = process.versions;
  if (versions?.bun) return `bun/${versions.bun}`;
  if (versions?.node) return `node/${process.version}`;
  return undefined;
}

function userAgent(): string {
  const version = process.env.KOVA_VERSION?.trim();
  const product = version ? `${APP_NAME}/${version}` : APP_NAME;
  const runtime = runtimeDescription();
  return runtime
    ? `${product} (${process.platform}; ${runtime}; ${process.arch})`
    : product;
}

export const KOVA_CLIENT_IDENTITY: ClientIdentity = {
  userAgent: { custom: userAgent() },
  attribution: null,
};
