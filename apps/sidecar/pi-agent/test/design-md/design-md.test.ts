/**
 * 设计主题系统单测：清单解析 / 用户层读写遮蔽 / 内置包版本化同步四态 /
 * 「最近使用」kv 恢复链 / use_design_theme 工具 / design 提示词段主题句 /
 * protocol handler（save/delete/set/list 的落库与热重排）。
 * 主题包用内存构造（setBuiltinBundleBytesForTest），目录用 PI_DESIGN_MD_DIR 钉住。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { setBuiltinBundleBytesForTest, resetBundleCacheForTest } from "../../src/design-md/catalog";
import { syncBuiltinThemes, builtinSyncedVersion } from "../../src/design-md/builtin-sync";
import { builtinThemesDir, userThemesDir, designMdRootDir } from "../../src/design-md/paths";
import {
  deleteUserTheme,
  findTheme,
  normalizeThemeRef,
  parseThemeDoc,
  readThemeContent,
  refreshThemes,
  renderThemeDoc,
  resetThemesSnapshotForTest,
  resolveThemeByName,
  saveUserTheme,
  themesSnapshot,
  themeFileSlug,
} from "../../src/design-md/store";
import {
  DESIGN_THEME_KV_KEY,
  decodeThemeColumn,
  encodeThemeColumn,
  getLastUsedDesignTheme,
  initDesignThemeState,
  resetDesignThemeStateForTest,
  setLastUsedDesignTheme,
} from "../../src/design-md/state";
import { buildUseDesignThemeTool } from "../../src/design-md/use-design-theme-tool";
import { applyAppMode, appModePromptBlock, resetAppModeForTest, setUiDesignActiveProbeForTest } from "../../src/agent/app-mode";
import { running } from "../../src/sessions/registry";
// 必须先装载 protocol 图再取 handler 模块：handlers/design-md → sessions → automation
// → protocol.ts 的环回在生产里由 index 先导 protocol 化解，测试直接先取 design-md
// 会让 protocol.ts 在 handlers 绑定前展开 spread（TDZ）。
import "../../src/protocol/protocol";
import { handlers } from "../../src/protocol/handlers/design-md";
import { initLocalStorage, kvGet, resetStorageForTest, sessionGet, sessionInsert, sessionPrefsSet } from "../../src/storage/hostdb";
import { clearRemovedBuiltinThemes, remapThemeRefs } from "../../src/design-md/ref-integrity";
import type { Running } from "../../src/types";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-design-md-"));
const prevDesignDir = process.env.PI_DESIGN_MD_DIR;
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

/* ---------------------------- 内存主题包构造 ---------------------------- */

type FakeCatalog = {
  version: string;
  source?: string;
  themes: Array<{ id: string; name: string; desc: string; accents: string[] }>;
};

function makeBundleBytes(catalog: FakeCatalog, docs: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "catalog.json": strToU8(JSON.stringify(catalog)),
    "LICENSE.txt": strToU8("MIT fake license\n"),
  };
  for (const [slug, doc] of Object.entries(docs)) entries[`${slug}/DESIGN.md`] = strToU8(doc);
  return zipSync(entries, { level: 9 });
}

const V1: FakeCatalog = {
  version: "1.0.0",
  themes: [
    { id: "acme", name: "Acme", desc: "暖橙工坊感", accents: ["#ff6b35"] },
    { id: "nova", name: "Nova", desc: "冷紫夜空感", accents: ["#7c5cff", "#0f1117"] },
  ],
};
const DOCS_V1 = {
  acme: "# Acme Design System\n\nPrimary: #ff6b35.\n",
  nova: "# Nova Design System\n\nPrimary: #7c5cff.\n",
};
// 升级包：acme 下架、bravo 新增（验证「剪旧」与只删 manifest 记账过的目录）
const V2: FakeCatalog = {
  version: "2.0.0",
  themes: [
    { id: "nova", name: "Nova", desc: "冷紫夜空感", accents: ["#7c5cff"] },
    { id: "bravo", name: "Bravo", desc: "石墨极简", accents: [] },
  ],
};
const DOCS_V2 = { nova: DOCS_V1.nova, bravo: "# Bravo\n\nGraphite.\n" };

