/**
 * UI 面板贡献（panels.json）的测试：声明解析（manifest.readPluginPanelsFile /
 * globMatch）与安装链读模型（readPluginPanels / findEnabledPluginPanel /
 * readPluginPanelAsset），以及 open_plugin_panel 工具的唤起回执。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addMarketplace,
  findEnabledPluginPanel,
  globMatch,
  installPlugin,
  installedPluginDir,
  listInstalledPlugins,
  parsePluginManifest,
  pluginsRootDir,
  readPluginPanelAsset,
  removeMarketplace,
  readPluginPanelRev,
  readPluginPanels,
  readPluginPanelsFile as readPanels,
  resetPluginsForTest,
  resolvePanelIconDataUrl,
  setPluginEnabled,
  uninstallPlugin,
} from "../../src/plugins/plugins";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import { setActiveReqId } from "../../src/protocol/stream";
import { buildOpenPanelTool, findPanelClaimingFile, maybeAutoOpenPanel } from "../../src/tools/open-panel-tool";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-panels-"));
const prevPluginsDir = process.env.PI_PLUGINS_DIR;

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
  process.env.PI_PLUGINS_DIR = path.join(tmp, "plugins-root");
});

afterAll(() => {
  resetPluginsForTest();
  resetStorageForTest();
  if (prevPluginsDir === undefined) delete process.env.PI_PLUGINS_DIR;
  else process.env.PI_PLUGINS_DIR = prevPluginsDir;
  rmSync(tmp, { recursive: true, force: true });
});

/* ---------------- readPluginPanelsFile ---------------- */

describe("readPluginPanelsFile", () => {
  const packRoot = path.join(tmp, "panels-parse-pack");
  const file = path.join(packRoot, "panels.json");

  test("文件缺失 / 坏 JSON / 顶层非数组 → 空 + 诊断", () => {
    const d1: string[] = [];
    expect(readPanels(path.join(packRoot, "nope.json"), packRoot, d1)).toEqual([]);
    expect(d1.some((d) => /不存在/.test(d))).toBe(true);

    mkdirSync(packRoot, { recursive: true });
    writeFileSync(file, "{oops");
    const d2: string[] = [];
    expect(readPanels(file, packRoot, d2)).toEqual([]);
    expect(d2.some((d) => /解析失败/.test(d))).toBe(true);

    writeFileSync(file, JSON.stringify({ id: "canvas" }));
    const d3: string[] = [];
    expect(readPanels(file, packRoot, d3)).toEqual([]);
    expect(d3.some((d) => /数组/.test(d))).toBe(true);
  });

  test("混合数组：合法条目宽松成形，坏条目逐条跳过并记诊断", () => {
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "canvas",
          title: "无限画布 · 幻灯片",
          icon: "icon.svg",
          entry: "./canvas.html",
          opens: ["*.canvas.json", 42, "   ", "slides/*.deck.json"],
          permissions: ["document", "bogus", "export", "export", "agent"],
        },
        { id: "view", entry: "view.htm" },
        { id: "iconremote", entry: "e.html", icon: "https://x.example/i.svg" },
        { id: "iconescape", entry: "e.html", icon: "../out.svg" },
        { title: "无 id", entry: "x.html" },
        { id: "Bad Id", entry: "x.html" },
        { id: "canvas", entry: "dup.html" },
        { id: "noentry" },
        { id: "escape", entry: "../evil.html" },
        { id: "nothtml", entry: "main.ts" },
        99,
      ]),
    );
    const diags: string[] = [];
    const panels = readPanels(file, packRoot, diags);
    expect(panels.map((p) => p.id)).toEqual(["canvas", "view", "iconremote", "iconescape"]);

    const canvas = panels[0]!;
    expect(canvas.title).toBe("无限画布 · 幻灯片");
    expect(canvas.entry).toBe("canvas.html"); // ./ 前缀规范化
    expect(canvas.icon).toBe("icon.svg");
    expect(canvas.opens).toEqual(["*.canvas.json", "slides/*.deck.json"]); // 非串/空白过滤
    expect(canvas.permissions).toEqual(["document", "export", "agent"]); // 白名单 + 去重

    const view = panels[1]!;
    expect(view.title).toBe("view"); // title 缺省回退 id
    expect(view.opens).toEqual([]);
    expect(view.permissions).toEqual([]);

    expect(panels[2]!.icon).toBe("https://x.example/i.svg"); // 远程 icon 原样
    expect(panels[3]!.icon).toBeUndefined(); // 逃逸 icon 丢字段不丢条目
    expect(diags.some((d) => /icon 逃逸|逃逸/.test(d))).toBe(true);

    // 各坏条目都留了诊断痕迹（逃逸条目的文案来自 containedRelPath，无"已忽略"）
    expect(diags.filter((d) => /已忽略/.test(d)).length).toBeGreaterThanOrEqual(6);
    expect(diags.some((d) => /重复 id/.test(d))).toBe(true);
    expect(diags.some((d) => /\.html/.test(d))).toBe(true);
    expect(diags.some((d) => /逃逸/.test(d))).toBe(true);
  });

  test("parsePluginManifest 识别 panels 组件字段", () => {
    mkdirSync(path.join(packRoot, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(packRoot, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "panels-parse-pack", version: "1.0.0", panels: "panels.json" }),
    );
    const m = parsePluginManifest(packRoot);
    expect(m.components.panels).toBe("panels.json");
  });
});

