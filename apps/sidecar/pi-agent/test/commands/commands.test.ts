import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandsSnapshot,
  expandCommand,
  resetCommandsCacheForTest,
  saveCommandDoc,
  deleteCommandDoc,
} from "../../src/commands/commands";

/**
 * 自定义命令场景测试：三层发现（workspace > global > builtin）、frontmatter
 * 解析、$ARGUMENTS 替换、未知/非斜杠透传、内置 /init 可被用户同名文件覆盖。
 * 全局层经 PI_GLOBAL_COMMANDS_DIR 钉住到临时目录；工作区用临时 cwd。
 */

const tmp = mkTmp("pi-commands-");
const globalDir = join(tmp, "global");
const workspace = join(tmp, "ws");
const wsCmds = join(workspace, ".kova", "commands");

function mkTmp(prefix: string): string {
  return join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

function setup(): void {
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(wsCmds, { recursive: true });
  process.env.PI_GLOBAL_COMMANDS_DIR = globalDir;
}

setup();

function write(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, "utf8");
}

function cleanup(): void {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.PI_GLOBAL_COMMANDS_DIR;
}
process.on("exit", cleanup);

describe("expandCommand", () => {
  test("非斜杠与未知命令：原样透传（null）", () => {
    resetCommandsCacheForTest();
    expect(expandCommand(workspace, "普通问题")).toBeNull();
    expect(expandCommand(workspace, "/no-such-cmd 参数")).toBeNull();
    // 路径形态 /etc/hosts：未知名 → 透传，不会被误展开
    expect(expandCommand(workspace, "/etc/hosts 是什么")).toBeNull();
  });

  test("内置 /init：可展开，模板含 AGENTS.md 指引；参数追加尾部", () => {
    resetCommandsCacheForTest();
    const out = expandCommand(workspace, "/init");
    expect(out).toContain("AGENTS.md");
    expect(out).not.toContain("$ARGUMENTS");
    const withArgs = expandCommand(workspace, "/init 重点是测试约定");
    expect(withArgs).toContain("AGENTS.md");
    expect(withArgs?.endsWith("重点是测试约定")).toBe(true);
  });

  test("无 frontmatter 文件：正文即模板；$ARGUMENTS 占位替换", () => {
    write(globalDir, "plain", "把这段话翻译成英文：$ARGUMENTS");
    resetCommandsCacheForTest();
    expect(expandCommand(workspace, "/plain 你好世界")).toBe("把这段话翻译成英文：你好世界");
    // 无参数：占位符替换为空串
    expect(expandCommand(workspace, "/plain")).toBe("把这段话翻译成英文：");
  });

  test("带 frontmatter：description/argument-hint 解析；无占位符时参数追加尾部", () => {
    write(globalDir, "codereview", [
      "---",
      "description: 审查指定文件",
      "argument-hint: <文件路径>",
      "---",
      "Review the file thoroughly.",
    ].join("\n"));
    resetCommandsCacheForTest();
    expect(expandCommand(workspace, "/codereview src/a.ts")).toBe(
      "Review the file thoroughly.\n\nsrc/a.ts",
    );
  });

  test("frontmatter 值两侧成对引号剥掉；CRLF 行尾不影响解析", () => {
    write(globalDir, "quoted", [
      "---",
      'description: "带引号的描述"',
      "argument-hint: '<参数>'",
      "---",
      "body",
    ].join("\n"));
    write(globalDir, "crlf", "---\r\ndescription: CRLF 描述\r\n---\r\n正文内容");
    resetCommandsCacheForTest();
    const snap = commandsSnapshot(workspace);
    expect(snap.find((c) => c.name === "quoted")?.description).toBe("带引号的描述");
    expect(snap.find((c) => c.name === "quoted")?.argumentHint).toBe("<参数>");
    expect(snap.find((c) => c.name === "crlf")?.description).toBe("CRLF 描述");
    expect(expandCommand(workspace, "/crlf")).toBe("正文内容");
  });

  test("三层优先：workspace > global > builtin（同名覆盖）", () => {
    write(globalDir, "deploy", "global deploy body");
    write(wsCmds, "deploy", "workspace deploy body");
    write(wsCmds, "init", [
      "---",
      "description: 自定义的 init 覆盖内置",
      "---",
      "自定义的 init 覆盖内置",
    ].join("\n"));
    resetCommandsCacheForTest();
    expect(expandCommand(workspace, "/deploy")).toBe("workspace deploy body");
    expect(expandCommand(workspace, "/init")).toBe("自定义的 init 覆盖内置");
    // 全局目录在 workspace 未覆盖时仍生效
    write(globalDir, "gonly", "global only");
    resetCommandsCacheForTest();
    expect(expandCommand(workspace, "/gonly")).toBe("global only");
  });

  test("mtime 变化：缓存失效重扫（同进程内改文件即时生效）", () => {
    write(wsCmds, "hot", "v1");
    resetCommandsCacheForTest();
    expect(expandCommand(workspace, "/hot")).toBe("v1");
    write(wsCmds, "hot", "v2");
    expect(expandCommand(workspace, "/hot")).toBe("v2");
  });
});