beforeAll(() => {
  initLocalStorage(join(tmp, "state.db"));
  process.env.PI_DESIGN_MD_DIR = join(tmp, "design-md");
  process.env.PI_IDENTITY_DIR = join(tmp, "identity");
});

afterAll(() => {
  resetThemesSnapshotForTest();
  resetDesignThemeStateForTest();
  resetBundleCacheForTest();
  setBuiltinBundleBytesForTest(null);
  resetAppModeForTest();
  setUiDesignActiveProbeForTest(null);
  resetStorageForTest();
  if (prevDesignDir === undefined) delete process.env.PI_DESIGN_MD_DIR;
  else process.env.PI_DESIGN_MD_DIR = prevDesignDir;
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
  rmSync(tmp, { recursive: true, force: true });
});

async function installBundle(catalog: FakeCatalog, docs: Record<string, string>): Promise<void> {
  setBuiltinBundleBytesForTest(makeBundleBytes(catalog, docs));
  await refreshThemes();
}

/* ------------------------------ normalize/解析 ------------------------------ */

describe("normalizeThemeRef / 列编解码 / slug", () => {
  test("normalizeThemeRef 严格规整", () => {
    expect(normalizeThemeRef({ scope: "builtin", id: " apple " })).toEqual({ scope: "builtin", id: "apple" });
    expect(normalizeThemeRef({ scope: "user", id: "x" })).toEqual({ scope: "user", id: "x" });
    expect(normalizeThemeRef({ scope: "workspace", id: "x" })).toBeNull();
    expect(normalizeThemeRef({ id: "x" })).toBeNull();
    expect(normalizeThemeRef(null)).toBeNull();
    expect(normalizeThemeRef("apple")).toBeNull();
    expect(normalizeThemeRef([{ scope: "user", id: "x" }])).toBeNull();
  });

  test("encode/decodeThemeColumn 三态：NULL=从未设置 / JSON=选中 / \"\"=显式无", () => {
    expect(encodeThemeColumn(null)).toBe("");
    expect(encodeThemeColumn({ scope: "builtin", id: "acme" })).toContain("\"acme\"");
    expect(decodeThemeColumn(null)).toBeUndefined(); // 从未设置 → 调用方回落最近使用
    expect(decodeThemeColumn("")).toBeNull(); // 显式不使用
    expect(decodeThemeColumn("{broken")).toBeNull();
    expect(decodeThemeColumn(encodeThemeColumn({ scope: "user", id: "y" }))).toEqual({ scope: "user", id: "y" });
  });

  test("themeFileSlug 清洗非法字符、保留中文名", () => {
    expect(themeFileSlug("My/Theme: v2")).toBe("My-Theme-v2");
    expect(themeFileSlug("  红白撞色  ")).toBe("红白撞色");
    expect(themeFileSlug("///")).toBe("theme");
  });
});

describe("parseThemeDoc / renderThemeDoc", () => {
  test("frontmatter 往返", () => {
    const draft = { name: "雾都", description: "青灰雾气质感", content: "# Body\n\ncolors", accents: ["#5b7a8a", "#2f3e46"] };
    const parsed = parseThemeDoc(renderThemeDoc(draft));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.name).toBe("雾都");
      expect(parsed.draft.description).toBe("青灰雾气质感");
      expect(parsed.draft.accents).toEqual(["#5b7a8a", "#2f3e46"]);
      expect(parsed.draft.content).toBe("# Body\n\ncolors");
    }
  });

  test("无 frontmatter 用文件名兜底；空正文报错", () => {
    const bare = parseThemeDoc("# Just markdown\n", { fallbackName: "stem" });
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.draft.name).toBe("stem");
    const empty = parseThemeDoc("---\nname: x\n---\n\n   ");
    expect(empty.ok).toBe(false);
  });
});

/* ------------------------------ 清单与遮蔽 ------------------------------ */

