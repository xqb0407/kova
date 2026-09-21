import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cachePath,
  computeConfigHash,
  dropServer,
  getValidTools,
  resetMcpCacheForTest,
  updateTools,
  type McpToolMeta,
} from "../../src/mcp/mcp-cache";
import type { McpServerDef } from "../../src/mcp/mcp-config";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-cache-"));
const cacheFile = path.join(tmp, "cache.json");
const prevPath = process.env.PI_MCP_CACHE_PATH;

const def = (overrides: Partial<McpServerDef> = {}): McpServerDef => ({
  name: "files",
  transport: "stdio",
  command: "npx",
  args: ["-y", "files"],
  layer: "system",
  source: "",
  ...overrides,
});

const tools: McpToolMeta[] = [
  { name: "read", description: "read a file", inputSchema: { type: "object" } },
  { name: "list", description: "list files" },
];

beforeEach(() => {
  process.env.PI_MCP_CACHE_PATH = cacheFile;
  if (existsSync(cacheFile)) writeFileSync(cacheFile, "{}", "utf8");
  resetMcpCacheForTest();
});

// afterAll 恢复环境变量
import { afterAll } from "bun:test";
afterAll(() => {
  if (prevPath === undefined) delete process.env.PI_MCP_CACHE_PATH;
  else process.env.PI_MCP_CACHE_PATH = prevPath;
});

describe("computeConfigHash", () => {
  test("影响工具面的字段参与哈希，连接策略不参与", () => {
    const base = computeConfigHash(def());
    expect(computeConfigHash(def({ args: ["-y", "other"] }))).not.toBe(base);
    expect(computeConfigHash(def({ env: { K: "v" } }))).not.toBe(base);
    expect(computeConfigHash(def({ url: "http://x/mcp" }))).not.toBe(base);
    // lifecycle/idleTimeout/description 不影响工具面
    expect(computeConfigHash(def({ lifecycle: "keep-alive", idleTimeout: 60_000 }))).toBe(base);
    expect(computeConfigHash(def({ description: "x" }))).toBe(base);
  });
});

describe("getValidTools / updateTools", () => {
  test("未缓存返回 null；更新后命中且含 schema", () => {
    expect(getValidTools(def())).toBeNull();
    updateTools(def(), tools);
    const got = getValidTools(def());
    expect(got).not.toBeNull();
    expect(got).toHaveLength(2);
    expect(got?.[0].inputSchema).toEqual({ type: "object" });
    // 返回的是副本，改写不影响缓存
    if (got) got[0].name = "mutated";
    expect(getValidTools(def())?.[0].name).toBe("read");
  });

  test("配置变更后失效", () => {
    updateTools(def(), tools);
    expect(getValidTools(def({ args: ["changed"] }))).toBeNull();
  });

  test("跨进程：落盘后用新实例（重置内存）可读回", () => {
    updateTools(def(), tools);
    resetMcpCacheForTest();
    const got = getValidTools(def());
    expect(got).not.toBeNull();
    expect(got?.[1].name).toBe("list");
    const doc = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(doc.version).toBe(1);
    expect(doc.servers.files.configHash).toBe(computeConfigHash(def()));
  });

  test("dropServer 清残留", () => {
    updateTools(def(), tools);
    dropServer("files");
    expect(getValidTools(def())).toBeNull();
    dropServer("not-exists"); // 幂等
  });

  test("坏缓存文件降级为空", () => {
    writeFileSync(cacheFile, "{broken", "utf8");
    resetMcpCacheForTest();
    expect(getValidTools(def())).toBeNull();
  });
});

describe("路径解析", () => {
  test("PI_MCP_CACHE_PATH 优先", () => {
    expect(cachePath()).toBe(cacheFile);
  });
});
