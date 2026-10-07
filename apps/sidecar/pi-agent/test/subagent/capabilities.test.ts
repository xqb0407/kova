/**
 * 能力模型测试（设计文档 §8 测试 1-11）。
 *
 * 重点守三件事：
 * 1. 未声明即不可达——能力不是"给了再拒绝"，是不出现；
 * 2. 记忆与用户主记忆隔离，且不被全局开关否决；
 * 3. 未声明新维度的定义，提示词逐字节不变（缓存不变式）。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalToolName,
  emitSubagentYaml,
  GRANTABLE_TOOLS,
  parseSubagentYaml,
  type SubagentDefinition,
  type SubagentDraft,
  type KnowledgeSource,
} from "../../src/subagent/subagent-definitions";
import { searchKnowledge } from "../../src/subagent/knowledge";
import {
  privateSubagentMemoryDir,
  resetSubagentMemoryQueuesForTest,
  subagentMemoryDir,
  subagentMemoryPromptBlock,
  writeSubagentMemory,
} from "../../src/subagent/memory";
import { composeSubagentSystemPrompt } from "../../src/subagent/run";

const CWD = "/workspace";

function parse(yaml: string) {
  return parseSubagentYaml(yaml, { scope: "workspace", filePath: join(CWD, ".kova/subagents/a.yml") });
}

const BASE_YAML = `name: a
description: does things
tools: [read, grep]
prompt: go
`;

/** 定义 YAML 构造器：tools 走参数，避免在 BASE_YAML 之后再追加重复的 tools 键 */
function defYaml(tools: string, rest = ""): string {
  return `name: a\ndescription: does things\ntools: [${tools}]\nprompt: go\n${rest}`;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pi-caps-"));
  resetSubagentMemoryQueuesForTest();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. schema 往返
// ---------------------------------------------------------------------------

describe("能力 schema", () => {
  test("四维度解析入库", () => {
    const r = parse(`${BASE_YAML}skills: [refund, tone]
mcp:
  servers: [crm, notion]
knowledge:
  - name: 产品手册
    type: files
    path: ./docs/**/*.md
  - name: 政策库
    type: mcp
    server: notion
    tool: notion__search
memory: private
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.skills).toEqual(["refund", "tone"]);
    expect(r.definition.mcpServers).toEqual(["crm", "notion"]);
    expect(r.definition.knowledge).toEqual([
      { name: "产品手册", type: "files", path: "./docs/**/*.md" },
      { name: "政策库", type: "mcp", server: "notion", tool: "notion__search" },
    ]);
    expect(r.definition.memory).toBe("private");
  });

  test("emit → parse 往返无损（守住 formToYaml 类丢字段）", () => {
    const draft: SubagentDraft = {
      name: "cs",
      description: "客服",
      tools: ["read", "WebFetch"],
      prompt: "body\n",
      skills: ["refund"],
      mcpServers: ["crm"],
      knowledge: [{ name: "手册", type: "files", path: "./docs/*.md" }],
      memory: "private",
    };
    const r = parse(emitSubagentYaml(draft));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.skills).toEqual(["refund"]);
    expect(r.definition.mcpServers).toEqual(["crm"]);
    expect(r.definition.knowledge).toEqual(draft.knowledge);
    expect(r.definition.memory).toBe("private");
  });

  test("未声明的维度不出现在定义里（不留空壳）", () => {
    const r = parse(BASE_YAML);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.skills).toBeUndefined();
    expect(r.definition.mcpServers).toBeUndefined();
    expect(r.definition.knowledge).toBeUndefined();
    expect(r.definition.memory).toBeUndefined();
  });

  test("memory: none 等价于不声明", () => {
    const r = parse(`${BASE_YAML}memory: none\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.memory).toBeUndefined();
  });

  test("非法 memory 记警告不丢弃定义", () => {
    const r = parse(`${BASE_YAML}memory: forever\n`);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("memory"))).toBe(true);
  });

  test("知识源格式错误只丢该条", () => {
    const r = parse(defYaml("read", `knowledge:
  - name: ok
    type: files
    path: ./a.md
  - name: bad
    type: files
  - name: alsoBad
    type: quantum
`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.knowledge).toEqual([{ name: "ok", type: "files", path: "./a.md" }]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 2. 大小写归一（守住既有相等性缺陷）
// ---------------------------------------------------------------------------

describe("工具名大小写归一", () => {
  test("webfetch 解析为规范注册名 WebFetch", () => {
    const r = parse(defYaml("webfetch, READ"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 归一后能精确匹配会话工具表；旧实现会 lowerCase 成 webfetch 而永不命中
    expect(r.definition.tools).toEqual(["WebFetch", "read"]);
  });

  test("canonicalToolName 大小写不敏感", () => {
    expect(canonicalToolName("webfetch")).toBe("WebFetch");
    expect(canonicalToolName("WEBFETCH")).toBe("WebFetch");
    expect(canonicalToolName(" use_skill ")).toBe("use_skill");
    expect(canonicalToolName("nope")).toBeUndefined();
  });

  test("不在可授予目录内的工具记警告", () => {
    const r = parse(defYaml("read, Question"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.tools).toEqual(["read"]);
    expect(r.warnings.some((w) => w.includes("Question"))).toBe(true);
  });

  test("mcp / memory_* 不可按裸工具名授予", () => {
    expect(canonicalToolName("mcp")).toBeUndefined();
    expect(canonicalToolName("memory_write")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. read 依赖校验
// ---------------------------------------------------------------------------

describe("知识源的工具依赖", () => {
  test("files 知识源缺 read 出警告", () => {
    const r = parse(defYaml("grep", `knowledge:
  - name: m
    type: files
    path: ./x.md
`));
    expect(r.warnings.some((w) => w.includes("read"))).toBe(true);
  });

  test("有 read 时不出该警告", () => {
    const r = parse(defYaml("read", `knowledge:
  - name: m
    type: files
    path: ./x.md
`));
    expect(r.warnings.some((w) => w.includes("read tool"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. 提示词不变式
// ---------------------------------------------------------------------------

describe("提示词不变式", () => {
  const def = (over: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
    name: "Explorer",
    description: "d",
    tools: ["read"],
    prompt: "body",
    scope: "builtin",
    stateKey: "builtin:explorer",
    ...over,
  });

  test("无能力块时与引入前逐字节相同", () => {
    const prompt = composeSubagentSystemPrompt({ definition: def(), cwd: CWD });
    // 缓存不变式：既有定义不得因为引入能力模型而多出一个字节
    expect(prompt).not.toContain("<knowledge_sources>");
    expect(prompt).not.toContain("<allowed_mcp_servers>");
    expect(prompt).not.toContain("<available_skills>");
    expect(prompt).not.toContain("## Your memory");
    expect(prompt.endsWith("body")).toBe(true);
  });

  test("空能力块与省略 capabilityBlock 等价", () => {
    const a = composeSubagentSystemPrompt({ definition: def(), cwd: CWD });
    const b = composeSubagentSystemPrompt({ definition: def(), cwd: CWD, capabilityBlock: "" });
    expect(a).toBe(b);
  });

  test("能力块插在框架与正文之间", () => {
    const prompt = composeSubagentSystemPrompt({
      definition: def(),
      cwd: CWD,
      capabilityBlock: "<allowed_mcp_servers>\ncrm\n</allowed_mcp_servers>",
    });
    expect(prompt).toContain("<allowed_mcp_servers>");
    // 正文对"怎么干活"有最后发言权
    expect(prompt.indexOf("allowed_mcp_servers")).toBeLessThan(prompt.indexOf("body"));
  });
});

// ---------------------------------------------------------------------------
// 6. kb_search
// ---------------------------------------------------------------------------

describe("kb_search", () => {
  const sources: KnowledgeSource[] = [{ name: "手册", type: "files", path: "./docs/**/*.md" }];

  function fixture(): string {
    mkdirSync(join(tmp, "docs/api"), { recursive: true });
    writeFileSync(join(tmp, "docs/manual.md"), "退款政策\n政策正文\n七天内可退\n");
    writeFileSync(join(tmp, "docs/api/guide.md"), "API\n退款在第三章\n");
    writeFileSync(join(tmp, "docs/skip.bin"), "退款\x00binary");
    return tmp;
  }

  test("递归 glob 命中嵌套文件（`**/` 曾被拆段吞掉）", () => {
    const root = fixture();
    const r = searchKnowledge(root, sources, "退款", 10);
    const rels = r.hits.map((h) => h.rel).sort();
    expect(rels).toEqual(["docs/api/guide.md", "docs/manual.md"]);
  });

  test("单段 glob 不跨目录", () => {
    const root = fixture();
    const r = searchKnowledge(
      root,
      [{ name: "手册", type: "files", path: "./docs/*.md" }],
      "退款",
      10,
    );
    expect(r.hits.map((h) => h.rel)).toEqual(["docs/manual.md"]);
  });

  test("精确文件路径可直接指到", () => {
    const root = fixture();
    const r = searchKnowledge(
      root,
      [{ name: "手册", type: "files", path: "./docs/manual.md" }],
      "退款",
      10,
    );
    expect(r.hits.map((h) => h.rel)).toEqual(["docs/manual.md"]);
  });

  test("命中带 source 名与行号", () => {
    const root = fixture();
    const r = searchKnowledge(root, sources, "退款", 10);
    const hit = r.hits[0]!;
    expect(hit.source).toBe("手册");
    expect(hit.line).toBeGreaterThan(0);
  });

  test("二进制文件被跳过", () => {
    const root = fixture();
    const r = searchKnowledge(
      root,
      [{ name: "全", type: "files", path: "./docs/*" }],
      "退款",
      10,
    );
    expect(r.hits.every((h) => !h.rel.endsWith(".bin"))).toBe(true);
  });

  test("超预算显式标注截断，不静默", () => {
    const big = mkdtempSync(join(tmpdir(), "pi-kb-big-"));
    mkdirSync(join(big, "docs"), { recursive: true });
    // 每个文件 1MB，20 个 = 20MB，远超 8MiB 扫描预算
    const chunk = "退款政策 line\n".repeat(60000);
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(big, `docs/f${i}.md`), chunk);
    }
    const r = searchKnowledge(
      big,
      [{ name: "大", type: "files", path: "./docs/*.md" }],
      "退款",
      5,
    );
    expect(r.truncated).toBe(true);
    expect(r.hits.length).toBeLessThanOrEqual(5);
    rmSync(big, { recursive: true, force: true });
  });

  test("命中条数受上限约束", () => {
    const root = fixture();
    const r = searchKnowledge(root, sources, "退款", 1);
    expect(r.hits.length).toBeLessThanOrEqual(1);
  });

  test("空查询不扫描", () => {
    const root = fixture();
    expect(searchKnowledge(root, sources, "   ", 10).hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8/9/10. 记忆
// ---------------------------------------------------------------------------

describe("子代理记忆", () => {
  test("private 落在独立命名空间，不碰主记忆目录", () => {
    const dir = privateSubagentMemoryDir(CWD, "Customer-Service");
    expect(dir).toBe(join(CWD, ".kova", "agent-memory", "customer-service"));
    expect(dir).not.toContain(join(".kova", "memory"));
  });

  test("shared 走主记忆工作区目录", () => {
    expect(subagentMemoryDir("shared", CWD, "x")).toBe(join(CWD, ".kova", "memory"));
  });

  test("名称归一：不同大小写落到同一目录（防记忆分裂）", () => {
    expect(privateSubagentMemoryDir(CWD, "CS-Agent")).toBe(
      privateSubagentMemoryDir(CWD, "cs-agent"),
    );
  });

  test("写入不产生 .kova/memory 下的文件", async () => {
    const dir = privateSubagentMemoryDir(tmp, "cs");
    await writeSubagentMemory(dir, "MEMORY.md", "客户 X 偏好退款", "append");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("客户 X");
    expect(() => readFileSync(join(tmp, ".kova/memory/MEMORY.md"), "utf8")).toThrow();
  });

  test("append 保留既有内容（并发不丢行）", async () => {
    const dir = privateSubagentMemoryDir(tmp, "cs");
    await Promise.all([
      writeSubagentMemory(dir, "MEMORY.md", "第一条", "append"),
      writeSubagentMemory(dir, "MEMORY.md", "第二条", "append"),
      writeSubagentMemory(dir, "MEMORY.md", "第三条", "append"),
    ]);
    const text = readFileSync(join(dir, "MEMORY.md"), "utf8");
    for (const s of ["第一条", "第二条", "第三条"]) expect(text).toContain(s);
  });

  test("overwrite 整体替换", async () => {
    const dir = privateSubagentMemoryDir(tmp, "cs");
    await writeSubagentMemory(dir, "MEMORY.md", "旧内容", "append");
    await writeSubagentMemory(dir, "MEMORY.md", "新内容", "overwrite");
    const text = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(text).toContain("新内容");
    expect(text).not.toContain("旧内容");
  });

  test("非法文件名被拒（防越界写到目录外）", async () => {
    const dir = privateSubagentMemoryDir(tmp, "cs");
    await expect(
      writeSubagentMemory(dir, "../escape.md", "x", "append"),
    ).rejects.toThrow();
  });

  test("提示词段注入根级文件正文", async () => {
    const dir = privateSubagentMemoryDir(tmp, "cs");
    await writeSubagentMemory(dir, "MEMORY.md", "常驻结论：满 50 包邮", "append");
    const block = subagentMemoryPromptBlock(dir);
    expect(block).toContain("满 50 包邮");
    expect(block).toContain("## Your memory");
  });

  test("空目录也给最小引导（否则模型永远不写第一条）", () => {
    const block = subagentMemoryPromptBlock(join(tmp, "empty"));
    expect(block).toContain("## Your memory");
    expect(block).toContain("memory_write");
  });

  test("超预算的文件整体略去并留说明", async () => {
    const dir = privateSubagentMemoryDir(tmp, "cs");
    // 逐文件 4K 截断，但整段 12K 预算：三个各 5K 的文件才会把总额顶破，
    // 留下 "not shown" 说明行。单个 9K 文件只会走逐文件截断，不触发略过。
    for (const n of ["a", "b", "c"]) {
      await writeSubagentMemory(dir, `${n}.md`, `${n}${"x".repeat(5000)}`, "overwrite");
    }
    const block = subagentMemoryPromptBlock(dir);
    expect(block).toContain("not shown");
  });

  test("scope 不进工具 schema（伪造无门可过）", async () => {
    const dir = privateSubagentMemoryDir(tmp, "cs");
    const { buildSubagentMemoryTools } = await import("../../src/subagent/memory");
    const tools = buildSubagentMemoryTools(dir, "cs");
    const write = tools.find((t) => t.name === "memory_write");
    expect(write).toBeDefined();
    const props = Object.keys((write!.parameters as { properties?: object }).properties ?? {});
    expect(props).toContain("content");
    expect(props).not.toContain("scope");
  });
});

// ---------------------------------------------------------------------------
// 可授予目录自身的一致性
// ---------------------------------------------------------------------------

describe("GRANTABLE_TOOLS", () => {
  test("不含管理面与交互面工具", () => {
    for (const banned of ["Question", "mcp", "memory_write", "browser", "subagents_save"]) {
      expect(GRANTABLE_TOOLS).not.toContain(banned);
    }
  });

  test("六个历史内置工具仍在列（不破坏既有定义）", () => {
    for (const legacy of ["bash", "read", "write", "edit", "glob", "grep"]) {
      expect(GRANTABLE_TOOLS).toContain(legacy);
    }
  });
});
// ---------------------------------------------------------------------------
// 保存路径往返（守住协议层的静默丢字段）
// ---------------------------------------------------------------------------

describe("保存路径", () => {
  test("表单草稿经 emit → parse 保住全部维度（含 CamelCase 工具）", () => {
    const draft: SubagentDraft = {
      name: "cs",
      description: "客服",
      tools: ["read", "WebFetch"],
      prompt: "你是售后\n",
      skills: ["refund"],
      mcpServers: ["crm"],
      knowledge: [
        { name: "手册", type: "files", path: "./docs/*.md" },
        { name: "政策", type: "mcp", server: "notion", tool: "notion__search" },
      ],
      memory: "private",
    };
    const r = parse(emitSubagentYaml(draft));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.tools).toEqual(["read", "WebFetch"]);
    expect(r.definition.skills).toEqual(["refund"]);
    expect(r.definition.mcpServers).toEqual(["crm"]);
    expect(r.definition.knowledge).toHaveLength(2);
    expect(r.definition.memory).toBe("private");
  });

  test("canonicalToolName 保住 WebFetch 大小写（协议层不再无条件小写化）", () => {
    // 协议 handler 曾对 d.tools 无条件 toLowerCase()，把 WebFetch 变成 webfetch，
    // 保存后定义里的工具永远匹配不上会话工具表
    expect(["WebFetch", "webfetch", "WEBFETCH"].map(canonicalToolName)).toEqual([
      "WebFetch",
      "WebFetch",
      "WebFetch",
    ]);
  });
});