describe("refreshThemes 清单（内置 + 用户 + 遮蔽）", () => {
  beforeAll(async () => {
    await installBundle(V1, DOCS_V1);
  });

  test("内置条目来自 zip catalog；正文取 zip 内存副本", async () => {
    const snap = themesSnapshot();
    expect(snap.version).toBe("1.0.0");
    expect(snap.builtinCount).toBe(2);
    expect(snap.userCount).toBe(0);
    expect(snap.error).toBeNull();
    expect(findTheme({ scope: "builtin", id: "acme" })?.name).toBe("Acme");
    expect(await readThemeContent({ scope: "builtin", id: "nova" })).toContain("#7c5cff");
  });

  test("saveUserTheme 新建/同名覆盖/改名清旧", async () => {
    const { ref } = await saveUserTheme({ name: "Demo Theme", description: "d1", content: "body one" });
    expect(ref).toEqual({ scope: "user", id: "Demo-Theme" }); // slug 保留大小写（同 skillFileName）
    await refreshThemes();
    expect(findTheme(ref)?.desc).toBe("d1");

    // 同名覆盖（不同 slug 的旧文件也被归一替换）：clobbered 报出被合并的旧 id——
    // 大小写不敏感文件系统上 "Demo-Theme"/"demo-theme" 本是同一文件，
    // 调用方据此把指向旧 id 的会话引用重映射，不留悬空
    const { ref: ref2, clobbered } = await saveUserTheme({ name: "  demo theme ", description: "d2", content: "body two" });
    expect(ref2.id).toBe("demo-theme");
    expect(clobbered).toEqual(["Demo-Theme"]);
    await refreshThemes();
    expect(themesSnapshot().userCount).toBe(1);
    expect(findTheme(ref2)?.desc).toBe("d2");

    // 改名编辑：replaceId 清旧文件（主 remap 线负责，不进 clobbered）
    const { ref: ref3 } = await saveUserTheme({ name: "Renamed", description: "d3", content: "body three" }, { replaceId: ref2.id });
    expect(ref3.id).toBe("Renamed");
    expect(existsSync(join(userThemesDir(), "demo-theme.md"))).toBe(false);
    await refreshThemes();
    expect(themesSnapshot().userCount).toBe(1);
    deleteUserTheme("Renamed"); // 清场：后续按名断言假定用户层为空
    await refreshThemes();
  });

  test("同名用户主题遮蔽内置：shadowed 标记 + resolveThemeByName 用户优先", async () => {
    await saveUserTheme({ name: "acme", description: "我的 acme", content: "mine" });
    await refreshThemes();
    const builtin = findTheme({ scope: "builtin", id: "acme" });
    expect(builtin?.shadowed).toBe(true);
    expect(resolveThemeByName("Acme")).toEqual({ scope: "user", id: "acme" });
    deleteUserTheme("acme");
    await refreshThemes();
    expect(findTheme({ scope: "builtin", id: "acme" })?.shadowed).toBeUndefined();
    expect(resolveThemeByName("Acme")).toEqual({ scope: "builtin", id: "acme" });
  });

  test("deleteUserTheme 拒绝路径穿越与不存在项", () => {
    expect(() => deleteUserTheme("../evil")).toThrow();
    expect(() => deleteUserTheme("no-such-theme")).toThrow("主题不存在");
  });

  test("用户主题正文现读磁盘（管理页直改后即见）", async () => {
    const { ref } = await saveUserTheme({ name: "Fresh", description: "", content: "first" });
    await refreshThemes();
    writeFileSync(join(userThemesDir(), "fresh.md"), renderThemeDoc({ name: "Fresh", description: "", content: "second" }), "utf8");
    expect(await readThemeContent(ref)).toContain("second");
    deleteUserTheme("fresh");
    await refreshThemes();
  });
});

/* ------------------------------ 版本化同步四态 ------------------------------ */

