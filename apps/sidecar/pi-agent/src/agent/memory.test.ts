import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMemoryConfig,
  buildMemoryTools,
  DEFAULT_MEMORY_CONFIG,
  getMemoryConfig,
  initMemory,
  listRootMemoryFiles,
  memoryPromptBlock,
  memoryScopesPayload,
  normalizeMemoryConfig,
  readMemoryFile,
  resetMemoryConfigForTest,
  searchMemoryText,
  writeMemoryFile,
} from "./memory";
import { composeModeSystemPrompt } from "./modes";
import { initLocalStorage, kvGet, resetStorageForTest } from "../storage/hostdb";
import { SYSTEM_PROMPT_CORE, workspacePromptLine } from "../tools/tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-memory-"));
const globalDir = path.join(tmp, "global-memory");
const ws = path.join(tmp, "ws");
const wsMemoryDir = path.join(ws, ".xulux", "memory");
const prevMemoryDir = process.env.PI_MEMORY_DIR;
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(async () => {
  initLocalStorage(path.join(tmp, "state.db"));
  process.env.PI_MEMORY_DIR = globalDir;
  // 个性化身份文件实时读盘：钉到空目录，保证默认提示词基线不受真实 ~/.xulux/ 影响
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(wsMemoryDir, { recursive: true });
  writeFileSync(path.join(globalDir, "MEMORY.md"), "# global long term\n\n#preference [[pm]] Always use pnpm in any repo.\n");
  writeFileSync(path.join(globalDir, "team.md"), "The user works in the platform team.\n");
  writeFileSync(path.join(wsMemoryDir, "MEMORY.md"), "# workspace facts\n\n#decision [[db]] Chose PostgreSQL for JSON support.\n");
  mkdirSync(path.join(globalDir, "daily"), { recursive: true });
  writeFileSync(path.join(globalDir, "daily", "2026-09-12.md"), "old daily note about the deploy pipeline\n");
});

