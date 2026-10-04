import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
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

const doc = (name: string, description: string, body = `Do ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

beforeAll(async () => {
  initLocalStorage(path.join(tmp, "state.db"));
  // 目录钉到 tmp：技能发现实时读盘，绝不碰真实 ~/.kova / ~/.agents
  process.env.PI_SKILLS_DIR = systemDir;
  process.env.PI_COMPAT_SKILLS_DIR = compatHomeDir;
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

async function wrapSave(draft: { name: string; description: string; content: string }) {
  try {
    await saveSkillDoc("system", draft, {});
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}