describe("syncBuiltinThemes：解压/跳过/升级剪旧/失败", () => {
  test("首启 synced → 二启 skipped → 升级剪旧 → 坏包 failed；user 层永不受影响", async () => {
    await installBundle(V1, DOCS_V1);
    // 预置一个"手工"用户主题（升级安全断言锚点）
    mkdirSync(userThemesDir(), { recursive: true });
    const userFile = join(userThemesDir(), "keep.md");
    writeFileSync(userFile, renderThemeDoc({ name: "Keep", description: "", content: "mine" }), "utf8");

    const first = await syncBuiltinThemes();
    expect(first.status).toBe("synced");
    if (first.status === "synced") expect(first.themes).toBe(2);
    if (first.status === "synced") expect(first.removed).toEqual([]); // 首启无旧账可剪
    expect(readFileSync(join(builtinThemesDir(), "acme", "DESIGN.md"), "utf8")).toContain("#ff6b35");
    expect(builtinSyncedVersion()).toBe("1.0.0");

    // 版本一致：跳过（不重写字节）
    const second = await syncBuiltinThemes();
    expect(second.status).toBe("skipped");

    // 升级：nova/bravo 落盘、manifest 记账的 acme 剪除；未记账手工目录不动
    mkdirSync(join(builtinThemesDir(), "manual-dir"), { recursive: true });
    await installBundle(V2, DOCS_V2);
    const third = await syncBuiltinThemes();
    expect(third.status).toBe("synced");
    if (third.status === "synced") expect(third.removed).toEqual(["acme"]); // 升级剪旧清单外抛
    expect(existsSync(join(builtinThemesDir(), "acme"))).toBe(false);
    expect(existsSync(join(builtinThemesDir(), "bravo", "DESIGN.md"))).toBe(true);
    expect(existsSync(join(builtinThemesDir(), "manual-dir"))).toBe(true); // 不在 manifest.slugs → 不碰
    expect(builtinSyncedVersion()).toBe("2.0.0");
    expect(readFileSync(userFile, "utf8")).toContain("mine"); // user 层永远不动

    // 坏包：failed 不抛错、不清盘（上一版 builtin 副本还在）
    setBuiltinBundleBytesForTest(Uint8Array.from([0x50, 0x4b, 0x00, 0x01]));
    await refreshThemes();
    expect(themesSnapshot().error).not.toBeNull();
    const broken = await syncBuiltinThemes();
    expect(broken.status).toBe("failed");
    expect(existsSync(join(builtinThemesDir(), "bravo", "DESIGN.md"))).toBe(true);
    expect(builtinSyncedVersion()).toBe("2.0.0");

    // 收尾恢复干净状态 + 清用户占位
    await installBundle(V1, DOCS_V1);
    await syncBuiltinThemes();
    rmSync(userFile, { force: true });
  });

  test("designMdRootDir 走 PI_DESIGN_MD_DIR（env 实时读）", () => {
    expect(designMdRootDir()).toBe(join(tmp, "design-md"));
  });
});

/* ------------------------------ 最近使用 kv ------------------------------ */

describe("最近使用 kv（pi.design_theme）", () => {
  test("set → 重启恢复；null 也是合法记忆值；损坏回落 null", async () => {
    await setLastUsedDesignTheme({ scope: "builtin", id: "acme" });
    resetDesignThemeStateForTest();
    await initDesignThemeState();
    expect(getLastUsedDesignTheme()).toEqual({ scope: "builtin", id: "acme" });

    await setLastUsedDesignTheme(null);
    resetDesignThemeStateForTest();
    await initDesignThemeState();
    expect(getLastUsedDesignTheme()).toBeNull();

    const { kvSet } = await import("../../src/storage/hostdb");
    await kvSet(DESIGN_THEME_KV_KEY, "{broken");
    resetDesignThemeStateForTest();
    await initDesignThemeState();
    expect(getLastUsedDesignTheme()).toBeNull();
  });
});

/* ------------------------------ use_design_theme 工具 ------------------------------ */

