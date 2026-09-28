import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deleteMcpServer,
  expandPluginValue,
  loadMcpServers,
  mcpStateKey,
  resetMcpConfigForTest,
  saveMcpServer,
  setMcpServerEnabled,
  systemMcpConfigPath,
  validateMcpDraft,
  workspaceOverrideMcpPath,
  workspaceStandardMcpPath,
  type McpDraft,
} from "../../src/mcp/mcp-config";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-config-"));
const systemPath = path.join(tmp, "system-mcp.json");
const prevConfig = process.env.PI_MCP_CONFIG;
const cwd = path.join(tmp, "repo");

const stdioDraft = (name: string, overrides: Partial<McpDraft> = {}): McpDraft => ({
  name,
  transport: "stdio",
  command: "npx",
  args: ["-y", "server"],
  ...overrides,
});

beforeAll(() => {
  process.env.PI_MCP_CONFIG = systemPath;
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => {
  if (prevConfig === undefined) delete process.env.PI_MCP_CONFIG;
  else process.env.PI_MCP_CONFIG = prevConfig;
});

beforeEach(() => {
  resetMcpConfigForTest();
  for (const p of [
    systemPath,
    workspaceStandardMcpPath(cwd),
    workspaceOverrideMcpPath(cwd),
  ]) {
    if (existsSync(p)) unlinkSync(p);
  }
});

const writeJson = (p: string, doc: unknown) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(doc, null, 2));
};

describe("插件层占位符展开", () => {
  test("三个占位符替换；缺 root/workspace 时保留原文并报告", () => {
    const full = expandPluginValue("${BUN} run ${PLUGIN_ROOT}/s.ts ${WORKSPACE}", {
      root: "/p/root",
      workspace: "/ws",
    });
    expect(full.value).toBe(`${process.execPath} run /p/root/s.ts /ws`);
    expect(full.usedBun).toBe(true);
    expect(full.missing).toEqual([]);

    const missing = expandPluginValue("${PLUGIN_ROOT}/x ${WORKSPACE}", {});
    expect(missing.value).toBe("${PLUGIN_ROOT}/x ${WORKSPACE}");
    expect(missing.usedBun).toBe(false);
    expect(missing.missing).toEqual(["${PLUGIN_ROOT}", "${WORKSPACE}"]);

    const plain = expandPluginValue("echo hi", {});
    expect(plain.value).toBe("echo hi");
    expect(plain.missing).toEqual([]);
  });
});

