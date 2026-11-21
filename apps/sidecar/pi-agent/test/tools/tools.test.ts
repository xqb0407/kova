import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASH_TOOL_DESCRIPTION,
  READ_TOOL_DESCRIPTION,
  SYSTEM_PROMPT_CORE,
  WRITE_TOOL_DESCRIPTION,
  buildHostToolPayload,
  buildTools,
  globToRegExp,
} from "../../src/tools/tools";
import { resetVisionToolConfigForTest } from "../../src/tools/vision-tool-config";

describe("grep include 路径 glob（pi #11807 同源）", () => {
  const textOf = (r: unknown): string => {
    const c = (r as { content?: Array<{ type?: string; text?: string }> }).content;
    return Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : "";
  };

  test("include 支持相对 path 的路径段与 basename 双匹配；./ 前缀忽略", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-grep-"));
    try {
      mkdirSync(join(dir, "migrations", "main"), { recursive: true });
      writeFileSync(join(dir, "migrations", "main", "a.js"), "CREATE TABLE users;\n");
      writeFileSync(join(dir, "b.js"), "SELECT 1;\n");
      writeFileSync(join(dir, "migrations", "c.js"), "DROP TABLE x;\n");
      const tools = buildTools(dir, "t-grep");
      const grep = tools.find((t) => t.name === "grep")!;

      // 路径段 glob：只命中 migrations/main/ 下的文件
      const pathGlob = textOf(
        await grep.execute("g1", { pattern: "TABLE|SELECT", path: ".", include: "migrations/main/*.js" }),
      );
      expect(pathGlob).toContain("migrations/main/a.js");
      expect(pathGlob).not.toContain("b.js");

      // ./ 前缀忽略（此前恒零命中）
      const dotGlob = textOf(
        await grep.execute("g2", { pattern: "TABLE", path: ".", include: "./migrations/main/*.js" }),
      );
      expect(dotGlob).toContain("migrations/main/a.js");

      // basename glob 语义保持
      const baseGlob = textOf(
        await grep.execute("g3", { pattern: "SELECT", path: ".", include: "*.js" }),
      );
      expect(baseGlob).toContain("b.js");

      // glob 工具同款：./ 前缀忽略
      const globTool = tools.find((t) => t.name === "glob")!;
      const dotPattern = textOf(
        await globTool.execute("g4", { pattern: "./**/*.js", path: "." }),
      );
      expect(dotPattern).toContain("b.js");
      expect(dotPattern).toContain("migrations/main/a.js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("see_image 条件注册（视觉辅助开关，防提示词污染回归门）", () => {
  test("默认关闭：工具表不含 see_image", () => {
    resetVisionToolConfigForTest();
    const tools = buildTools("/tmp/ws", "t-see-off");
    expect(tools.some((t) => t.name === "see_image")).toBe(false);
  });

  test("开启后注册，且其余工具名与顺序完全不变", () => {
    const before = buildTools("/tmp/ws", "t-see-base").map((t) => t.name);
    expect(before).not.toContain("see_image");
    resetVisionToolConfigForTest({ enabled: true });
    try {
      const after = buildTools("/tmp/ws", "t-see-on").map((t) => t.name);
      expect(after).toContain("see_image");
      expect(after.filter((n) => n !== "see_image")).toEqual(before);
    } finally {
      resetVisionToolConfigForTest();
    }
  });
});

describe("IM 会话工具面（无人值守）", () => {
  test("im: 线程不注入 Question 与面板类工具，普通线程照常", () => {
    const imTools = buildTools("/tmp/ws", "im:session-1").map((t) => t.name);
    const normalTools = buildTools("/tmp/ws", "t-normal").map((t) => t.name);
    for (const name of ["Question", "open_file", "open_plugin_panel"]) {
      expect(imTools).not.toContain(name);
      expect(normalTools).toContain(name);
    }
    // 其余核心工具不因 IM 会话被一并收走
    expect(imTools).toContain("bash");
    expect(imTools).toContain("read");
    expect(imTools).toContain("write");
  });
});

describe("工具描述（引导模型用专用文件工具）", () => {
  test("bash：不再推荐 grep/tail/head，保留 formatter/codegen，并禁止用 shell 文本工具读项目文件", () => {
    expect(BASH_TOOL_DESCRIPTION).not.toContain("grep/tail/head");
    expect(BASH_TOOL_DESCRIPTION).toContain("formatters, codegen");
    expect(BASH_TOOL_DESCRIPTION).toContain("not cat/head/tail/sed/awk");
    expect(BASH_TOOL_DESCRIPTION).toContain("bypass the read state");
  });

  test("bash：大文件追加指到 write append；临时脚本指到绝对 /tmp 路径", () => {
    expect(BASH_TOOL_DESCRIPTION).toContain('mode "append"');
    expect(BASH_TOOL_DESCRIPTION).toContain("absolute /tmp paths");
    expect(BASH_TOOL_DESCRIPTION).toContain("do not cd into a temp dir");
  });

  test("系统提示词点名 shell 手改禁令（与 mode gate 对齐）", () => {
    expect(SYSTEM_PROMPT_CORE).toContain("Never create or modify project files through bash");
    expect(SYSTEM_PROMPT_CORE).toContain("formatters, codegen and package managers are allowed");
  });

  test("系统提示词点名检索范围：默认工作区、越界用具体路径", () => {
    expect(SYSTEM_PROMPT_CORE).toContain("Search scope:");
    expect(SYSTEM_PROMPT_CORE).toContain("keep the search root as narrow");
    expect(SYSTEM_PROMPT_CORE).toContain("Never scan the home directory");
    // 核心仍无 cwd / 无“workspace directory”字面量（见 modes.test.ts 的缓存不变式）
    expect(SYSTEM_PROMPT_CORE).not.toContain("workspace directory");
  });

  test("grep/glob 描述声明默认工作区与收窄路径", () => {
    const tools = buildTools("/tmp/ws", "t-search-scope");
    for (const name of ["grep", "glob"]) {
      const description = tools.find((t) => t.name === name)?.description ?? "";
      expect(description).toContain("Defaults to the workspace");
      expect(description).toContain("narrow the search");
      expect(description).toContain("home directory");
    }
  });

  test("read：明确用 read + offset/limit 代替 cat/head/tail/sed -n", () => {
    expect(READ_TOOL_DESCRIPTION).toContain("instead of cat/head/tail/sed -n");
    expect(READ_TOOL_DESCRIPTION).toContain("offset/limit");
    expect(READ_TOOL_DESCRIPTION).toContain("read state");
  });

  test("write：说明 read-state 与输出预算分段，不再声称宿主超时", () => {
    expect(WRITE_TOOL_DESCRIPTION).not.toContain("times out");
    expect(WRITE_TOOL_DESCRIPTION).toContain("needs a current read state");
    expect(WRITE_TOOL_DESCRIPTION).toContain("write it in parts");
    expect(WRITE_TOOL_DESCRIPTION).toContain("response budget");
  });

  test("buildTools 实际使用这些描述（防止常量与工具对象脱钩）", () => {
    const tools = buildTools("/tmp/ws", "t");
    expect(tools.find((t) => t.name === "bash")?.description).toBe(BASH_TOOL_DESCRIPTION);
    expect(tools.find((t) => t.name === "read")?.description).toBe(READ_TOOL_DESCRIPTION);
    expect(tools.find((t) => t.name === "write")?.description).toBe(WRITE_TOOL_DESCRIPTION);
    const editDescription = tools.find((t) => t.name === "edit")?.description ?? "";
    expect(editDescription).toContain("falls back through tolerant strategies");
    expect(editDescription).toContain("reports which strategy matched");
  });

  test("系统提示词点名编码风格：贴住周边代码的密度/命名/习语", () => {
    expect(SYSTEM_PROMPT_CORE).toContain(
      "Write code that reads like the surrounding code: match its comment density, naming, idiom",
    );
  });
});

describe("buildHostToolPayload（宿主信封组装的安全边界）", () => {
  test("模型伪造的 secretEnv 被摘掉：注入名单只能由本侧 augment 决定", () => {
    // 工具 schema 里没有 secretEnv，但不妨碍模型多吐一个字段——放行就等于
    // 绕过用户的密钥授权策略，直接要求注入任意密钥
    const payload = buildHostToolPayload({
      command: "echo $GITHUB_TOKEN",
      secretEnv: [{ name: "GITHUB_TOKEN", scope: "global" }],
      secretEnvResolved: [{ name: "X", value: "leak" }],
    });
    expect(payload).toEqual({ command: "echo $GITHUB_TOKEN" });
  });

  test("本侧 augment 给的名单照常写入（且覆盖模型同名键）", () => {
    const payload = buildHostToolPayload(
      { command: "npm publish", secretEnv: [{ name: "FAKE", scope: "global" }] },
      { secretEnv: [{ name: "NPM_TOKEN", scope: "global" }] },
    );
    expect(payload.secretEnv).toEqual([{ name: "NPM_TOKEN", scope: "global" }]);
  });

  test("无 augment / 空 augment 时信封与模型参数一致（剔除保留字段后）", () => {
    expect(buildHostToolPayload({ file_path: "a.txt" })).toEqual({ file_path: "a.txt" });
    expect(buildHostToolPayload({ file_path: "a.txt" }, {})).toEqual({ file_path: "a.txt" });
  });

  test("不改动入参对象（纯函数）", () => {
    const input = { command: "ls", secretEnv: [{ name: "X", scope: "global" }] };
    buildHostToolPayload(input);
    expect(input.secretEnv).toHaveLength(1);
  });

  test("模型伪造的 accelEnv 也被摘掉：加速前缀只能由本侧按用户设置决定", () => {
    // 放行等于给模型一条「把 bash 流量导去任意主机」的通路——GIT_CONFIG_*
    // 在 git 眼里就是任意 url.<base>.insteadOf 配置
    const payload = buildHostToolPayload({
      command: "git clone https://github.com/o/r.git",
      accelEnv: { GIT_CONFIG_COUNT: "1" },
    });
    expect(payload).toEqual({ command: "git clone https://github.com/o/r.git" });
  });

  test("本侧 augment 给的 accelEnv 照常写入（覆盖模型同名键）", () => {
    const payload = buildHostToolPayload(
      { command: "git clone https://github.com/o/r.git", accelEnv: { EVIL: "1" } },
      { accelEnv: { GIT_CONFIG_COUNT: "1" } },
    );
    expect(payload.accelEnv).toEqual({ GIT_CONFIG_COUNT: "1" });
  });

  test("模型伪造的 sandbox 被摘掉：计划只能由本侧闭包生成", () => {
    const payload = buildHostToolPayload({
      command: "rm -rf ~",
      sandbox: { tier: "off" },
    });
    expect(payload).toEqual({ command: "rm -rf ~" });
  });

  test("本侧 augment 给的 sandbox 照常写入（覆盖模型同名键）", () => {
    const payload = buildHostToolPayload(
      { command: "ls", sandbox: { tier: "off" } },
      { sandbox: { tier: "workspace" } },
    );
    expect(payload.sandbox).toEqual({ tier: "workspace" });
  });
});

describe("globToRegExp", () => {
  test("**/ 前缀匹配任意深度（含零层）", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/lib/deep/a.ts")).toBe(true);
    expect(re.test("src/a.js")).toBe(false);
  });

  test("* 不跨路径分隔符", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(false);
  });

  test("**.ext 匹配跨层", () => {
    const re = globToRegExp("src**.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src.ts")).toBe(true);
  });

  test("? 匹配单个字符", () => {
    const re = globToRegExp("a?c.ts");
    expect(re.test("abc.ts")).toBe(true);
    expect(re.test("ac.ts")).toBe(false);
    expect(re.test("abbc.ts")).toBe(false);
  });

  test("正则元字符按字面量处理", () => {
    const re = globToRegExp("a(b).ts");
    expect(re.test("a(b).ts")).toBe(true);
    expect(re.test("ab.ts")).toBe(false);
  });

  test("大小写不敏感（Windows 友好）", () => {
    expect(globToRegExp("*.TS").test("a.ts")).toBe(true);
  });
});