describe("use_design_theme 工具", () => {
  beforeAll(async () => {
    await installBundle(V1, DOCS_V1);
  });

  test("缺省目标 = 闭包读值；未选中回落最近使用；全无则报错列可用名", async () => {
    resetDesignThemeStateForTest();
    const none = buildUseDesignThemeTool(() => null);
    const err = (await none.execute("c1", {})) as {
      content: Array<{ type: "text"; text: string }>;
    };
    expect(err.content[0].text).toContain("没有选中设计主题");

    await setLastUsedDesignTheme({ scope: "builtin", id: "nova" });
    const hit = (await none.execute("c2", {})) as {
      content: Array<{ type: "text"; text: string }>;
    };
    expect(hit.content[0].text).toContain("已加载设计主题 \"Nova\"");

    const viaClosure = buildUseDesignThemeTool(() => ({ scope: "builtin", id: "acme" }));
    const byId = (await viaClosure.execute("c3", { name: "Acme" })) as {
      content: Array<{ type: "text"; text: string }>;
    };
    expect(byId.content[0].text).toContain("Primary: #ff6b35");

    const bad = (await viaClosure.execute("c4", { name: "Nope" })) as {
      content: Array<{ type: "text"; text: string }>;
    };
    expect(bad.content[0].text).toContain("没有名为 \"Nope\" 的设计主题");
    expect(bad.content[0].text).toContain("Acme");
    await setLastUsedDesignTheme(null);
  });

  test("name 命中用户主题（遮蔽内置）读到用户正文", async () => {
    const { ref } = await saveUserTheme({ name: "Nova", description: "我的 Nova", content: "user nova body" });
    await refreshThemes();
    const tool = buildUseDesignThemeTool(() => null);
    const out = (await tool.execute("c5", { name: "Nova" })) as {
      content: Array<{ type: "text"; text: string }>;
    };
    expect(out.content[0].text).toContain("我的主题");
    expect(out.content[0].text).toContain("user nova body");
    deleteUserTheme(ref.id);
    await refreshThemes();
  });

  test("重复加载短路：同台账同正文只回确认；正文变化或台账清空（压缩）重贴全文", async () => {
    const loads = new Map<string, string>();
    const tool = buildUseDesignThemeTool(() => ({ scope: "builtin", id: "acme" }), () => loads);
    type Out = { content: Array<{ type: "text"; text: string }>; details?: { deduped?: boolean } };
    const first = (await tool.execute("d1", {})) as Out;
    expect(first.content[0].text).toContain("Primary: #ff6b35");
    expect(loads.has("builtin/acme")).toBe(true);

    // 同 ref 同正文：短路确认，不再重贴全文
    const again = (await tool.execute("d2", {})) as Out;
    expect(again.content[0].text).toContain("重复加载已短路");
    expect(again.content[0].text).not.toContain("Primary: #ff6b35");
    expect(again.details?.deduped).toBe(true);

    // 管理页编辑正文：哈希失配自动重贴
    const { ref: userRef } = await saveUserTheme({ name: "Dedup T", description: "", content: "dedup v1" });
    await refreshThemes();
    const userTool = buildUseDesignThemeTool(() => ({ scope: "user", id: userRef.id }), () => loads);
    const u1 = (await userTool.execute("d3", {})) as Out;
    expect(u1.content[0].text).toContain("dedup v1");
    await saveUserTheme({ name: "Dedup T", description: "", content: "dedup v2" });
    await refreshThemes();
    const u2 = (await userTool.execute("d4", {})) as Out;
    expect(u2.content[0].text).toContain("dedup v2"); // 变了 → 全文重贴，不是短路

    // 压缩清台账（runCompaction 同款 clear）：即便正文没变也重贴全文
    loads.clear();
    const afterCompact = (await tool.execute("d5", {})) as Out;
    expect(afterCompact.content[0].text).toContain("Primary: #ff6b35");

    deleteUserTheme(userRef.id);
    await refreshThemes();
  });
});

/* ------------------------------ 提示词段主题句 ------------------------------ */

describe("design 提示词段主题句", () => {
  beforeAll(async () => {
    setUiDesignActiveProbeForTest(() => true);
    await applyAppMode("design");
    await installBundle(V1, DOCS_V1);
  });

  test("未选中主题不追加主题句；选中追加一行（渐进披露）", async () => {
    const plain = appModePromptBlock();
    expect(plain).toContain("You are operating in Design mode");
    expect(plain).not.toContain("Design theme selected");

    const withTheme = appModePromptBlock({ scope: "builtin", id: "acme" });
    expect(withTheme).toContain("Design theme selected for this session: \"Acme\"");
    expect(withTheme).toContain("use_design_theme");
    // 只多一行：行数差 1，其余行保留
    expect(withTheme.split("\n").length).toBe(plain.split("\n").length + 1);

    // 快照里不存在的 ref（主题被删）→ 不加句，不抛错
    expect(appModePromptBlock({ scope: "user", id: "ghost" })).toBe(plain);
  });

  test("work/code 档不受主题参数影响", async () => {
    await applyAppMode("code");
    expect(appModePromptBlock({ scope: "builtin", id: "acme" })).toBe("");
    await applyAppMode("work");
    expect(appModePromptBlock({ scope: "builtin", id: "acme" })).not.toContain("Design theme selected");
    await applyAppMode("design");
  });
});

/* ------------------------------ protocol handlers ------------------------------ */

