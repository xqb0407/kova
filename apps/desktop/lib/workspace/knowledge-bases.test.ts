import { describe, expect, it } from "bun:test";
import {
  displayNameFor,
  kbParentDir,
  parseManifest,
  pickNoteTarget,
  sanitizeKbName,
  uniqueFolderName,
  type KnowledgeBase,
} from "./knowledge-bases";

const kb = (over: Partial<KnowledgeBase> & { folder: string }): KnowledgeBase => ({
  id: over.id ?? "kb-1",
  name: over.name ?? "工程手册",
  folder: over.folder,
  scope: over.scope ?? "user",
  workspaceDir: over.workspaceDir,
  workspaceIds: over.workspaceIds ?? [],
  default: over.default,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("parseManifest", () => {
  it("缺失/损坏回退空清单", () => {
    expect(parseManifest(null).kbs).toEqual([]);
    expect(parseManifest("").kbs).toEqual([]);
    expect(parseManifest("{oops").kbs).toEqual([]);
    expect(parseManifest('{"kbs": "nope"}').kbs).toEqual([]);
  });

  it("缺字段条目归一化：workspaceIds 兜底为空数组", () => {
    const raw = JSON.stringify({
      version: 1,
      kbs: [{ id: "a", name: "A", folder: "知识库/A", scope: "user" }],
    });
    const kb = parseManifest(raw).kbs[0]!;
    expect(kb.workspaceIds).toEqual([]);
    expect(kb.default).toBeUndefined();
    expect(typeof kb.createdAt).toBe("string");
  });

  it("非法条目逐条丢弃，合法条目保留", () => {
    const raw = JSON.stringify({
      version: 1,
      kbs: [
        { id: "a", name: "A", folder: "知识库/A", scope: "user" },
        { id: "b", name: "B", folder: "", scope: "user" },
        { id: "c", name: "C", folder: "项目/x/C", scope: "alien" },
        null,
      ],
    });
    const kbs = parseManifest(raw).kbs;
    expect(kbs).toHaveLength(1);
    expect(kbs[0]?.id).toBe("a");
  });
});

describe("sanitizeKbName / uniqueFolderName", () => {
  it("非法字符替换、空白折叠", () => {
    expect(sanitizeKbName(" a:b*c? ")).toBe("a-b-c-");
    expect(sanitizeKbName("工程  手册")).toBe("工程 手册");
  });

  it("大小写不敏感去重（Windows 文件系统）", () => {
    expect(uniqueFolderName(["docs"], "Docs")).toBe("Docs 2");
    // 输入已带尾号：剥掉续号（docs 2 撞 DOCS 2 → docs 3），不产生嵌套序号
    expect(uniqueFolderName(["DOCS 2"], "docs 2")).toBe("docs 3");
    expect(uniqueFolderName(["Docs"], "manuals")).toBe("manuals");
  });

  it("开头的点被去掉（点目录会被扫描当隐藏项跳过）", () => {
    expect(sanitizeKbName(".hidden")).toBe("hidden");
    expect(sanitizeKbName("...草稿")).toBe("草稿");
    expect(sanitizeKbName(".")).not.toBe(".");
  });

  it("同级重名加序号", () => {
    expect(uniqueFolderName(["工程手册"], "工程手册")).toBe("工程手册 2");
    expect(uniqueFolderName(["工程手册", "工程手册 2"], "工程手册")).toBe(
      "工程手册 3",
    );
    expect(uniqueFolderName([], "工程手册")).toBe("工程手册");
  });
});

describe("displayNameFor", () => {
  it("目录没重名时展示名不变", () => {
    expect(displayNameFor("工程手册", "工程手册", "工程手册")).toBe("工程手册");
  });

  it("目录加序号后展示名加同一序号（避免两个同名卡片）", () => {
    expect(displayNameFor("工程手册", "工程手册", "工程手册 2")).toBe(
      "工程手册 2",
    );
    expect(displayNameFor("A:B", "A-B", "A-B 3")).toBe("A:B 3");
  });
});

describe("kbParentDir", () => {
  it("用户级落知识库根，工作区级落项目目录", () => {
    expect(kbParentDir({ scope: "user" })).toBe("知识库");
    expect(kbParentDir({ scope: "workspace", workspaceDir: "demo" })).toBe(
      "项目/demo",
    );
    // 没有 workspaceDir 的工作区级兜底回用户级（不该发生，但不至于写坏盘）
    expect(kbParentDir({ scope: "workspace" })).toBe("知识库");
  });
});

describe("pickNoteTarget", () => {
  const kbs: KnowledgeBase[] = [
    kb({ folder: "知识库/工程手册", scope: "user" }),
    kb({
      id: "kb-2",
      folder: "项目/demo/默认知识库",
      scope: "workspace",
      workspaceDir: "demo",
      default: true,
    }),
    kb({
      id: "kb-3",
      folder: "项目/demo/API 设计",
      scope: "workspace",
      workspaceDir: "demo",
    }),
  ];

  it("工作区会话命中默认知识库", () => {
    expect(pickNoteTarget(kbs, "demo")).toEqual({
      folder: "项目/demo/默认知识库",
      kbId: "kb-2",
      missing: null,
    });
  });

  it("非默认的普通 KB 不参与划词落点", () => {
    expect(pickNoteTarget(kbs, "other").missing).toBe("workspace-default");
  });

  it("无工作区（任务会话）回用户级默认（收件箱）", () => {
    expect(pickNoteTarget([], null).missing).toBe("user-inbox");
    const withInbox = [
      ...kbs,
      kb({ id: "kb-4", folder: "知识库/收件箱", scope: "user", default: true }),
    ];
    expect(pickNoteTarget(withInbox, null)).toEqual({
      folder: "知识库/收件箱",
      kbId: "kb-4",
      missing: null,
    });
  });
});
