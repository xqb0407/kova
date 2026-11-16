import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cachePath,
  computeConfigHash,
  dropServer,
  getValidPrompts,
  getValidResources,
  getValidServerMeta,
  getValidTools,
  resetMcpCacheForTest,
  updateServerMeta,
  updateTools,
  type McpServerMeta,
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

const meta: McpServerMeta = {
  tools,
  resources: [
    {
      uri: "file:///readme.md",
      name: "readme",
      title: "README",
      description: "project readme",
      mimeType: "text/markdown",
    },
  ],
  resourceTemplates: [
    {
      uriTemplate: "file:///{path}",
      name: "project-file",
      mimeType: "text/plain",
    },
  ],
  prompts: [
    {
      name: "summarize",
      description: "summarize a topic",
      arguments: [{ name: "topic", required: true }],
    },
  ],
  capabilities: { resources: true, prompts: true, tasks: false },
};

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
    expect(doc.version).toBe(2);
    expect(doc.servers.files.configHash).toBe(computeConfigHash(def()));
  });

  test("updateTools 只换工具面，已有 resources/prompts 保留", () => {
    updateServerMeta(def(), meta);
    updateTools(def(), [{ name: "new-tool" }]);
    expect(getValidTools(def())?.map((t) => t.name)).toEqual(["new-tool"]);
    expect(getValidResources(def())?.resources[0]?.name).toBe("readme");
    expect(getValidPrompts(def())?.[0]?.name).toBe("summarize");
  });

  test("v1 缓存迁移：工具保留，新能力为空，文件升级为 v2", () => {
    const cachedAt = Date.now();
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        servers: {
          files: {
            configHash: computeConfigHash(def()),
            tools,
            cachedAt,
          },
        },
      }),
      "utf8",
    );
    resetMcpCacheForTest();
    expect(getValidTools(def())?.map((t) => t.name)).toEqual(["read", "list"]);
    expect(getValidResources(def())).toEqual({ resources: [], resourceTemplates: [] });
    expect(getValidPrompts(def())).toEqual([]);
    expect(getValidServerMeta(def())?.capabilities).toEqual({
      resources: false,
      prompts: false,
      tasks: false,
    });
    // loadOnce 迁移后立刻落盘为 v2
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).version).toBe(2);
  });

  test("损坏的 v2 条目被丢弃，不拖垮其他服务器", () => {
    updateServerMeta(def(), meta);
    updateServerMeta(def({ name: "other" }), { ...meta, prompts: [] });
    const doc = JSON.parse(readFileSync(cacheFile, "utf8"));
    doc.servers.files.resources = "not-an-array";
    doc.servers.files.prompts = [{ missing: "name" }];
    doc.servers.other = { ...doc.servers.other, cachedAt: "bad" };
    writeFileSync(cacheFile, JSON.stringify(doc), "utf8");
    resetMcpCacheForTest();
    const files = getValidServerMeta(def());
    expect(files?.tools.map((t) => t.name)).toEqual(["read", "list"]);
    expect(files?.resources).toEqual([]);
    expect(files?.prompts).toEqual([]);
    expect(getValidTools(def({ name: "other" }))).toBeNull();
  });

  test("dropServer 清残留", () => {
    updateServerMeta(def(), meta);
    dropServer("files");
    expect(getValidTools(def())).toBeNull();
    expect(getValidResources(def())).toBeNull();
    expect(getValidPrompts(def())).toBeNull();
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