describe("design-md handlers（fake run 注入驻留表）", () => {
  // send() 直写 process.stdout：捕获帧做断言
  let frames: Array<Record<string, unknown>> = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  function capture(on: boolean): void {
    if (on) {
      frames = [];
      process.stdout.write = ((line: string) => {
        frames.push(JSON.parse(line));
        return true;
      }) as typeof process.stdout.write;
    } else {
      process.stdout.write = realWrite;
    }
  }
  // handler 直调（绕过 protocol 分发环）：throw 即协议层的 error 帧，这里等价合成
  async function call(type: string, msg: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    capture(true);
    try {
      await handlers[type]("req-1", { type, id: "req-1", ...msg });
    } catch (err) {
      frames.push({ id: "req-1", type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      capture(false);
    }
    return frames.find((f) => f.id === "req-1");
  }

  function fakeRun(): Running {
    const run = {
      agent: { state: { model: null, systemPrompt: "seed" } },
      threadId: "t-handlers",
      sessionId: "sess-handlers",
      cwd: tmp,
      persistedCwd: tmp,
      mode: "agent",
      approvalLevel: "ask",
      planning: "inactive",
      designTheme: null,
      baseTools: [],
      subagentTools: [],
      pendingToolApprovals: new Map(),
      lastSeenAt: Date.now(),
    } as unknown as Running;
    return run;
  }

  let run: Running;
  beforeAll(async () => {
    await installBundle(V1, DOCS_V1);
    await applyAppMode("design"); // 主题句只在 design 档出现：handler 重排走真实 compose
    run = fakeRun();
    running.set(run.threadId, run);
  });
  afterAll(() => {
    running.delete("t-handlers");
    resetDesignThemeStateForTest();
  });

  test("list_design_themes 回清单；带 threadId 回 active（含 null）", async () => {
    const resp = await call("list_design_themes", { threadId: run.threadId });
    expect(resp?.type).toBe("design_themes");
    expect(resp?.userCount).toBe(0);
    expect(resp?.active).toBeNull();
  });

  test("set_design_theme 选中：改 run 字段 + 重排提示词 + 落偏好列与最近使用", async () => {
    const resp = await call("set_design_theme", { threadId: run.threadId, theme: { scope: "builtin", id: "acme" } });
    expect(resp?.type).toBe("design_theme_set");
    expect(resp?.theme).toEqual({ scope: "builtin", id: "acme" });
    expect(run.designTheme).toEqual({ scope: "builtin", id: "acme" });
    expect(String((run.agent.state as { systemPrompt?: string }).systemPrompt)).toContain("Design theme selected for this session");
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget 落库
    const row = await kvGet(DESIGN_THEME_KV_KEY);
    expect(JSON.parse(String(row?.value))).toEqual({ scope: "builtin", id: "acme" });

    // 清除：null → ""（显式不使用），提示词主题句消失
    const cleared = await call("set_design_theme", { threadId: run.threadId, theme: null });
    expect(cleared?.theme).toBeNull();
    expect(String((run.agent.state as { systemPrompt?: string }).systemPrompt)).not.toContain("Design theme selected");
    // 无 id 推送帧（多窗口/远程直更）：与应答同类型但无 id、带 threadId
    const push = frames.find((f) => f.type === "design_theme_set" && f.id === undefined);
    expect(push?.threadId).toBe(run.threadId);
    expect(push?.theme).toBeNull();

    // 不存在的主题：拒绝
    const bad = await call("set_design_theme", { threadId: run.threadId, theme: { scope: "user", id: "ghost" } });
    expect(bad?.type).toBe("error");
  });

  test("save/get/delete 用户主题全链 + 内置不可删 + 引用删除回落无主题", async () => {
    const saved = await call("save_design_theme", {
      definition: { name: "Handler Theme", description: "h", content: "handler body", accents: ["#123456"] },
    });
    expect(saved?.type).toBe("design_theme_saved");
    expect(saved?.ref).toEqual({ scope: "user", id: "Handler-Theme" });

    const doc = await call("get_design_theme", { ref: { scope: "user", id: "Handler-Theme" } });
    expect(doc?.type).toBe("design_theme_doc");
    expect(String(doc?.doc)).toContain("handler body");
    expect(String(doc?.doc)).toContain("name: Handler Theme"); // 磁盘原文含 frontmatter

    const builtinDoc = await call("get_design_theme", { ref: { scope: "builtin", id: "acme" } });
    expect(String(builtinDoc?.doc)).toContain("Primary: #ff6b35");

    // 会话引用它，再删：run 回落 null
    await call("set_design_theme", { threadId: run.threadId, theme: { scope: "user", id: "Handler-Theme" } });
    const del = await call("delete_design_theme", { scope: "user", themeId: "Handler-Theme" });
    expect(del?.type).toBe("design_themes");
    expect(run.designTheme).toBeNull();
    expect(readdirSync(userThemesDir()).filter((n) => n === "Handler-Theme.md").length).toBe(0);
    // 删除的推送面：新清单（无 id design_themes）+ 波及驻留线程逐条 set→null
    expect(frames.filter((f) => f.type === "design_themes" && f.id === undefined).length).toBe(1);
    const delPush = frames.find((f) => f.type === "design_theme_set" && f.id === undefined);
    expect(delPush?.threadId).toBe(run.threadId);
    expect(delPush?.theme).toBeNull();

    const delBuiltin = await call("delete_design_theme", { scope: "builtin", themeId: "acme" });
    expect(delBuiltin?.type).toBe("error");
    // 清理残留最近使用（set 已落 kv）
    await call("set_design_theme", { threadId: run.threadId, theme: null });
  });

  test("save 改名（themeId 传旧 id）：驻留 run 与最近使用不断链", async () => {
    const saved = await call("save_design_theme", {
      scope: "user",
      definition: { name: "Remap Src", description: "", content: "body", accents: [] },
    });
    expect(saved?.ref).toEqual({ scope: "user", id: "Remap-Src" });
    await call("set_design_theme", { threadId: run.threadId, theme: { scope: "user", id: "Remap-Src" } });
    expect(getLastUsedDesignTheme()).toEqual({ scope: "user", id: "Remap-Src" });

    const renamed = await call("save_design_theme", {
      scope: "user",
      themeId: "Remap-Src",
      definition: { name: "Remap Dst", description: "", content: "body2", accents: [] },
    });
    expect(renamed?.ref).toEqual({ scope: "user", id: "Remap-Dst" });
    expect(run.designTheme).toEqual({ scope: "user", id: "Remap-Dst" }); // 会话仍用着这套主题
    expect(getLastUsedDesignTheme()).toEqual({ scope: "user", id: "Remap-Dst" });
    expect(readdirSync(userThemesDir()).filter((n) => n === "Remap-Src.md").length).toBe(0); // 旧文件已清
    // 改名推送：新清单 + 波及驻留线程逐条 set 指向新 ref（胶囊不断链）
    expect(frames.filter((f) => f.type === "design_themes" && f.id === undefined).length).toBe(1);
    const renamePush = frames.find((f) => f.type === "design_theme_set" && f.id === undefined);
    expect(renamePush?.threadId).toBe(run.threadId);
    expect(renamePush?.theme).toEqual({ scope: "user", id: "Remap-Dst" });

    await call("delete_design_theme", { scope: "user", themeId: "Remap-Dst" });
    expect(run.designTheme).toBeNull();
    await call("set_design_theme", { threadId: run.threadId, theme: null });
  });

  test("save 同名撞车清扫（大小写变体）：被合并旧 id 的引用跟扫到新 id，不断链", async () => {
    const first = await call("save_design_theme", {
      scope: "user",
      definition: { name: "Clog A", description: "", content: "body", accents: [] },
    });
    expect(first?.ref).toEqual({ scope: "user", id: "Clog-A" });
    await call("set_design_theme", { threadId: run.threadId, theme: { scope: "user", id: "Clog-A" } });
    expect(getLastUsedDesignTheme()).toEqual({ scope: "user", id: "Clog-A" });

    // 新建「同名大小写变体」：归一名扫描合并 Clog-A（大小写不敏感盘上本是同一
    // 文件，先删后写、文件名落到 clog-a）；被清扫旧 id 的引用必须跟到新 id——
    // 否则 list 已无 Clog-A 而会话仍指向它（读盘大小写兜底读到新主题，错用）
    const second = await call("save_design_theme", {
      scope: "user",
      definition: { name: "clog a", description: "", content: "body2", accents: [] },
    });
    expect(second?.ref).toEqual({ scope: "user", id: "clog-a" });
    expect(run.designTheme).toEqual({ scope: "user", id: "clog-a" });
    expect(getLastUsedDesignTheme()).toEqual({ scope: "user", id: "clog-a" });
    const clogPush = frames.find((f) => f.type === "design_theme_set" && f.id === undefined);
    expect(clogPush?.threadId).toBe(run.threadId);
    expect(clogPush?.theme).toEqual({ scope: "user", id: "clog-a" });

    await call("delete_design_theme", { scope: "user", themeId: "clog-a" });
    expect(run.designTheme).toBeNull();
    await call("set_design_theme", { threadId: run.threadId, theme: null });
  });
});

/* ---------------------------- 引用完整性（修复：悬空引用） ---------------------------- */

describe("ref-integrity：改名重映射 / 删除收口 / 升级剪旧", () => {
  /** remap 只动 designTheme 字段，最小假 run 即可 */
  function stubRun(designTheme: unknown): Running {
    return { threadId: "t-ref", sessionId: "s-ref", designTheme } as unknown as Running;
  }

  afterAll(async () => {
    await setLastUsedDesignTheme(null);
    resetDesignThemeStateForTest();
  });

  test("重映射覆盖三个引用面：会话偏好列（含未驻留行）、驻留 run、最近使用 kv", async () => {
    await sessionInsert("s-ghost", tmp);
    await sessionPrefsSet("s-ghost", { designTheme: encodeThemeColumn({ scope: "builtin", id: "nova" }) });
    const run = stubRun({ scope: "builtin", id: "nova" });
    running.set("t-ref", run);
    await setLastUsedDesignTheme({ scope: "builtin", id: "nova" });

    // 改名语义：nova → 用户层 Nova-2，一切引用连续
    const changed = await remapThemeRefs({ scope: "builtin", id: "nova" }, { scope: "user", id: "Nova-2" });
    // 返回值 = 波及的驻留线程（handler 据此推 design_theme_set 给多窗口/远程）
    expect(changed).toEqual([
      { threadId: "t-ref", sessionId: "s-ref", theme: { scope: "user", id: "Nova-2" } },
    ]);
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget 落库
    const row = await sessionGet("s-ghost");
    expect(decodeThemeColumn(row?.designTheme ?? null)).toEqual({ scope: "user", id: "Nova-2" });
    expect(run.designTheme).toEqual({ scope: "user", id: "Nova-2" });
    expect(getLastUsedDesignTheme()).toEqual({ scope: "user", id: "Nova-2" });

    // 收口语义：显式不使用（""），不静默回落别的主题
    await remapThemeRefs({ scope: "user", id: "Nova-2" }, null);
    await new Promise((r) => setTimeout(r, 10));
    expect((await sessionGet("s-ghost"))?.designTheme).toBe("");
    expect(run.designTheme).toBeNull();
    expect(getLastUsedDesignTheme()).toBeNull();
    running.delete("t-ref");
  });

  test("无关引用不动（按 {scope,id} 精确匹配，非全表覆写）", async () => {
    await sessionInsert("s-keep", tmp);
    await sessionPrefsSet("s-keep", { designTheme: encodeThemeColumn({ scope: "builtin", id: "acme" }) });
    await setLastUsedDesignTheme({ scope: "builtin", id: "acme" });
    await remapThemeRefs({ scope: "user", id: "Not-There" }, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(decodeThemeColumn((await sessionGet("s-keep"))?.designTheme ?? null)).toEqual({
      scope: "builtin",
      id: "acme",
    });
    expect(getLastUsedDesignTheme()).toEqual({ scope: "builtin", id: "acme" });
    await setLastUsedDesignTheme(null);
  });

  test("clearRemovedBuiltinThemes：升级剪掉的内置 slug 逐个收口", async () => {
    await sessionInsert("s-removed", tmp);
    await sessionPrefsSet("s-removed", { designTheme: encodeThemeColumn({ scope: "builtin", id: "bravo" }) });
    const run = stubRun({ scope: "builtin", id: "bravo" });
    running.set("t-ref", run);
    await clearRemovedBuiltinThemes(["acme", "bravo"]); // acme 无引用：no-op
    await new Promise((r) => setTimeout(r, 10));
    expect((await sessionGet("s-removed"))?.designTheme).toBe("");
    expect(run.designTheme).toBeNull();
    running.delete("t-ref");
  });
});
