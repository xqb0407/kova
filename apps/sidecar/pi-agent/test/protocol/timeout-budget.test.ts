import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANNEL_FLOOR_MS,
  PAIR_SLACK_MS,
  SIDECAR_BUDGET_MS,
  channelTimeoutMs,
  pairWaitMs,
  sidecarBudgetMs,
} from "pi-protocol";
import { MCP_AUTH_URL_TIMEOUT_MS, MCP_CONNECT_TIMEOUT_MS } from "../../src/mcp/mcp-manager";

/**
 * 超时预算阶梯的守门测试（规则固化，不是文档）。
 *
 * 2026-10 的"全应用假死"是三层预算倒挂造成的：侧车等 180s、主进程 30s 就判死、
 * 渲染层 15s 先行超时——用户拿到含糊的本地超时，侧车还在跑并占着 mgmt 队列。
 * 单源在 pi-protocol/timeouts，这里钉住三件事：
 *   1) 表内每条命令的阶梯严格递增（侧车上限 ≤ 渲染层预算 < 主进程配对）；
 *   2) 表与侧车实现常量不漂移（握手/授权受理的真实上限）；
 *   3) 两个通道与主进程兜底不再出现写死的超时数字。
 * 新增慢命令只改那张表；哪条断言红了，就是哪层又开始各写各的。
 */

/** apps/sidecar/pi-agent/test/protocol → 仓库根 */
const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
const toNumber = (literal: string) => Number(literal.replace(/_/g, ""));

describe("超时预算阶梯（外层必须比内层多等）", () => {
  test("表内每条命令：侧车上限 ≤ 渲染层预算 < 主进程配对", () => {
    expect(Object.keys(SIDECAR_BUDGET_MS).length).toBeGreaterThan(0);
    for (const [type, budget] of Object.entries(SIDECAR_BUDGET_MS)) {
      const channel = channelTimeoutMs(type);
      const pair = pairWaitMs(type);
      expect(budget, `${type}: 侧车上限不得超过渲染层预算`).toBeLessThanOrEqual(channel);
      expect(channel, `${type}: 渲染层预算不得低于地板`).toBeGreaterThanOrEqual(CHANNEL_FLOOR_MS);
      expect(pair, `${type}: 主进程配对必须严格大于渲染层预算`).toBeGreaterThan(channel);
      expect(pair - channel, `${type}: 两层余量`).toBe(PAIR_SLACK_MS);
    }
  });

  test("未登记命令走地板：既有 15s 行为不变", () => {
    expect(sidecarBudgetMs("list_sessions")).toBeLessThanOrEqual(CHANNEL_FLOOR_MS);
    expect(channelTimeoutMs("list_sessions")).toBe(CHANNEL_FLOOR_MS);
    expect(channelTimeoutMs("")).toBe(CHANNEL_FLOOR_MS);
  });

  test("表与侧车内部常量不漂移：握手类 ≥ 连接超时 ×2、授权受理 ≥ 授权链接上限", () => {
    for (const type of ["test_mcp_server", "get_mcp_server_tools"]) {
      expect(sidecarBudgetMs(type), type).toBeGreaterThan(MCP_CONNECT_TIMEOUT_MS * 2);
    }
    expect(sidecarBudgetMs("authorize_mcp_server")).toBeGreaterThan(MCP_AUTH_URL_TIMEOUT_MS);
  });

  test("渲染层通道取表：两个通道都不得再写死默认超时", () => {
    for (const rel of [
      "apps/desktop/lib/pi/pi-channel.ts",
      "apps/desktop/lib/pi/pi-ws-channel.ts",
    ]) {
      const src = read(rel);
      expect(src, `${rel} 应引用协议表`).toContain("channelTimeoutMs");
      expect(src, `${rel} 不应再写死 timeoutMs = <数字>`).not.toMatch(/timeoutMs\s*=\s*\d/);
    }
  });

  test("主进程配对兜底 = 未登记命令的通道预算 + PAIR_SLACK（源码钉住）", () => {
    const src = read("apps/electron/main/pi-agent.ts");
    const match = src.match(/const DEFAULT_PAIR_TIMEOUT_MS = ([\d_]+)/);
    expect(match, "常量改名/删除时同步本测试（预算只该从 pi-protocol/timeouts 调）").not.toBeNull();
    expect(toNumber(match![1])).toBe(channelTimeoutMs("") + PAIR_SLACK_MS);
  });
});