afterAll(async () => {
  // bun test 单进程共享模块注册表：清内存态/env/transport，避免污染后续文件
  resetMemoryConfigForTest();
  resetStorageForTest();
  if (prevMemoryDir === undefined) delete process.env.PI_MEMORY_DIR;
  else process.env.PI_MEMORY_DIR = prevMemoryDir;
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

const enableAll = () =>
  applyMemoryConfig({ enabled: true, global: true, workspace: true, fileSearch: true });

describe("normalizeMemoryConfig", () => {
  test("非法字段回落默认，白名单过滤非法文件名并去重", () => {
    expect(normalizeMemoryConfig(null)).toEqual(DEFAULT_MEMORY_CONFIG);
    const n = normalizeMemoryConfig({
      enabled: "yes",
      global: false,
      fileSearch: 1,
      enabledFiles: {
        global: ["MEMORY.md", "MEMORY.md", "../evil.md", 42, "team.md"],
        workspace: "nope",
      },
    });
    expect(n.enabled).toBe(false); // 非布尔回落默认
    expect(n.global).toBe(false);
    expect(n.fileSearch).toBe(true); // 非布尔回落默认
    expect(n.enabledFiles.global).toEqual(["MEMORY.md", "team.md"]);
    expect(n.enabledFiles.workspace).toBeNull();
  });
});

describe("memoryPromptBlock", () => {
  test("总开关关闭时为空串，默认提示词字节级不变", async () => {
    await applyMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    expect(memoryPromptBlock(ws)).toBe("");
    const baseline = composeModeSystemPrompt("agent", ws);
    expect(baseline).toContain(SYSTEM_PROMPT_CORE);
    expect(baseline.endsWith(workspacePromptLine(ws))).toBe(true);
  });

  test("开启后注入两个作用域，工作区在前；文件内容可见", async () => {
    await enableAll();
    const block = memoryPromptBlock(ws);
    expect(block).toContain("## Memory");
    expect(block).toContain("### workspace/MEMORY.md");
    expect(block).toContain("#decision [[db]] Chose PostgreSQL");
    expect(block).toContain("### global/MEMORY.md");
    expect(block).toContain("#preference [[pm]] Always use pnpm");
    expect(block.indexOf("workspace/MEMORY.md")).toBeLessThan(block.indexOf("global/MEMORY.md"));
  });

  test("集成进 composeModeSystemPrompt：记忆段在环境段之前，cwd 行仍最尾", async () => {
    await enableAll();
    const prompt = composeModeSystemPrompt("agent", ws);
    expect(prompt).toContain("### workspace/MEMORY.md");
    expect(prompt.indexOf("### workspace/MEMORY.md")).toBeLessThan(prompt.indexOf(workspacePromptLine(ws)));
    expect(prompt.endsWith(workspacePromptLine(ws))).toBe(true);
  });

  test("指定记忆开启：白名单排除的文件不注入，全部开时回落 null", async () => {
    await enableAll();
    await applyMemoryConfig({
      ...getMemoryConfig(),
      enabledFiles: { global: ["team.md"], workspace: null },
    });
    const block = memoryPromptBlock(ws);
    expect(block).toContain("### global/team.md");
    expect(block).not.toContain("### global/MEMORY.md");
    expect(block).toContain("### workspace/MEMORY.md");
  });

  test("作用域开关独立：关掉工作区后只注入全局", async () => {
    await enableAll();
    await applyMemoryConfig({ ...getMemoryConfig(), workspace: false });
    const block = memoryPromptBlock(ws);
    expect(block).not.toContain("### workspace/MEMORY.md");
    expect(block).toContain("### global/MEMORY.md");
    await enableAll();
  });

  test("超长文件中间截断，整段预算外文件略去并留说明", async () => {
    writeFileSync(path.join(globalDir, "big.md"), `x${"x".repeat(9000)}x\n`);
    writeFileSync(path.join(globalDir, "z-big2.md"), `y${"y".repeat(12000)}y\n`);
    writeFileSync(path.join(globalDir, "z-big3.md"), `z${"z".repeat(12000)}z\n`);
    await enableAll();
    const block = memoryPromptBlock(ws);
    expect(block).toContain("[truncated]");
    expect(block).toContain("over the injection budget");
    expect(block).not.toContain("### global/z-big3.md");
    // 清掉大文件，别影响后面的检索断言
    const { rmSync } = await import("node:fs");
    rmSync(path.join(globalDir, "big.md"));
    rmSync(path.join(globalDir, "z-big2.md"));
    rmSync(path.join(globalDir, "z-big3.md"));
    await enableAll();
  });
});

describe("searchMemoryText", () => {
  test("按分数返回 path:line 命中，含 daily 日志", async () => {
    await enableAll();
    const hits = searchMemoryText(ws, "PostgreSQL pnpm deploy", 10);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const formats = hits.map((h) => `${h.scope}/${h.rel}:${h.line}: ${h.text}`);
    expect(formats.some((f) => f.includes("global/MEMORY.md:") && f.includes("pnpm"))).toBe(true);
    expect(formats.some((f) => f.includes("workspace/MEMORY.md:") && f.includes("PostgreSQL"))).toBe(true);
    expect(formats.some((f) => f.includes("daily/2026-09-12.md") && f.includes("deploy"))).toBe(true);
  });

  test("白名单排除的文件不参与检索；无命中返回空", async () => {
    await enableAll();
    await applyMemoryConfig({
      ...getMemoryConfig(),
      enabledFiles: { global: ["team.md"], workspace: null },
    });
    expect(searchMemoryText(ws, "pnpm").some((h) => h.rel === "MEMORY.md")).toBe(false);
    expect(searchMemoryText(ws, "量子纠错码")).toEqual([]);
  });

  test("关闭的作用域不参与检索", async () => {
    await enableAll();
    await applyMemoryConfig({ ...getMemoryConfig(), workspace: false, enabledFiles: { global: null, workspace: null } });
    expect(searchMemoryText(ws, "PostgreSQL")).toEqual([]);
    await enableAll();
  });
});

describe("writeMemoryFile / readMemoryFile", () => {
  test("append 盖时间戳注释，多次追加用空行分隔", async () => {
    await enableAll();
    const r1 = await writeMemoryFile("workspace", ws, "MEMORY.md", "#preference [[editor]] Neovim.", "append");
    expect(r1.mode).toBe("append");
    const text1 = await readMemoryFile(getMemoryConfig(), "workspace", ws, "MEMORY.md");
    expect(text1.kind).toBe("text");
    if (text1.kind === "text") {
      expect(text1.content).toContain("<!-- ");
      expect(text1.content).toContain("#preference [[editor]] Neovim.");
    }
    await writeMemoryFile("workspace", ws, "MEMORY.md", "#lesson [[api]] Version by URL prefix.", "append");
    const text2 = await readMemoryFile(getMemoryConfig(), "workspace", ws, "MEMORY.md");
    if (text2.kind === "text") {
      expect((text2.content.match(/<!-- /g) ?? []).length).toBe(2);
    }
  });

  test("overwrite 整体覆盖并盖 last updated", async () => {
    await writeMemoryFile("global", ws, "overwrite.md", "old", "append");
    await writeMemoryFile("global", ws, "overwrite.md", "new content", "overwrite");
    const res = await readMemoryFile(getMemoryConfig(), "global", ws, "overwrite.md");
    if (res.kind === "text") {
      expect(res.content).toContain("last updated");
      expect(res.content).toContain("new content");
      expect(res.content).not.toContain("old");
    }
  });

  test("非法文件名与路径穿越被拒绝", async () => {
    await expect(writeMemoryFile("global", ws, "../evil.md", "x")).rejects.toThrow();
    await expect(writeMemoryFile("global", ws, "sub/dir.md", "x")).rejects.toThrow();
    const traversal = await readMemoryFile(getMemoryConfig(), "global", ws, "../../secrets.md");
    expect(traversal.kind).toBe("missing");
  });

  test("缺省 file = 返回清单", async () => {
    const res = await readMemoryFile(getMemoryConfig(), "global", ws);
    expect(res.kind).toBe("list");
    if (res.kind === "list") {
      expect(res.files[0]?.name).toBe("MEMORY.md");
      expect(res.daily.length).toBe(1);
    }
  });
});

describe("buildMemoryTools", () => {
  const tools = () => Object.fromEntries(buildMemoryTools(ws).map((t) => [t.name, t]));
  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = tools()[name]!;
    const res = (await tool.execute("t1", params)) as { content: { text: string }[] };
    return res.content[0].text;
  };

  test("总开关关闭时一律婉拒", async () => {
    await applyMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    expect(await run("memory_write", { scope: "global", content: "x" })).toContain("disabled");
    expect(await run("memory_read", { scope: "global" })).toContain("disabled");
    expect(await run("memory_search", { query: "pnpm" })).toContain("disabled");
  });

  test("write → prompt 注入可见；read 列表；search 命中", async () => {
    await enableAll();
    const out = await run("memory_write", {
      scope: "workspace",
      content: "#decision [[queue]] Prompt queue is per-thread.",
    });
    expect(out).toContain("workspace/MEMORY.md");
    expect(memoryPromptBlock(ws)).toContain("Prompt queue is per-thread.");

    const list = await run("memory_read", { scope: "workspace" });
    expect(list).toContain("MEMORY.md");

    const hits = await run("memory_search", { query: "queue per-thread" });
    expect(hits).toContain("workspace/MEMORY.md:");
  });

  test("fileSearch 关闭时 search 婉拒，write/read 不受影响", async () => {
    await applyMemoryConfig({ ...getMemoryConfig(), fileSearch: false });
    expect(await run("memory_search", { query: "pnpm" })).toContain("switched off");
    expect(await run("memory_read", { scope: "global" })).not.toContain("switched off");
  });

  test("工作区开关关闭时 workspace 工具婉拒、global 正常", async () => {
    await enableAll();
    await applyMemoryConfig({ ...getMemoryConfig(), workspace: false });
    expect(await run("memory_write", { scope: "workspace", content: "x" })).toContain("switched off");
    expect(await run("memory_write", { scope: "global", content: "still fine" })).toContain("global/MEMORY.md");
  });
});

describe("initMemory", () => {
  test("从 kv 恢复整包配置", async () => {
    await enableAll();
    const persisted = JSON.parse((await kvGet("pi.memory"))!.value);
    expect(persisted.enabled).toBe(true);
    resetMemoryConfigForTest();
    expect(getMemoryConfig().enabled).toBe(false);
    await initMemory();
    expect(getMemoryConfig().enabled).toBe(true);
    await applyMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
  });
});

describe("memoryScopesPayload / listRootMemoryFiles", () => {
  test("MEMORY.md 恒排最前；payload 带目录路径与信任态", async () => {
    const files = listRootMemoryFiles(globalDir).map((f) => f.name);
    expect(files.indexOf("MEMORY.md")).toBe(0);
    const payload = memoryScopesPayload(ws);
    expect(payload.global.dir).toBe(globalDir);
    expect(payload.workspace!.dir).toBe(wsMemoryDir);
    expect(memoryScopesPayload().workspace).toBeNull();
  });
});