describe("三层加载与合并", () => {
  test("系统层独立加载", async () => {
    writeJson(systemPath, {
      mcpServers: {
        files: { type: "stdio", command: "npx", args: ["-y", "files"], description: "Files" },
      },
    });
    const r = await loadMcpServers();
    expect(r.defs).toHaveLength(1);
    expect(r.defs[0].layer).toBe("system");
    expect(r.defs[0].transport).toBe("stdio");
    expect(r.defs[0].description).toBe("Files");
    expect(r.enabledBy.get("files")).toBe(true);
  });

  test("工作区覆盖层字段级覆盖系统层同名条目", async () => {
    writeJson(systemPath, {
      mcpServers: {
        files: { type: "stdio", command: "npx", args: ["-y", "files"], description: "global" },
      },
    });
    writeJson(workspaceOverrideMcpPath(cwd), {
      mcpServers: {
        files: { type: "stdio", command: "bun", description: "override" },
      },
    });
    const r = await loadMcpServers(cwd);
    expect(r.defs).toHaveLength(1);
    expect(r.defs[0].command).toBe("bun");
    // 未提供的字段从低层继承
    expect(r.defs[0].args).toEqual(["-y", "files"]);
    expect(r.defs[0].description).toBe("override");
    expect(r.defs[0].layer).toBe("workspace");
  });

  test("工作区覆盖层可接管标准层条目", async () => {
    writeJson(workspaceStandardMcpPath(cwd), {
      mcpServers: { shared: { command: "npx", args: ["-y", "shared"] } },
    });
    let r = await loadMcpServers(cwd);
    expect(r.defs[0].fromStandard).toBe(true);
    writeJson(workspaceOverrideMcpPath(cwd), {
      mcpServers: { shared: { type: "stdio", command: "npx", args: ["-y", "shared"], approveTools: ["read_*"] } },
    });
    r = await loadMcpServers(cwd);
    expect(r.defs[0].fromStandard).toBeUndefined();
    expect(r.defs[0].approveTools).toEqual(["read_*"]);
  });

  test("URL 变更丢弃低层 headers（URL 绑定认证防护）", async () => {
    writeJson(systemPath, {
      mcpServers: {
        api: { type: "http", url: "http://10.0.0.1/mcp", headers: { Authorization: "Bearer old" } },
      },
    });
    // 同 URL：headers 继承
    writeJson(workspaceOverrideMcpPath(cwd), {
      mcpServers: { api: { type: "http", url: "http://10.0.0.1/mcp", description: "same" } },
    });
    let r = await loadMcpServers(cwd);
    expect(r.defs[0].headers?.Authorization).toBe("Bearer old");
    // URL 变更：不继承
    writeJson(workspaceOverrideMcpPath(cwd), {
      mcpServers: { api: { type: "http", url: "http://10.0.0.2/mcp" } },
    });
    r = await loadMcpServers(cwd);
    expect(r.defs[0].url).toBe("http://10.0.0.2/mcp");
    expect(r.defs[0].headers).toBeUndefined();
  });

  test("transport 换型不继承对方字段", async () => {
    writeJson(systemPath, {
      mcpServers: {
        thing: { type: "http", url: "http://10.0.0.1/mcp", headers: { "X-A": "1" } },
      },
    });
    writeJson(workspaceOverrideMcpPath(cwd), {
      mcpServers: { thing: { type: "stdio", command: "npx" } },
    });
    const r = await loadMcpServers(cwd);
    expect(r.defs[0].transport).toBe("stdio");
    expect(r.defs[0].command).toBe("npx");
    expect(r.defs[0].url).toBeUndefined();
    expect(r.defs[0].headers).toBeUndefined();
  });

  test("标准层 .mcp.json 无 type 时按字段推断 transport", async () => {
    writeJson(workspaceStandardMcpPath(cwd), {
      mcpServers: {
        inferred: { command: "npx", args: ["-y", "x"], env: { A: "1" } },
      },
    });
    const r = await loadMcpServers(cwd);
    expect(r.defs[0].transport).toBe("stdio");
    expect(r.defs[0].env?.A).toBe("1");
  });

  test("坏文件与坏条目降级为诊断，不赔上其它条目", async () => {
    writeJson(systemPath, {
      mcpServers: {
        good: { type: "stdio", command: "npx" },
        bad: { type: "stdio", url: "http://x/mcp" },
        "bad name": { type: "stdio", command: "npx" },
      },
    });
    writeFileSync(path.join(tmp, "broken.json"), "{not json");
    const r = await loadMcpServers(cwd);
    expect(r.defs.map((d) => d.name)).toEqual(["good"]);
    expect(r.diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(r.diagnostics.some((d) => d.includes("stdio 服务器不能设置 url/headers"))).toBe(true);
    expect(r.diagnostics.some((d) => d.includes("名称需匹配"))).toBe(true);
  });

  test("标准层忽略 kova 专属字段并记诊断", async () => {
    writeJson(workspaceStandardMcpPath(cwd), {
      mcpServers: { s: { command: "npx", approveTools: ["*"] } },
    });
    const r = await loadMcpServers(cwd);
    expect(r.defs[0].approveTools).toBeUndefined();
    expect(r.diagnostics.some((d) => d.includes("标准层忽略"))).toBe(true);
  });
});

describe("启用开关（kv，键规则同 subagents）", () => {
  test("禁用系统层不影响工作区同名条目", async () => {
    writeJson(systemPath, { mcpServers: { a: { type: "stdio", command: "npx" } } });
    writeJson(workspaceOverrideMcpPath(cwd), { mcpServers: { a: { type: "stdio", command: "bun" } } });
    await setMcpServerEnabled("system", "a", false);
    let r = await loadMcpServers(cwd);
    // 合并后层语义跟最终提供者走（workspace），system:<name> 键不再命中
    expect(r.enabledBy.get("a")).toBe(true);
    await setMcpServerEnabled("workspace", "a", false, cwd);
    r = await loadMcpServers(cwd);
    expect(r.enabledBy.get("a")).toBe(false);
  });

  test("stateKey 工作区按 cwd 隔离", () => {
    expect(mcpStateKey("workspace", "a", "/r1")).toBe("workspace:/r1::a");
    expect(mcpStateKey("workspace", "a", "/r2")).not.toBe(mcpStateKey("workspace", "a", "/r1"));
    expect(mcpStateKey("system", "a")).toBe("system:a");
  });
});

describe("校验规则", () => {
  test("合法草稿通过", () => {
    expect(validateMcpDraft(stdioDraft("ok"))).toEqual([]);
    expect(
      validateMcpDraft({ name: "api", transport: "http", url: "https://example.com/mcp" }),
    ).toEqual([]);
    // 非 loopback 明文 HTTP 允许（保存即同意）
    expect(
      validateMcpDraft({ name: "lan", transport: "http", url: "http://192.168.1.20:8080/mcp" }),
    ).toEqual([]);
  });

  /** 数组里存在包含 substr 的诊断行 */
  const hasDiag = (errors: string[], substr: string) =>
    errors.some((e) => e.includes(substr));

  test("名称 / 互斥字段 / scheme", () => {
    expect(hasDiag(validateMcpDraft(stdioDraft("bad.name")), "名称需匹配")).toBe(true);
    expect(hasDiag(validateMcpDraft(stdioDraft("x", { command: "a..b" })), '不能包含 ".."')).toBe(true);
    expect(
      hasDiag(
        validateMcpDraft(stdioDraft("x", { url: "http://a/mcp" } as Partial<McpDraft>)),
        "只能二选一",
      ),
    ).toBe(true);
    expect(
      hasDiag(validateMcpDraft({ name: "x", transport: "http", url: "ftp://a/mcp" }), "仅支持 http/https"),
    ).toBe(true);
    expect(
      hasDiag(validateMcpDraft({ name: "x", transport: "http", url: "not a url" }), "url 不是合法绝对地址"),
    ).toBe(true);
  });

  test("env/headers 键名与上限", () => {
    expect(
      hasDiag(
        validateMcpDraft(stdioDraft("x", { env: { "BAD-KEY": "v" } })),
        '键 "BAD-KEY" 不符合命名规则',
      ),
    ).toBe(true);
    const bigEnv: Record<string, string> = {};
    for (let i = 0; i < 65; i++) bigEnv[`K${i}`] = "v";
    expect(hasDiag(validateMcpDraft(stdioDraft("x", { env: bigEnv })), "条目超过上限 64")).toBe(true);
  });
});

describe("写路径", () => {
  test("save → load 回读一致；JSON 无 enabled 等激活字段", async () => {
    await saveMcpServer("system", stdioDraft("files", { description: "Files" }), { systemPath });
    const raw = readFileSync(systemPath, "utf8");
    expect(raw).not.toContain("enabled");
    const r = await loadMcpServers();
    expect(r.defs[0].name).toBe("files");
    expect(r.defs[0].command).toBe("npx");
  });

  test("保存到工作区只写覆盖层，从不改写 .mcp.json", async () => {
    writeJson(workspaceStandardMcpPath(cwd), { mcpServers: {} });
    await saveMcpServer("workspace", stdioDraft("w1"), { cwd });
    const std = JSON.parse(readFileSync(workspaceStandardMcpPath(cwd), "utf8"));
    expect(Object.keys(std.mcpServers)).toHaveLength(0);
    const ovr = JSON.parse(readFileSync(workspaceOverrideMcpPath(cwd), "utf8"));
    expect(ovr.mcpServers.w1.command).toBe("npx");
  });

  test("delete 只动本层文件；标准层条目删除报错并解释", async () => {
    await saveMcpServer("system", stdioDraft("a"), { systemPath });
    writeJson(workspaceStandardMcpPath(cwd), {
      mcpServers: { b: { command: "npx" } },
    });
    await saveMcpServer("workspace", stdioDraft("c"), { cwd });

    await deleteMcpServer("system", "a", { systemPath });
    expect((await loadMcpServers()).defs.map((d) => d.name)).toEqual([]);

    const r = await loadMcpServers(cwd);
    expect(r.defs.map((d) => d.name).sort()).toEqual(["b", "c"]);
    await deleteMcpServer("workspace", "c", { cwd });
    expect((await loadMcpServers(cwd)).defs.map((d) => d.name)).toEqual(["b"]);
    expect(existsSync(workspaceStandardMcpPath(cwd))).toBe(true);

    expect(deleteMcpServer("workspace", "b", { cwd })).rejects.toThrow("不直接改写");
  });
});
