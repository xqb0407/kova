import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMemoryConfig,
  buildMemoryTools,
  DEFAULT_MEMORY_CONFIG,
  deleteMemoryTrash,
  deleteMemoryVersion,
  emptyMemoryTrash,
  getMemoryConfig,
  initMemory,
  listMemoryTrash,
  listMemoryVersions,
  listRootMemoryFiles,
  MAX_VERSIONS_PER_FILE,
  memoryPromptBlock,
  memoryScopesPayload,
  normalizeMemoryConfig,
  readMemoryFile,
  readMemoryVersion,
  resetMemoryConfigForTest,
  restoreMemoryTrash,
  restoreMemoryVersion,
  searchMemoryText,
  snapshotMemoryVersion,
  trashMemoryFile,
  writeMemoryFile,
} from "../../src/agent/memory";
import { composeModeSystemPrompt } from "../../src/agent/modes";
import { initLocalStorage, kvGet, resetStorageForTest } from "../../src/storage/hostdb";
import { buildTools, SYSTEM_PROMPT_CORE, workspacePromptLine } from "../../src/tools/tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-memory-"));
const globalDir = path.join(tmp, "global-memory");
const ws = path.join(tmp, "ws");
const wsMemoryDir = path.join(ws, ".kova", "memory");
const prevMemoryDir = process.env.PI_MEMORY_DIR;
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(async () => {
  initLocalStorage(path.join(tmp, "state.db"));
  process.env.PI_MEMORY_DIR = globalDir;
  // 个性化身份文件实时读盘：钉到空目录，保证默认提示词基线不受真实 ~/.kova/ 影响
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
    const baseline = composeModeSystemPrompt("agent", ws, "code");
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
    const prompt = composeModeSystemPrompt("agent", ws, "code");
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

describe("版本史（.history）", () => {
  // 历史跨用例累积，所以每个用例用独立文件名，断言互不干扰
  test("写入后自动记一版（append/overwrite 都记，最新一版=当前内容）", async () => {
    await enableAll();
    const file = "versions-1.md";
    expect(listMemoryVersions("global", ws, file)).toHaveLength(0);
    await writeMemoryFile("global", ws, file, "第一条", "append", "page");
    const after1 = listMemoryVersions("global", ws, file);
    expect(after1).toHaveLength(1);
    expect(after1[0]!.source).toBe("page");
    const onDisk = readFileSync(path.join(globalDir, file), "utf8");
    expect(await readMemoryVersion("global", ws, file, after1[0]!.id)).toBe(onDisk);
  });

  test("来源标签区分页面保存与 AI 写入", async () => {
    await enableAll();
    const file = "versions-2.md";
    await writeMemoryFile("global", ws, file, "页面改的", "overwrite", "page");
    await writeMemoryFile("global", ws, file, "AI 改的", "overwrite", "agent");
    const versions = listMemoryVersions("global", ws, file);
    expect(versions[0]!.source).toBe("agent");
    expect(versions[1]!.source).toBe("page");
  });

  test("外部编辑器改过：补一版 external（与最新一版不同才记）", async () => {
    await enableAll();
    const file = "versions-3.md";
    await writeMemoryFile("global", ws, file, "页面的内容", "overwrite", "page");
    const before = listMemoryVersions("global", ws, file).length;
    // 未改动时补录是空操作（设置页每次打开都会走这一步）
    await snapshotMemoryVersion("global", ws, file, "external");
    expect(listMemoryVersions("global", ws, file)).toHaveLength(before);
    // 直接改盘上文件（模拟外部编辑器）
    writeFileSync(path.join(globalDir, file), "外部改的内容\n");
    await snapshotMemoryVersion("global", ws, file, "external");
    const versions = listMemoryVersions("global", ws, file);
    expect(versions).toHaveLength(before + 1);
    expect(versions[0]!.source).toBe("external");
    expect(await readMemoryVersion("global", ws, file, versions[0]!.id)).toBe("外部改的内容\n");
  });

  test("恢复旧版：内容写回，写回本身又记一版（来源 restore）", async () => {
    await enableAll();
    const file = "versions-4.md";
    await writeMemoryFile("global", ws, file, "v1", "overwrite", "page");
    await writeMemoryFile("global", ws, file, "v2", "overwrite", "page");
    const v1 = listMemoryVersions("global", ws, file).at(-1)!;
    await restoreMemoryVersion("global", ws, file, v1.id);
    const res = await readMemoryFile(getMemoryConfig(), "global", ws, file);
    if (res.kind === "text") {
      expect(res.content).toContain("v1");
      expect(res.content).not.toContain("v2");
    }
    expect(listMemoryVersions("global", ws, file)[0]!.source).toBe("restore");
  });

  test("删单条版本只动历史，不动当前内容", async () => {
    await enableAll();
    const file = "versions-5.md";
    await writeMemoryFile("global", ws, file, "keep me", "overwrite", "page");
    const [v] = listMemoryVersions("global", ws, file);
    await deleteMemoryVersion("global", ws, file, v!.id);
    expect(listMemoryVersions("global", ws, file)).toHaveLength(0);
    const res = await readMemoryFile(getMemoryConfig(), "global", ws, file);
    if (res.kind === "text") expect(res.content).toContain("keep me");
  });

  test("同毫秒连续写入不互相覆盖（文件名避让 + force 必留痕）", async () => {
    await enableAll();
    const file = "versions-6.md";
    await writeMemoryFile("global", ws, file, "底稿", "overwrite", "page");
    const before = listMemoryVersions("global", ws, file).length;
    // force 连记三版（删除这类"事件"必须留痕）：同毫秒下文件名要避让，不能互相盖掉
    await snapshotMemoryVersion("global", ws, file, "delete", true);
    await snapshotMemoryVersion("global", ws, file, "delete", true);
    await snapshotMemoryVersion("global", ws, file, "delete", true);
    expect(listMemoryVersions("global", ws, file)).toHaveLength(before + 3);
  });

  test("保留上限：超出后裁掉最旧的", async () => {
    await enableAll();
    const file = "versions-7.md";
    for (let i = 0; i < MAX_VERSIONS_PER_FILE + 3; i += 1) {
      await writeMemoryFile("global", ws, file, `内容 ${i}`, "overwrite", "page");
    }
    const versions = listMemoryVersions("global", ws, file);
    expect(versions).toHaveLength(MAX_VERSIONS_PER_FILE);
    // 最新一版仍在（裁的是最旧的）
    expect(await readMemoryVersion("global", ws, file, versions[0]!.id)).toContain(
      `内容 ${MAX_VERSIONS_PER_FILE + 2}`,
    );
  });

  test("护栏：非法文件名与伪造的版本 id 都被拒；.history 不进文件清单", async () => {
    await enableAll();
    const file = "versions-8.md";
    await writeMemoryFile("global", ws, file, "x", "overwrite", "page");
    expect(listMemoryVersions("global", ws, "../evil.md")).toEqual([]);
    await expect(readMemoryVersion("global", ws, file, "../../MEMORY.md")).rejects.toThrow();
    await expect(readMemoryVersion("global", ws, file, "not-a-version.md")).rejects.toThrow();
    await expect(deleteMemoryVersion("global", ws, file, "2026-01-01T00-00-00-000Z--bogus.md")).rejects.toThrow();
    const names = listRootMemoryFiles(globalDir).map((f) => f.name);
    expect(names).not.toContain(".history");
  });
});

describe("回收站（.trash）", () => {
  // 各用例独立文件名（回收站与历史都跨用例累积）
  test("删除 = 移入回收站：文件清单/注入/检索都看不到，回收站里在", async () => {
    await enableAll();
    const tFile = "trash-1.md";
    await writeMemoryFile("global", ws, tFile, "#fact [[x]] 待删除内容", "overwrite", "page");
    expect(listRootMemoryFiles(globalDir).map((f) => f.name)).toContain(tFile);
    const res = await trashMemoryFile("global", ws, tFile);
    expect(res.name).toBe(tFile);
    expect(listRootMemoryFiles(globalDir).map((f) => f.name)).not.toContain(tFile);
    expect(memoryPromptBlock(ws)).not.toContain("待删除内容");
    expect(searchMemoryText(ws, "待删除内容")).toHaveLength(0);
    const trash = listMemoryTrash("global", ws);
    expect(trash.map((e) => e.name)).toContain(tFile);
  });

  test("删除前留一版历史：彻底删掉后仍能从版本史找回内容", async () => {
    await enableAll();
    const tFile = "trash-2.md";
    await writeMemoryFile("global", ws, tFile, "别弄丢我", "overwrite", "page");
    const { id } = await trashMemoryFile("global", ws, tFile);
    const versions = listMemoryVersions("global", ws, tFile);
    expect(versions[0]!.source).toBe("delete");
    expect(await readMemoryVersion("global", ws, tFile, versions[0]!.id)).toContain("别弄丢我");
    await deleteMemoryTrash("global", ws, id);
    expect(listMemoryTrash("global", ws).map((e) => e.id)).not.toContain(id);
    // 彻底删除连版本史一起清（"彻底"就是彻底）
    expect(listMemoryVersions("global", ws, tFile)).toHaveLength(0);
  });

  test("恢复回原名；同名文件已存在时拒绝覆盖", async () => {
    await enableAll();
    const a = "trash-3a.md";
    await writeMemoryFile("global", ws, a, "第一版内容", "overwrite", "page");
    const { id } = await trashMemoryFile("global", ws, a);
    const restored = await restoreMemoryTrash("global", ws, id);
    expect(restored.name).toBe(a);
    expect(listRootMemoryFiles(globalDir).map((f) => f.name)).toContain(a);

    // 再删一次，然后先建同名文件：恢复必须被拒
    await writeMemoryFile("global", ws, a, "第二版内容", "overwrite", "page");
    const again = await trashMemoryFile("global", ws, a);
    await writeMemoryFile("global", ws, a, "当前内容", "overwrite", "page");
    await expect(restoreMemoryTrash("global", ws, again.id)).rejects.toThrow(/同名/);
  });

  test("清空回收站：条目清光，活着的文件的版本史不动", async () => {
    await enableAll();
    const dead = "trash-dead.md";
    const alive = "trash-alive.md";
    await writeMemoryFile("global", ws, alive, "活着", "overwrite", "page");
    await writeMemoryFile("global", ws, dead, "要清的", "overwrite", "page");
    await trashMemoryFile("global", ws, dead);
    const removed = await emptyMemoryTrash("global", ws);
    expect(removed).toBeGreaterThan(0);
    expect(listMemoryTrash("global", ws)).toHaveLength(0);
    expect(listMemoryVersions("global", ws, dead)).toHaveLength(0);
    expect(listMemoryVersions("global", ws, alive).length).toBeGreaterThan(0);
  });

  test("护栏：非法名 / 路径穿越 / 不存在的条目都拒绝", async () => {
    await enableAll();
    await expect(trashMemoryFile("global", ws, "../evil.md")).rejects.toThrow();
    await expect(trashMemoryFile("global", ws, "sub/dir.md")).rejects.toThrow();
    await expect(trashMemoryFile("global", ws, "not-there.md")).rejects.toThrow();
    await expect(restoreMemoryTrash("global", ws, "2026-01-01T00-00-00-000Z--x.md")).rejects.toThrow();
    await expect(deleteMemoryTrash("global", ws, "2026-01-01T00-00-00-000Z--x.md")).rejects.toThrow();
    // .trash 目录不进文件清单
    expect(listRootMemoryFiles(globalDir).map((f) => f.name)).not.toContain(".trash");
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

describe("buildTools 注册（总开关 = 结构的开与关）", () => {
  const MEMORY_TOOL_NAMES = ["memory_write", "memory_read", "memory_search"];

  test("总开关关闭：工具表里没有记忆三件套；开启：三件套按名可查", async () => {
    await applyMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    const off = buildTools(ws, "t-mem-off").map((t) => t.name);
    for (const name of MEMORY_TOOL_NAMES) expect(off).not.toContain(name);

    await enableAll();
    const on = buildTools(ws, "t-mem-on").map((t) => t.name);
    for (const name of MEMORY_TOOL_NAMES) expect(on).toContain(name);
  });

  test("作用域/检索细项开关不影响注册：只有总开关管下发", async () => {
    await applyMemoryConfig({ enabled: true, global: false, workspace: false, fileSearch: false });
    const names = buildTools(ws, "t-mem-scope-off").map((t) => t.name);
    for (const name of MEMORY_TOOL_NAMES) expect(names).toContain(name);
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