describe("条件注入：附加目录检索", () => {
  test("没有附加目录不注册；有附加目录才注册", () => {
    const off = buildTools(
      "/tmp/ws",
      "t-ext-off",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => [],
    ).map((tool) => tool.name);
    expect(off).not.toContain("search_external_files");

    const on = buildTools(
      "/tmp/ws",
      "t-ext-on",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => [{ path: "/tmp/shared", label: "shared" }],
    ).map((tool) => tool.name);
    expect(on).toContain("search_external_files");
  });
});

describe("条件注入：MCP 网关", () => {
  test("没有任何启用服务器不注册；有启用服务器才注册", () => {
    const root = mkdtempSync(join(tmpdir(), "kova-mcp-gate-"));
    const cwd = join(root, "ws");
    const plugins = join(root, "plugins");
    const empty = join(root, "empty.json");
    const one = join(root, "one.json");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(plugins, { recursive: true });
    writeFileSync(empty, JSON.stringify({ mcpServers: {} }));
    writeFileSync(
      one,
      JSON.stringify({ mcpServers: { demo: { command: "node", args: ["server.mjs"] } } }),
    );
    const prevConfig = process.env.PI_MCP_CONFIG;
    const prevPlugins = process.env.PI_PLUGINS_DIR;
    process.env.PI_PLUGINS_DIR = plugins;
    try {
      process.env.PI_MCP_CONFIG = empty;
      expect(buildTools(cwd, "t-mcp-off").map((tool) => tool.name)).not.toContain("mcp");

      process.env.PI_MCP_CONFIG = one;
      expect(buildTools(cwd, "t-mcp-on").map((tool) => tool.name)).toContain("mcp");
    } finally {
      if (prevConfig === undefined) delete process.env.PI_MCP_CONFIG;
      else process.env.PI_MCP_CONFIG = prevConfig;
      if (prevPlugins === undefined) delete process.env.PI_PLUGINS_DIR;
      else process.env.PI_PLUGINS_DIR = prevPlugins;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