/* ---------------- globMatch ---------------- */

describe("globMatch", () => {
  test("* 不跨路径段；大小写不敏感；. 是字面量", () => {
    expect(globMatch("*.canvas.json", "deck.canvas.json")).toBe(true);
    expect(globMatch("*.canvas.json", "DECK.CANVAS.JSON")).toBe(true);
    expect(globMatch("*.canvas.json", "sub/deck.canvas.json")).toBe(false);
    expect(globMatch("sub/*.json", "sub/a.json")).toBe(true);
    expect(globMatch("sub/*.json", "subx/a.json")).toBe(false);
    expect(globMatch("a.bc", "abc")).toBe(false); // 点不被通配展开
    expect(globMatch("?.json", "x.json")).toBe(true);
  });
});

/* ---------------- 安装链读模型 ---------------- */

describe("安装后的面板读模型与入口资产", () => {
  const marketRoot = path.join(tmp, "market");
  const packDir = path.join(marketRoot, "plugins", "canvas-pack");
  let pluginId = "";

  beforeAll(async () => {
    mkdirSync(path.join(packDir, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(packDir, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "canvas-pack", version: "0.1.0", description: "d", panels: "panels.json" }),
    );
    writeFileSync(
      path.join(packDir, "panels.json"),
      JSON.stringify([
        {
          id: "canvas",
          title: "无限画布",
          icon: "icon.svg",
          entry: "canvas.html",
          opens: ["*.canvas.json"],
          permissions: ["document", "export", "agent", "notify"],
        },
        { id: "evil", entry: "../outside.html" },
      ]),
    );
    writeFileSync(path.join(packDir, "canvas.html"), "<html><body>hi</body></html>");
    writeFileSync(path.join(packDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(path.join(marketRoot, "marketplace.json"), JSON.stringify({
      name: "panel-test-market",
      plugins: [{ name: "canvas-pack", source: "./plugins/canvas-pack" }],
    }));

    const { record } = await addMarketplace({ type: "directory", path: marketRoot });
    const { plugin } = await installPlugin(record.id, "canvas-pack");
    pluginId = plugin.pluginId;
  });

  afterAll(async () => {
    if (pluginId) await uninstallPlugin(pluginId).catch(() => {});
  });

  test("readPluginPanels：安装复制目录后仅剩合法面板", () => {
    const plugin = findEnabledPluginPanel(pluginId, "canvas")!.plugin;
    const panels = readPluginPanels(plugin);
    expect(panels.map((p) => p.id)).toEqual(["canvas"]);
    expect(panels[0]!.opens).toEqual(["*.canvas.json"]);
  });

  test("resolvePanelIconDataUrl 本地 svg → data URL", () => {
    const { plugin, panel } = findEnabledPluginPanel(pluginId, "canvas")!;
    const src = resolvePanelIconDataUrl(plugin.manifest, panel.icon!);
    expect(src?.startsWith("data:image/svg+xml")).toBe(true);
  });

  test("readPluginPanelAsset：内容、rev 签名与变更刷新", () => {
    const a1 = readPluginPanelAsset(pluginId, "canvas");
    expect(a1).toBeDefined();
    expect(Buffer.from(a1!.base64, "base64").toString("utf8")).toContain("<body>hi</body>");
    const st = statSync(path.join(findEnabledPluginPanel(pluginId, "canvas")!.plugin.manifest.root, "canvas.html"));
    expect(a1!.rev).toBe(`${Math.round(st.mtimeMs)}:${st.size}`);

    writeFileSync(
      path.join(findEnabledPluginPanel(pluginId, "canvas")!.plugin.manifest.root, "canvas.html"),
      "<html><body>updated</body></html>",
    );
    const a2 = readPluginPanelAsset(pluginId, "canvas");
    expect(a2!.rev).not.toBe(a1!.rev);
    expect(Buffer.from(a2!.base64, "base64").toString("utf8")).toContain("updated");
  });

  test("未知面板 / 禁用插件 → undefined", async () => {
    expect(readPluginPanelAsset(pluginId, "nope")).toBeUndefined();
    expect(readPluginPanelAsset("nope@m", "canvas")).toBeUndefined();
    await setPluginEnabled(pluginId, false);
    expect(findEnabledPluginPanel(pluginId, "canvas")).toBeUndefined();
    expect(readPluginPanelAsset(pluginId, "canvas")).toBeUndefined();
    await setPluginEnabled(pluginId, true);
    expect(findEnabledPluginPanel(pluginId, "canvas")).toBeDefined();
  });

  test("入口超 8MB 上限 → 抛错（调用方转协议错误）", () => {
    const abs = path.join(findEnabledPluginPanel(pluginId, "canvas")!.plugin.manifest.root, "canvas.html");
    const keep = readFileSync(abs);
    try {
      writeFileSync(abs, Buffer.alloc(9 * 1024 * 1024, 0x20));
      expect(() => readPluginPanelAsset(pluginId, "canvas")).toThrow(/too large/);
    } finally {
      writeFileSync(abs, keep);
    }
  });
});

/* ---------------- 链接安装（dev 模式） ---------------- */

describe("链接安装（dev 模式）", () => {
  const devMarketRoot = path.join(tmp, "dev-market");
  const devPackDir = path.join(devMarketRoot, "plugins", "dev-pack");
  let mktId = "";
  let pluginId = "";

  function dest(): string {
    return installedPluginDir(mktId, "dev-pack");
  }

  beforeAll(async () => {
    mkdirSync(path.join(devPackDir, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(devPackDir, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "dev-pack", version: "0.1.0", panels: "panels.json" }),
    );
    writeFileSync(
      path.join(devPackDir, "panels.json"),
      JSON.stringify([{ id: "panel", title: "P", entry: "panel.html", opens: [], permissions: [] }]),
    );
    writeFileSync(path.join(devPackDir, "panel.html"), "<html>dev-v1</html>");
    writeFileSync(
      path.join(devMarketRoot, "marketplace.json"),
      JSON.stringify({ name: "dev-market", plugins: [{ name: "dev-pack", source: "./plugins/dev-pack" }] }),
    );
    const { record } = await addMarketplace({ type: "directory", path: devMarketRoot });
    mktId = record.id;
    const { plugin } = await installPlugin(mktId, "dev-pack", { link: true });
    pluginId = plugin.pluginId;
  });

  afterAll(async () => {
    if (pluginId) await uninstallPlugin(pluginId).catch(() => {});
    removeMarketplace(mktId);
  });

  test("cache 条目是符号链接；扫描标 linked/sourcePath；源目录零污染", () => {
    expect(lstatSync(dest()).isSymbolicLink()).toBe(true);
    const entry = listInstalledPlugins().find((p) => p.pluginId === pluginId)!;
    expect(entry.linked).toBe(true);
    expect(entry.sourcePath).toBe(devPackDir);
    // 元数据落兄弟文件，绝不写进用户源仓库
    expect(existsSync(`${dest()}.installed.json`)).toBe(true);
    expect(existsSync(path.join(devPackDir, "installed.json"))).toBe(false);
  });

  test("改源即见：源目录重建 entry 后资产与 rev 实时命中，rev 带 linked", () => {
    const before = readPluginPanelAsset(pluginId, "panel");
    expect(before).toBeDefined();
    const revBefore = readPluginPanelRev(pluginId, "panel");
    expect(revBefore).toEqual({ rev: before!.rev, linked: true });
    // 模拟 pnpm build 重写产物（同一路径覆盖写）
    writeFileSync(path.join(devPackDir, "panel.html"), "<html>dev-v2-longer</html>");
    const after = readPluginPanelAsset(pluginId, "panel");
    expect(Buffer.from(after!.base64, "base64").toString("utf8")).toContain("dev-v2-longer");
    const revAfter = readPluginPanelRev(pluginId, "panel");
    expect(revAfter!.rev).toBe(after!.rev);
    expect(revAfter!.rev).not.toBe(revBefore!.rev);
    expect(revAfter!.linked).toBe(true);
  });

  test("更新保持链接模式；显式 link:false 回退拷贝装；rev.linked 随模式", async () => {
    await installPlugin(mktId, "dev-pack"); // 缺省 = 保持现有模式
    expect(lstatSync(dest()).isSymbolicLink()).toBe(true);
    await installPlugin(mktId, "dev-pack", { link: false }); // 强制拷贝
    expect(lstatSync(dest()).isDirectory()).toBe(true);
    expect(existsSync(path.join(dest(), "installed.json"))).toBe(true);
    expect(existsSync(`${dest()}.installed.json`)).toBe(false);
    const copied = listInstalledPlugins().find((p) => p.pluginId === pluginId)!;
    expect(copied.linked).toBeUndefined();
    expect(readPluginPanelRev(pluginId, "panel")!.linked).toBe(false);
    // 拷回链接装，交给下一用例断言卸载语义
    await installPlugin(mktId, "dev-pack", { link: true });
  });

  test("卸载链接：只删链接与兄弟元数据，源目录完好", async () => {
    const marker = path.join(devPackDir, ".xulux-plugin", "plugin.json");
    await uninstallPlugin(pluginId);
    expect(existsSync(dest())).toBe(false);
    expect(existsSync(`${dest()}.installed.json`)).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(path.join(devPackDir, "panel.html"))).toBe(true);
  });

  test("未知面板 / 禁用 → readPluginPanelRev undefined", async () => {
    expect(readPluginPanelRev(pluginId, "nope")).toBeUndefined();
    expect(readPluginPanelRev("nope@m", "panel")).toBeUndefined();
    await setPluginEnabled(pluginId, false);
    expect(readPluginPanelRev(pluginId, "panel")).toBeUndefined();
    await setPluginEnabled(pluginId, true);
  });
});

/* ---------------- open_plugin_panel 工具 ---------------- */

describe("open_plugin_panel 工具", () => {
  const THREAD = "panel-tool-thread";
  const REQ = "req-panel-tool";

  /** 在 execute 窗口内接管 stdout，抓 NDJSON 帧（sendEventChunk 真实落点） */
  async function captureFrames<T>(fn: () => Promise<T>): Promise<{ value: T; lines: unknown[] }> {
    const orig = process.stdout.write.bind(process.stdout);
    const lines: unknown[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const value = await fn();
      return { value, lines };
    } finally {
      process.stdout.write = orig;
    }
  }

  beforeAll(() => setActiveReqId(THREAD, REQ));
  afterAll(() => setActiveReqId(THREAD, null));

  const marketRoot = path.join(tmp, "tool-market");
  const packDir = path.join(marketRoot, "plugins", "tool-pack");
  let pluginId = "";

  test("安装带面板插件后：成功唤起发 data-pluginOpen 帧并带绑定路径", async () => {
    mkdirSync(path.join(packDir, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(packDir, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "tool-pack", version: "0.1.0", panels: "panels.json" }),
    );
    writeFileSync(
      path.join(packDir, "panels.json"),
      JSON.stringify([{ id: "canvas", entry: "c.html", opens: ["*.canvas.json"], permissions: ["document"] }]),
    );
    writeFileSync(path.join(packDir, "c.html"), "<html/>");
    writeFileSync(
      path.join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "tool-market", plugins: [{ name: "tool-pack", source: "./plugins/tool-pack" }] }),
    );
    const { record } = await addMarketplace({ type: "directory", path: marketRoot });
    const { plugin } = await installPlugin(record.id, "tool-pack");
    pluginId = plugin.pluginId;

    const tool = buildOpenPanelTool("/workspace/demo", THREAD);
    const { value: res, lines } = await captureFrames(() =>
      tool.execute("tc1", { plugin: pluginId, panel: "canvas", path: "docs/deck.canvas.json" }),
    );
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("已在右侧面板打开");
    const frames = lines
      .map((l) => {
        try {
          return JSON.parse(String(l).trim()) as { id?: string; chunk?: Record<string, unknown> };
        } catch {
          return null;
        }
      })
      .filter((f): f is { id: string; chunk: Record<string, unknown> } => f?.id === REQ);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.chunk).toEqual({
      type: "data-pluginOpen",
      data: { plugin: pluginId, panel: "canvas", path: "docs/deck.canvas.json", cwd: "/workspace/demo" },
    });
    await uninstallPlugin(pluginId);
  });

  test("只写插件名（不带市场后缀）也能唤起：唯名匹配 + 帧里带解析后的完整 id", async () => {
    mkdirSync(path.join(packDir, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(packDir, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "tool-pack", version: "0.1.0", panels: "panels.json" }),
    );
    writeFileSync(
      path.join(packDir, "panels.json"),
      JSON.stringify([{ id: "canvas", entry: "c.html", opens: ["*.canvas.json"], permissions: ["document"] }]),
    );
    writeFileSync(path.join(packDir, "c.html"), "<html/>");
    const { record } = await addMarketplace({ type: "directory", path: marketRoot });
    const { plugin } = await installPlugin(record.id, "tool-pack");
    const tool = buildOpenPanelTool("/workspace/demo", THREAD);
    const { value: res, lines } = await captureFrames(() =>
      tool.execute("tc-name", { plugin: "tool-pack", panel: "canvas" }),
    );
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("已在右侧面板打开");
    expect(lines.some((l) => String(l).includes(plugin.pluginId))).toBe(true);
    await uninstallPlugin(plugin.pluginId);
  });

  test("未知面板 / 缺参 → 文本错误且不发帧", async () => {
    const tool = buildOpenPanelTool("/workspace/demo", THREAD);
    const miss = await tool.execute("tc2", { plugin: "x@m", panel: "" });
    expect((miss.content as Array<{ text: string }>)[0]!.text).toContain("必填");
    const { value: unknownPanel, lines } = await captureFrames(() =>
      tool.execute("tc3", { plugin: "ghost@m", panel: "canvas" }),
    );
    expect((unknownPanel.content as Array<{ text: string }>)[0]!.text).toContain("面板不可用");
    expect(lines.filter((l) => String(l).includes(REQ))).toHaveLength(0);
  });
});