describe("commandsSnapshot（菜单水合）", () => {
  test("含来源标记与 argument-hint，按名排序", () => {
    resetCommandsCacheForTest();
    const snap = commandsSnapshot(workspace);
    const names = snap.map((c) => c.name);
    expect(names).toContain("init");
    expect(names).toContain("deploy");
    const init = snap.find((c) => c.name === "init")!;
    expect(init.source).toBe("workspace"); // 被 workspace 同名覆盖
    expect(init.description).toBe("自定义的 init 覆盖内置");
    const review = snap.find((c) => c.name === "codereview")!;
    expect(review.argumentHint).toBe("<文件路径>");
    expect(review.source).toBe("global");
    // 排序：字典序
    expect([...names].sort()).toEqual(names);
  });

  test("无 cwd：仍列全局与内置，不扫工作区层", () => {
    resetCommandsCacheForTest();
    const snap = commandsSnapshot(undefined);
    expect(snap.map((c) => c.name)).toContain("init");
    expect(snap.map((c) => c.name)).toContain("gonly");
    // "hot" 只在工作区层（mtime 测试写的）：无 cwd 快照不该出现
    expect(snap.map((c) => c.name)).not.toContain("hot");
  });
});

describe("saveCommandDoc / deleteCommandDoc（管理页）", () => {
  test("保存工作区命令：落盘 frontmatter + 正文，展开即生效", async () => {
    await saveCommandDoc({
      scope: "workspace",
      name: "deploy",
      description: "部署到指定环境",
      argumentHint: "<env>",
      body: "Deploy the app to $ARGUMENTS.",
      cwd: workspace,
    });
    const snap = commandsSnapshot(workspace);
    const c = snap.find((x) => x.name === "deploy")!;
    expect(c.source).toBe("workspace");
    expect(c.description).toBe("部署到指定环境");
    expect(c.argumentHint).toBe("<env>");
    expect(expandCommand(workspace, "/deploy prod")).toBe("Deploy the app to prod.");
  });

  test("保留名拒绝：前端动作命令集合（与 composer SLASH_COMMANDS 同步）", async () => {
    for (const name of ["plan", "ask", "goal", "shell", "review"]) {
      await expect(
        saveCommandDoc({ scope: "workspace", name, body: "x", cwd: workspace }),
      ).rejects.toThrow("保留名");
    }
  });

  test("非法命令名拒绝", async () => {
    await expect(
      saveCommandDoc({ scope: "workspace", name: "1bad", body: "x", cwd: workspace }),
    ).rejects.toThrow("非法命令名");
    await expect(
      saveCommandDoc({ scope: "workspace", name: "has space", body: "x", cwd: workspace }),
    ).rejects.toThrow("非法命令名");
  });

  test("改名：replaceName 清掉旧文件", async () => {
    await saveCommandDoc({ scope: "workspace", name: "old-name", body: "x", cwd: workspace });
    await saveCommandDoc({
      scope: "workspace",
      name: "new-name",
      body: "x",
      cwd: workspace,
      replaceName: "old-name",
    });
    const names = commandsSnapshot(workspace).map((c) => c.name);
    expect(names).not.toContain("old-name");
    expect(names).toContain("new-name");
  });

  test("删除：移除文件；不存在时报错", async () => {
    await saveCommandDoc({ scope: "workspace", name: "del-me", body: "x", cwd: workspace });
    expect(commandsSnapshot(workspace).map((c) => c.name)).toContain("del-me");
    await deleteCommandDoc({ scope: "workspace", name: "del-me", cwd: workspace });
    expect(commandsSnapshot(workspace).map((c) => c.name)).not.toContain("del-me");
    await expect(
      deleteCommandDoc({ scope: "workspace", name: "del-me", cwd: workspace }),
    ).rejects.toThrow("不存在");
  });

  test("全局层保存：不落工作区目录", async () => {
    await saveCommandDoc({ scope: "global", name: "g-cmd", body: "global body" });
    expect(commandsSnapshot(undefined).find((c) => c.name === "g-cmd")?.source).toBe("global");
    await deleteCommandDoc({ scope: "global", name: "g-cmd" });
    expect(commandsSnapshot(undefined).map((c) => c.name)).not.toContain("g-cmd");
  });
});
