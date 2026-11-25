import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COMPAT_MANAGED_MARKER,
  compatHomeSkillsDir,
  compatWorkspaceSkillsDir,
  deleteSkillDoc,
  ensureSkillsLoaded,
  parseSkillDoc,
  renderSkillDoc,
  resetSkillsForTest,
  saveSkillDoc,
  setSkillEnabled,
  setSkillsEnabled,
  skillsPromptBlock,
  budgetSkillsForPrompt,
  SKILL_DESCRIPTION_MAX_CHARS,
  skillsSnapshot,
  skillStateKey,
  systemSkillsDir,
  workspaceSkillsDir,
} from "../../src/skills/skills";
import { composeModeSystemPrompt } from "../../src/agent/modes";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-skills-"));
const systemDir = path.join(tmp, "system-skills");
const compatHomeDir = path.join(tmp, "compat-home-skills");
const ws = path.join(tmp, "ws");
const prevSkillsDir = process.env.PI_SKILLS_DIR;
const prevCompatDir = process.env.PI_COMPAT_SKILLS_DIR;
const prevPluginsDir = process.env.PI_PLUGINS_DIR;

const doc = (name: string, description: string, body = `Do ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

beforeAll(async () => {
  initLocalStorage(path.join(tmp, "state.db"));
  // 目录钉到 tmp：技能发现实时读盘，绝不碰真实 ~/.kova / ~/.agents
  process.env.PI_SKILLS_DIR = systemDir;
  process.env.PI_COMPAT_SKILLS_DIR = compatHomeDir;
  // 插件层同样钉到 tmp：本机真实 ~/.kova/plugins/ 里可能装着任意插件
  // （自带技能），不清干净"生效技能目录"类断言会多出一堆
  process.env.PI_PLUGINS_DIR = path.join(tmp, "plugins");
  mkdirSync(systemDir, { recursive: true });
  mkdirSync(compatHomeDir, { recursive: true });
  // 系统：代码评审
  writeFileSync(path.join(systemDir, "code-review.md"), doc("code-review", "Review diffs before merge."));
  // 生态·用户：标准 <dir>/SKILL.md 布局（name 缺省回退目录名）
  mkdirSync(path.join(compatHomeDir, "pdf-export"), { recursive: true });
  writeFileSync(
    path.join(compatHomeDir, "pdf-export", "SKILL.md"),
    "---\ndescription: Export documents to PDF.\n---\n\nUse pandoc.\n",
  );
  // 生态·用户：根级 .md（frontmatter name 优先）
  writeFileSync(
    path.join(compatHomeDir, "commit-msg.md"),
    doc("commit-msg", "Write conventional commit messages."),
  );
  // 工作区：同名 code-review 遮蔽系统层
  mkdirSync(workspaceSkillsDir(ws), { recursive: true });
  writeFileSync(
    path.join(workspaceSkillsDir(ws), "code-review.md"),
    doc("code-review", "Workspace-specific review rules."),
  );
  // 工作区生态：deploy
  mkdirSync(compatWorkspaceSkillsDir(ws), { recursive: true });
  writeFileSync(
    path.join(compatWorkspaceSkillsDir(ws), "deploy.md"),
    doc("deploy", "Ship the release."),
  );
});

afterAll(async () => {
  // bun test 单进程共享模块注册表：清内存态/env/transport，避免污染后续文件
  resetSkillsForTest();
  resetStorageForTest();
  if (prevSkillsDir === undefined) delete process.env.PI_SKILLS_DIR;
  else process.env.PI_SKILLS_DIR = prevSkillsDir;
  if (prevCompatDir === undefined) delete process.env.PI_COMPAT_SKILLS_DIR;
  else process.env.PI_COMPAT_SKILLS_DIR = prevCompatDir;
  if (prevPluginsDir === undefined) delete process.env.PI_PLUGINS_DIR;
  else process.env.PI_PLUGINS_DIR = prevPluginsDir;
});

describe("parseSkillDoc / renderSkillDoc", () => {
  test("frontmatter 解析与渲染往返稳定，正文保留", () => {
    const raw = renderSkillDoc({
      name: "Review",
      description: "Check the patch",
      content: "# Review\n\nStep 1.",
    });
    const parsed = parseSkillDoc(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.name).toBe("Review");
      expect(parsed.draft.description).toBe("Check the patch");
      expect(parsed.draft.content).toBe("# Review\n\nStep 1.");
    }
  });

  test("多行描述经 yaml 块标量往返不丢行", () => {
    const parsed = parseSkillDoc(
      "---\nname: notes\ndescription: >\n  Line one.\n  Line two.\n---\n\nbody\n",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.draft.description).toContain("Line one.");
  });

  test("缺 name 走 fallbackName；缺 description / 空正文报错", () => {
    const noName = parseSkillDoc("---\ndescription: d\n---\n\nbody\n", {
      fallbackName: "pdf-export",
    });
    expect(noName.ok).toBe(true);
    if (noName.ok) expect(noName.draft.name).toBe("pdf-export");

    const noDesc = parseSkillDoc("---\nname: x\n---\n\nbody\n");
    expect(noDesc.ok).toBe(false);

    const emptyBody = parseSkillDoc("---\nname: x\ndescription: d\n---\n\n   \n");
    expect(emptyBody.ok).toBe(false);
  });
});

describe("发现与遮蔽", () => {
  test("四层合并：工作区遮蔽系统同名，生态层被识别，全部条目进清单", async () => {
    await ensureSkillsLoaded(ws);
    const snap = skillsSnapshot(ws);
    const byKey = new Map(snap.entries.map((e) => [`${e.scope}:${e.name}`, e]));

    const wsReview = byKey.get("workspace:code-review");
    const sysReview = byKey.get("system:code-review");
    expect(wsReview?.enabled).toBe(true);
    expect(wsReview?.shadowed).toBe(false);
    expect(wsReview?.editable).toBe(true);
    // 工作区胜出：生效目录里是工作区版
    expect(snap.activeSkills.find((s) => s.name === "code-review")?.description).toBe(
      "Workspace-specific review rules.",
    );
    // 系统版仍在清单，标记被遮蔽
    expect(sysReview?.shadowed).toBe(true);
    expect(sysReview?.editable).toBe(true);

    // 生态层：目录布局（SKILL.md 目录名兜底）与根级 .md 都识别，只读
    const pdfExport = byKey.get("compat:pdf-export");
    expect(pdfExport?.editable).toBe(false);
    expect(pdfExport?.shadowed).toBe(false);
    expect(pdfExport?.content).toContain("pandoc");
    const commitMsg = byKey.get("compat:commit-msg");
    expect(commitMsg?.editable).toBe(false);
    const deploy = byKey.get("compat-workspace:deploy");
    expect(deploy?.shadowed).toBe(false);
  });

  test("未预热（无 cwd）时工作区/生态·工作区层不出现", async () => {
    await ensureSkillsLoaded(ws);
    const snap = skillsSnapshot(undefined);
    expect(snap.entries.some((e) => e.scope === "workspace")).toBe(false);
    expect(snap.entries.some((e) => e.scope === "compat")).toBe(true);
  });

  test("大技能包不饿死后置目录：新装/修改的技能仍触发重载", async () => {
    const root = mkdtempSync(path.join(tmp, "sig-root-"));
    const big = path.join(root, "aaa-big");
    const late = path.join(root, "zzz-late");
    mkdirSync(big, { recursive: true });
    // 模拟真实技能包里的大量资产：旧签名深度优先 + 512 条封顶，会被这个大
    // 子树吃满预算，后面 zzz-late 的增删改永远进不了签名。
    for (let i = 0; i < 600; i += 1) {
      writeFileSync(path.join(big, `asset-${i}.txt`), "x");
    }
    mkdirSync(late, { recursive: true });
    writeFileSync(path.join(late, "SKILL.md"), doc("zzz-late", "Old description."));

    const prevSystem = process.env.PI_SKILLS_DIR;
    process.env.PI_SKILLS_DIR = root;
    try {
      resetSkillsForTest();
      await ensureSkillsLoaded();
      expect(
        skillsSnapshot().entries.find((e) => e.name === "zzz-late")?.description,
      ).toBe("Old description.");

      // 改后置技能的 frontmatter（长度也变，避免同毫秒 mtime 让断言抖动）
      writeFileSync(
        path.join(late, "SKILL.md"),
        doc("zzz-late", "New description with extra words."),
      );
      await ensureSkillsLoaded();
      expect(
        skillsSnapshot().entries.find((e) => e.name === "zzz-late")?.description,
      ).toBe("New description with extra words.");
    } finally {
      process.env.PI_SKILLS_DIR = prevSystem;
      resetSkillsForTest();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("frontmatter 带 OpenCode 字段仍能发现（未知键忽略而非拒绝）", async () => {
    const root = mkdtempSync(path.join(tmp, "opencode-root-"));
    const dir = path.join(root, "opencode-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      [
        "---",
        "name: opencode-skill",
        'description: "OpenCode-style skill."',
        'argument-hint: "<prompt> | redesign <path>"',
        "version: 2.0.0",
        "metadata:",
        '  opencode/slash: "true"',
        "---",
        "",
        "# Body",
        "",
      ].join("\n"),
    );
    const prevSystem = process.env.PI_SKILLS_DIR;
    process.env.PI_SKILLS_DIR = root;
    try {
      resetSkillsForTest();
      await ensureSkillsLoaded();
      const entry = skillsSnapshot().entries.find((e) => e.name === "opencode-skill");
      expect(entry?.description).toBe("OpenCode-style skill.");
      expect(entry?.path).toBe(path.join(dir, "SKILL.md"));
    } finally {
      process.env.PI_SKILLS_DIR = prevSystem;
      resetSkillsForTest();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("开关控制", () => {
  test("禁用工作区技能：生效目录消失、系统同名仍被遮蔽（禁用即遮蔽语义）", async () => {
    await ensureSkillsLoaded(ws);
    await setSkillEnabled("workspace", "code-review", false, ws);
    let snap = skillsSnapshot(ws);
    expect(snap.activeSkills.some((s) => s.name === "code-review")).toBe(false);
    const sysReview = snap.entries.find((e) => e.scope === "system" && e.name === "code-review");
    expect(sysReview?.enabled).toBe(true);
    expect(sysReview?.shadowed).toBe(true); // 不因上层禁用而"露回"

    await setSkillEnabled("workspace", "code-review", true, ws);
    snap = skillsSnapshot(ws);
    expect(snap.activeSkills.some((s) => s.name === "code-review")).toBe(true);
  });

  test("禁用生态技能：不写文件、纯 kv 状态", async () => {
    await ensureSkillsLoaded(ws);
    await setSkillEnabled("compat", "commit-msg", false);
    const snap = skillsSnapshot(ws);
    expect(snap.activeSkills.some((s) => s.name === "commit-msg")).toBe(false);
    const entry = snap.entries.find((e) => e.name === "commit-msg");
    expect(entry?.enabled).toBe(false);
    // 文件原样还在
    expect(readFileSync(path.join(compatHomeSkillsDir(), "commit-msg.md"), "utf8")).toContain("commit");
  });

  test("状态键按 cwd 隔离：另一工作区不受影响", async () => {
    await ensureSkillsLoaded(ws);
    await setSkillEnabled("compat-workspace", "deploy", false, ws);
    expect(skillStateKey("compat-workspace", "deploy", ws)).not.toBe(
      skillStateKey("compat-workspace", "deploy", "/other"),
    );
  });

  test("批量开关：全部关闭清空生效目录，全部启用还原", async () => {
    await ensureSkillsLoaded(ws);
    const targets = skillsSnapshot(ws).entries.map((e) => ({ scope: e.scope, name: e.name }));
    expect(targets.length).toBeGreaterThan(0);

    await setSkillsEnabled(targets, false, ws);
    let snap = skillsSnapshot(ws);
    expect(snap.entries.every((e) => !e.enabled)).toBe(true);
    expect(snap.activeSkills.length).toBe(0);

    await setSkillsEnabled(targets, true, ws);
    snap = skillsSnapshot(ws);
    expect(snap.entries.every((e) => e.enabled)).toBe(true);
    expect(snap.activeSkills.length).toBeGreaterThan(0);
  });
});

describe("提示词注入", () => {
  test("生效技能进目录（name/description/location），禁用与被遮蔽的不出现", async () => {
    await ensureSkillsLoaded(ws);
    const block = skillsPromptBlock(ws);
    expect(block).toContain("<available_skills>");
    expect(block).toContain("Workspace-specific review rules.");
    expect(block).toContain("Export documents to PDF.");
    expect(block).not.toContain("Review diffs before merge."); // 被遮蔽的系统版
    // location 指向磁盘文件，模型按需 read
    expect(block).toContain(path.join(workspaceSkillsDir(ws), "code-review.md"));
  });

  test("无技能时块为空串，系统提示词与旧行为字节级一致", async () => {
    // 全局两层也指到空目录：skillsPromptBlock 覆盖全局+工作区，只有全空才为空串
    const emptyRoot = path.join(tmp, "empty-world");
    const emptyCompat = path.join(tmp, "empty-compat");
    const emptyWs = path.join(tmp, "empty-ws");
    mkdirSync(emptyRoot, { recursive: true });
    mkdirSync(emptyCompat, { recursive: true });
    const prevSkills = process.env.PI_SKILLS_DIR;
    const prevCompat = process.env.PI_COMPAT_SKILLS_DIR;
    process.env.PI_SKILLS_DIR = emptyRoot;
    process.env.PI_COMPAT_SKILLS_DIR = emptyCompat;
    try {
      await ensureSkillsLoaded(emptyWs);
      expect(skillsPromptBlock(emptyWs)).toBe("");
      const withBlock = composeModeSystemPrompt("agent", emptyWs, "code", null);
      expect(withBlock).not.toContain("available_skills");
      // 且组装是纯函数：同一输入字节级一致
      expect(withBlock).toBe(composeModeSystemPrompt("agent", emptyWs, "code", null));
    } finally {
      if (prevSkills === undefined) delete process.env.PI_SKILLS_DIR;
      else process.env.PI_SKILLS_DIR = prevSkills;
      if (prevCompat === undefined) delete process.env.PI_COMPAT_SKILLS_DIR;
      else process.env.PI_COMPAT_SKILLS_DIR = prevCompat;
      // 目录签名随 env 变化，下个用例 ensureSkillsLoaded 自然重扫
    }
  });
});

describe("CRUD", () => {
  test("save → 覆盖同名；改名清旧文件；delete 清文件并复位开关", async () => {
    await saveSkillDoc(
      "system",
      { name: "takedown", description: "Run the takedown checklist.", content: "Step 1." },
      {},
    );
    const savedPath = path.join(systemSkillsDir(), "takedown.md");
    expect(readFileSync(savedPath, "utf8")).toContain("Run the takedown checklist.");

    // 同名不同文件名 slug：按解析出的 name 覆盖
    await saveSkillDoc(
      "system",
      { name: "takedown", description: "Updated checklist.", content: "Step 2." },
      {},
    );
    expect(readFileSync(savedPath, "utf8")).toContain("Updated checklist.");

    // 改名：旧名文件被清
    await saveSkillDoc(
      "system",
      { name: "rollback", description: "Rollback steps.", content: "Do rollback." },
      { replaceName: "takedown" },
    );
    expect(readFileSync(path.join(systemSkillsDir(), "rollback.md"), "utf8")).toContain("rollback");

    await deleteSkillDoc("system", "rollback", {});
    let threw = false;
    try {
      await deleteSkillDoc("system", "rollback", {});
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // 已删，再删报"未找到"
  });

  test("校验拒绝：空描述 / 空正文 / 超限文档", async () => {
    expect((await wrapSave({ name: "x", description: "", content: "b" })).length).toBeGreaterThan(0);
    expect((await wrapSave({ name: "x", description: "d", content: "  " })).length).toBeGreaterThan(0);
    expect(
      (await wrapSave({ name: "x", description: "d", content: "a".repeat(200 * 1024) })).length,
    ).toBeGreaterThan(0);
  });

  test("工作区保存走 cwd；签名缓存失效后清单立即反映", async () => {
    await saveSkillDoc(
      "workspace",
      { name: "ws-only", description: "Workspace skill.", content: "Do it." },
      { cwd: ws },
    );
    await ensureSkillsLoaded(ws); // 保存后签名变化 → 重新扫描
    const snap = skillsSnapshot(ws);
    const entry = snap.entries.find((e) => e.name === "ws-only");
    expect(entry?.scope).toBe("workspace");
    expect(snap.activeSkills.some((s) => s.name === "ws-only")).toBe(true);
  });
});

describe("多文件（目录式）技能", () => {
  test("带 files 保存 → <slug>/SKILL.md + 附属文件，清单可发现", async () => {
    await saveSkillDoc(
      "system",
      { name: "bundle-skill", description: "Bundled skill.", content: "Run scripts/recalc.py." },
      {
        files: [
          { path: "scripts/recalc.py", content: "print('recalc')\n" },
          { path: "data.tsv", content: "a\tb\n" },
        ],
      },
    );
    const skillDir = path.join(systemSkillsDir(), "bundle-skill");
    expect(readFileSync(path.join(skillDir, "SKILL.md"), "utf8")).toContain("Bundled skill.");
    expect(readFileSync(path.join(skillDir, "scripts", "recalc.py"), "utf8")).toContain("recalc");
    expect(readFileSync(path.join(skillDir, "data.tsv"), "utf8")).toContain("a\tb");
    await ensureSkillsLoaded();
    const entry = skillsSnapshot().entries.find((e) => e.name === "bundle-skill");
    expect(entry?.path).toBe(path.join(skillDir, "SKILL.md"));
  });

  test("整目录替换：旧附属文件不残留；平铺与目录两形态同名互替", async () => {
    // 先写目录式，再不带 files 覆盖同名 → 目录清掉、回落平铺
    await saveSkillDoc(
      "system",
      { name: "bundle-skill", description: "Bundled skill.", content: "Run scripts/recalc.py." },
      { files: [{ path: "scripts/recalc.py", content: "old\n" }] },
    );
    await saveSkillDoc(
      "system",
      { name: "bundle-skill", description: "Now flat.", content: "Flat body." },
      {},
    );
    expect(existsSync(path.join(systemSkillsDir(), "bundle-skill"))).toBe(false);
    expect(readFileSync(path.join(systemSkillsDir(), "bundle-skill.md"), "utf8")).toContain(
      "Now flat.",
    );
    // 再带 files 覆盖同名 → 平铺文件清掉、目录重建且旧文件不残留
    await saveSkillDoc(
      "system",
      { name: "bundle-skill", description: "Bundled again.", content: "Use data/new.tsv." },
      { files: [{ path: "data/new.tsv", content: "x\n" }] },
    );
    expect(existsSync(path.join(systemSkillsDir(), "bundle-skill.md"))).toBe(false);
    expect(existsSync(path.join(systemSkillsDir(), "bundle-skill", "data", "new.tsv"))).toBe(true);
  });

  test("deleteSkillDoc 删除目录式技能", async () => {
    expect(existsSync(path.join(systemSkillsDir(), "bundle-skill"))).toBe(true);
    await deleteSkillDoc("system", "bundle-skill", {});
    expect(existsSync(path.join(systemSkillsDir(), "bundle-skill"))).toBe(false);
  });

  test("生态用户目录：始终 <name>/SKILL.md 落盘，可发现、可删除", async () => {
    // 无附属文件也按目录式写（agentskills.io 形态，其他工具可直接识别）
    await saveSkillDoc(
      "compat",
      { name: "eco-flat", description: "Ecosystem flat skill.", content: "Hi." },
      {},
    );
    const flatDir = path.join(compatHomeSkillsDir(), "eco-flat");
    expect(readFileSync(path.join(flatDir, "SKILL.md"), "utf8")).toContain(
      "Ecosystem flat skill.",
    );
    expect(existsSync(path.join(compatHomeSkillsDir(), "eco-flat.md"))).toBe(false);

    // 带附属文件
    await saveSkillDoc(
      "compat",
      { name: "eco-bundle", description: "Ecosystem bundle.", content: "Run run.sh." },
      { files: [{ path: "run.sh", content: "echo hi\n" }] },
    );
    const bundleDir = path.join(compatHomeSkillsDir(), "eco-bundle");
    expect(readFileSync(path.join(bundleDir, "run.sh"), "utf8")).toContain("echo hi");

    // 托管标记：市场装的生态技能可在设置页删除（编辑仍关闭）
    expect(existsSync(path.join(flatDir, COMPAT_MANAGED_MARKER))).toBe(true);

    await ensureSkillsLoaded();
    const snap = skillsSnapshot();
    const flatEntry = snap.entries.find((e) => e.name === "eco-flat");
    expect(flatEntry?.scope).toBe("compat");
    expect(flatEntry?.managed).toBe(true);
    expect(snap.entries.find((e) => e.name === "eco-bundle")?.managed).toBe(true);
    // 外部工具装的技能没有托管标记
    expect(snap.entries.find((e) => e.name === "pdf-export")?.managed).toBeUndefined();
    expect(snap.activeSkills.some((s) => s.name === "eco-bundle")).toBe(true);

    await deleteSkillDoc("compat", "eco-flat", {});
    expect(existsSync(flatDir)).toBe(false);
  });

  test("生态用户目录：非规范技能名被拒绝", async () => {
    const before = readdirSync(compatHomeSkillsDir()).sort();
    let message = "";
    try {
      await saveSkillDoc(
        "compat",
        { name: "My Skill", description: "d", content: "b" },
        {},
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("生态目录");
    expect(readdirSync(compatHomeSkillsDir()).sort()).toEqual(before);
  });

  test("生态用户目录：嵌套分类目录的同名技能被精确覆盖", async () => {
    // 模拟其他工具按 @user 分层：@user_x/shadow-name/SKILL.md
    const nested = path.join(compatHomeSkillsDir(), "@user_x", "shadow-name");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "SKILL.md"), doc("shadow-name", "Old nested skill."));
    await saveSkillDoc(
      "compat",
      { name: "shadow-name", description: "New top-level skill.", content: "New body." },
      {},
    );
    // 顶层目录式写入，嵌套的旧同名目录被清掉
    expect(existsSync(path.join(compatHomeSkillsDir(), "shadow-name", "SKILL.md"))).toBe(true);
    expect(existsSync(nested)).toBe(false);
  });

  test("校验拒绝：路径逃逸 / 绝对路径 / SKILL.md 本位 / 超限", async () => {
    const base = { name: "unsafe", description: "d", content: "b" };
    expect(
      (await wrapSaveWithFiles(base, [{ path: "../escape.txt", content: "x" }])).length,
    ).toBeGreaterThan(0);
    expect(
      (await wrapSaveWithFiles(base, [{ path: "/abs.txt", content: "x" }])).length,
    ).toBeGreaterThan(0);
    expect(
      (await wrapSaveWithFiles(base, [{ path: "a\\b.txt", content: "x" }])).length,
    ).toBeGreaterThan(0);
    expect(
      (await wrapSaveWithFiles(base, [{ path: "SKILL.md", content: "x" }])).length,
    ).toBeGreaterThan(0);
    expect(
      (await wrapSaveWithFiles(base, [{ path: "big.bin", content: "x".repeat(300 * 1024) }]))
        .length,
    ).toBeGreaterThan(0);
    // 全部合法则通过
    expect(await wrapSaveWithFiles(base, [{ path: "ok.txt", content: "x" }])).toEqual([]);
  });

  test("目录被不同名技能占用：目录式报错不动原目录；平铺写入两者共存", async () => {
    // 手工搭一个「目录名 pdf、SKILL.md 名字 pdf-tools」的占用现场（saveSkillDoc
    // 的目录名永远跟名字走，搭不出这种错位，只能直写文件）
    const occupantDir = path.join(systemSkillsDir(), "pdf");
    mkdirSync(occupantDir, { recursive: true });
    writeFileSync(path.join(occupantDir, "SKILL.md"), doc("pdf-tools", "Existing occupant."));

    const errors = await wrapSaveWithFiles(
      { name: "pdf", description: "d", content: "b" },
      [{ path: "a.txt", content: "x" }],
    );
    expect(errors.join()).toContain("占用");
    expect(existsSync(path.join(occupantDir, "SKILL.md"))).toBe(true); // 原目录分毫未动

    // 平铺写入不冲突：pdf.md 与 pdf/（pdf-tools）共存
    await saveSkillDoc("system", { name: "pdf", description: "Flat pdf.", content: "b" }, {});
    expect(existsSync(path.join(systemSkillsDir(), "pdf.md"))).toBe(true);
    expect(existsSync(path.join(occupantDir, "SKILL.md"))).toBe(true);

    // 删除按名字精确匹配：删 "pdf" 只清平铺文件，不碰 pdf-tools 的目录
    await deleteSkillDoc("system", "pdf", {});
    expect(existsSync(path.join(systemSkillsDir(), "pdf.md"))).toBe(false);
    expect(existsSync(path.join(occupantDir, "SKILL.md"))).toBe(true);
    // 删 "pdf-tools" 才清掉目录
    await deleteSkillDoc("system", "pdf-tools", {});
    expect(existsSync(occupantDir)).toBe(false);
  });
});

async function wrapSaveWithFiles(
  draft: { name: string; description: string; content: string },
  files: Array<{ path: string; content: string }>,
) {
  try {
    await saveSkillDoc("system", draft, { files });
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

async function wrapSave(draft: { name: string; description: string; content: string }) {
  try {
    await saveSkillDoc("system", draft, {});
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

describe("会话外部目录的技能层", () => {
  const ext = path.join(tmp, "external");
  const externalSkill = (dir: string, name: string) => {
    mkdirSync(path.join(ext, dir, name), { recursive: true });
    writeFileSync(
      path.join(ext, dir, name, "SKILL.md"),
      doc(name, `External ${name} skill.`),
    );
  };

  beforeAll(() => {
    externalSkill(".agents/skills", "ext-only");
    // 与工作区 deploy 同名：工作区层优先，外部层被遮蔽
    externalSkill(".claude/skills", "deploy");
  });

  test("未传 externalDirs：外部技能不进快照（设置页/全局清单不受会话影响）", async () => {
    await ensureSkillsLoaded(ws, [ext]);
    const snap = skillsSnapshot(ws);
    expect(snap.entries.some((e) => e.name === "ext-only")).toBe(false);
  });

  test("传 externalDirs：外部技能进入快照与提示词目录段", async () => {
    await ensureSkillsLoaded(ws, [ext]);
    const snap = skillsSnapshot(ws, [ext]);
    const entry = snap.entries.find((e) => e.name === "ext-only");
    expect(entry?.scope).toBe("external");
    expect(entry?.editable).toBe(false);
    expect(snap.activeSkills.some((s) => s.name === "ext-only")).toBe(true);
    expect(skillsPromptBlock(ws, [ext])).toContain("ext-only");
  });

  test("遮蔽顺序：工作区 deploy 优先于外部目录 deploy", async () => {
    await ensureSkillsLoaded(ws, [ext]);
    const snap = skillsSnapshot(ws, [ext]);
    const deploy = snap.entries.filter((e) => e.name === "deploy");
    expect(deploy.length).toBeGreaterThanOrEqual(2);
    expect(deploy.find((e) => e.scope === "external")?.shadowed).toBe(true);
    expect(deploy.find((e) => e.scope === "compat-workspace")?.shadowed).toBe(false);
  });

  test("externalDirs=[]：外部层不并入快照（缓存可留热，但提示词段不出现）", async () => {
    await ensureSkillsLoaded(ws, []);
    expect(skillsSnapshot(ws, []).entries.some((e) => e.name === "ext-only")).toBe(false);
    expect(skillsPromptBlock(ws, [])).not.toContain("ext-only");
  });
});

describe("目录段预算", () => {
  const mk = (name: string, description = `desc ${name}`) => ({
    name,
    description,
    content: "",
    filePath: `/tmp/${name}/SKILL.md`,
  });

  test("description 超长按字符截断", () => {
    const { skills } = budgetSkillsForPrompt([mk("long", "x".repeat(400))]);
    expect(skills[0]!.description.length).toBe(SKILL_DESCRIPTION_MAX_CHARS + 1);
    expect(skills[0]!.description.endsWith("…")).toBe(true);
  });

  test("超预算从尾部丢弃并返回省略名单（顺序即优先级）", () => {
    const all = Array.from({ length: 60 }, (_, i) => mk(`skill-${i}`, "y".repeat(200)));
    const { skills, omitted } = budgetSkillsForPrompt(all, 2_000);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.length).toBeLessThan(all.length);
    expect(omitted).toEqual(all.slice(skills.length).map((s) => s.name));
    expect(skills[0]!.name).toBe("skill-0");
  });

  test("预算内不丢条目", () => {
    const all = [mk("a"), mk("b")];
    expect(budgetSkillsForPrompt(all, 12_000)).toEqual({
      skills: all,
      omitted: [],
    });
  });

  test("description 截断不切开代理对", () => {
    const description = `${"a".repeat(SKILL_DESCRIPTION_MAX_CHARS - 1)}😀tail`;
    const { skills } = budgetSkillsForPrompt([mk("emoji", description)]);
    const out = skills[0]!.description;
    expect(Array.from(out)).toHaveLength(SKILL_DESCRIPTION_MAX_CHARS + 1);
    expect(out.endsWith("😀…")).toBe(true);
    expect(out.includes("\uFFFD")).toBe(false);
  });

  test("省略名单不包含不可模型调用的技能", () => {
    const visible = Array.from({ length: 8 }, (_, i) => mk(`visible-${i}`, "y".repeat(300)));
    const hidden = { ...mk("hidden", "z".repeat(300)), disableModelInvocation: true };
    const { omitted } = budgetSkillsForPrompt([...visible, hidden], 2_000);
    expect(omitted.length).toBeGreaterThan(0);
    // 列出来等于给模型一个 use_skill 也打不开的假入口
    expect(omitted).not.toContain("hidden");
  });

  test("插件技能保留最低预算：普通技能再多也不会被全部挤掉", () => {
    const regular = Array.from({ length: 40 }, (_, i) => mk(`regular-${i}`, "y".repeat(200)));
    const plugins = Array.from({ length: 4 }, (_, i) => ({
      ...mk(`plugin-${i}`, "z".repeat(200)),
      qualifiedName: `pack:plugin-${i}`,
    }));
    const { skills, omitted } = budgetSkillsForPrompt([...regular, ...plugins], 3_000);
    expect(skills.filter((s) => s.qualifiedName)).toHaveLength(plugins.length);
    expect(omitted.some((name) => name.startsWith("pack:"))).toBe(false);
    expect(omitted.length).toBeGreaterThan(0);
    // 普通技能仍按优先级保留前缀
    expect(skills[0]!.name).toBe("regular-0");
  });
});