/* ---------------- write/edit 落盘自动开板 ---------------- */

describe("write/edit 落盘自动开板", () => {
  const THREAD = "auto-open-thread";
  const REQ = "req-auto-open";
  const WS = path.join(tmp, "auto-ws");

  function capturePluginOpens(fn: () => void, thread: string = THREAD): Array<Record<string, unknown>> {
    setActiveReqId(thread, REQ);
    const orig = process.stdout.write.bind(process.stdout);
    const lines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = orig;
      setActiveReqId(thread, null);
    }
    return lines
      .map((l) => {
        try {
          return JSON.parse(l.trim()) as { id?: string; chunk?: Record<string, unknown> };
        } catch {
          return null;
        }
      })
      .filter((f) => f?.id === REQ && f.chunk?.type === "data-pluginOpen")
      .map((f) => f!.chunk as unknown as Record<string, unknown>);
  }

  let pluginId = "";

  beforeAll(async () => {
    mkdirSync(WS, { recursive: true });
    const marketRoot = path.join(tmp, "auto-market");
    const packDir = path.join(marketRoot, "plugins", "auto-pack");
    mkdirSync(path.join(packDir, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(packDir, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "auto-pack", version: "0.1.0", panels: "panels.json" }),
    );
    writeFileSync(
      path.join(packDir, "panels.json"),
      JSON.stringify([{ id: "canvas", title: "画布", entry: "c.html", opens: ["*.canvas.json"], permissions: [] }]),
    );
    writeFileSync(path.join(packDir, "c.html"), "<html/>");
    writeFileSync(
      path.join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "auto-market", plugins: [{ name: "auto-pack", source: "./plugins/auto-pack" }] }),
    );
    const { record } = await addMarketplace({ type: "directory", path: marketRoot });
    const { plugin } = await installPlugin(record.id, "auto-pack");
    pluginId = plugin.pluginId;
  });

  afterAll(async () => {
    if (pluginId) await uninstallPlugin(pluginId).catch(() => {});
  });

  test("认领文件（含子目录 basename 匹配）首次写 → 恰好一帧，带 rel 路径与 cwd", () => {
    const frames = capturePluginOpens(() => {
      maybeAutoOpenPanel(WS, THREAD, "roadmap.canvas.json");
      maybeAutoOpenPanel(WS, THREAD, "docs/screen.canvas.json"); // `*.canvas.json` 不跨 /，按文件名匹配
    });
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      type: "data-pluginOpen",
      data: { plugin: pluginId, panel: "canvas", path: "roadmap.canvas.json", cwd: WS },
    });
    expect((frames[1]!.data as { path: string }).path).toBe("docs/screen.canvas.json");
  });

  test("同线程重复写同一文件去重；未认领文件与工作区外路径不发帧", () => {
    const frames = capturePluginOpens(() => {
      maybeAutoOpenPanel(WS, THREAD, "roadmap.canvas.json"); // 上一用例已开过板
      maybeAutoOpenPanel(WS, THREAD, path.join(WS, "docs/screen.canvas.json")); // 绝对路径同归一
      maybeAutoOpenPanel(WS, THREAD, "notes.md"); // opens 不认领
      maybeAutoOpenPanel(WS, THREAD, path.join(tmp, "outside.canvas.json")); // 工作区外
    });
    expect(frames).toHaveLength(0);
  });

  test("不同线程互不去重；findPanelClaimingFile 命中与未命中", () => {
    expect(findPanelClaimingFile("a.canvas.json")?.pluginId).toBe(pluginId);
    expect(findPanelClaimingFile("a.txt")).toBeUndefined();
    const frames = capturePluginOpens(() => {
      maybeAutoOpenPanel(WS, "other-thread", "roadmap.canvas.json");
    }, "other-thread");
    expect(frames).toHaveLength(1);
  });
});
