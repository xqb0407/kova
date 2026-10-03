/**
 * 工作区写边界（`workspace-write` 审批档的判据）。
 *
 * 这层是安全边界，所以测试的方向是「找绕过」，不是「确认正常路径能过」：
 * 相对路径穿越、绝对路径、前缀相似目录、软链接——每一条都是真的能绕过去的写法。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isInside,
  realResolve,
  writeTargetInsideWorkspace,
} from "../../src/agent/workspace-boundary";

const root = mkdtempSync(join(tmpdir(), "ws-boundary-"));
const ws = join(root, "project");
const other = join(root, "other-project");
mkdirSync(join(ws, "src"), { recursive: true });
mkdirSync(other, { recursive: true });
writeFileSync(join(ws, "src", "a.ts"), "x");
writeFileSync(join(other, "secret.ts"), "x");
// 工作区内一个指向外部的软链接：字符串前缀比较会被它绕过
symlinkSync(other, join(ws, "escape"));

describe("writeTargetInsideWorkspace：工作区内放行", () => {
  test("相对路径（已存在与新建都算）", () => {
    expect(writeTargetInsideWorkspace("write", { file_path: "src/a.ts" }, ws)).toBe(true);
    expect(writeTargetInsideWorkspace("write", { file_path: "src/new.ts" }, ws)).toBe(true);
    expect(writeTargetInsideWorkspace("edit", { file_path: "./src/a.ts" }, ws)).toBe(true);
  });

  test("工作区自身的绝对路径", () => {
    expect(writeTargetInsideWorkspace("write", { file_path: join(ws, "b.ts") }, ws)).toBe(true);
  });

  test("多级不存在的子目录（祖先 realpath + 尾段拼回）", () => {
    expect(
      writeTargetInsideWorkspace("write", { file_path: "deep/nested/new/file.ts" }, ws),
    ).toBe(true);
  });
});

describe("writeTargetInsideWorkspace：工作区外拦下", () => {
  test("相对路径穿越到同级项目", () => {
    expect(
      writeTargetInsideWorkspace("write", { file_path: "../other-project/secret.ts" }, ws),
    ).toBe(false);
  });

  test("绝对路径指向别处", () => {
    expect(
      writeTargetInsideWorkspace("write", { file_path: join(other, "secret.ts") }, ws),
    ).toBe(false);
  });

  test("前缀相似目录不算内部（/root/project-x 不是 /root/project）", () => {
    const sibling = `${ws}-x`;
    mkdirSync(sibling, { recursive: true });
    expect(writeTargetInsideWorkspace("write", { file_path: join(sibling, "f.ts") }, ws))
      .toBe(false);
  });

  test("**软链接绕过**：工作区内指向外部的链接按真实落点判", () => {
    expect(writeTargetInsideWorkspace("write", { file_path: "escape/hack.ts" }, ws))
      .toBe(false);
  });

  test("软链接指向外部已存在的文件", () => {
    expect(
      writeTargetInsideWorkspace("write", { file_path: "escape/secret.ts" }, ws),
    ).toBe(false);
  });
});

describe("无法判定的一律不放行（安全判据的方向是不确定就拦）", () => {
  test("bash 永远 false——参数里看不出它会写到哪", () => {
    expect(writeTargetInsideWorkspace("bash", { command: "touch src/x.ts" }, ws)).toBe(false);
    expect(writeTargetInsideWorkspace("bash", {}, ws)).toBe(false);
  });

  test("没有路径的写类工具（配置类）不放行", () => {
    for (const name of ["subagent_save", "skill_save", "plugin_install", "design_theme_save"]) {
      expect(writeTargetInsideWorkspace(name, { path: "x" }, ws)).toBe(false);
    }
  });

  test("file_path 缺失、空白、非字符串", () => {
    for (const bad of [undefined, null, "", "   ", 42, {}]) {
      expect(writeTargetInsideWorkspace("write", { file_path: bad }, ws)).toBe(false);
    }
    expect(writeTargetInsideWorkspace("write", undefined, ws)).toBe(false);
  });
});

describe("isInside / realResolve", () => {
  test("isInside：自身算内部，`..` 与绝对路径正确归位", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });

  test("realResolve 对不存在的路径也返回绝对路径（不抛）", () => {
    const p = realResolve(join(ws, "no/such/deep/file.ts"));
    expect(p.startsWith("/")).toBe(true);
    expect(p.endsWith("file.ts")).toBe(true);
  });

  test("realResolve 把软链接解到真实路径（macOS /tmp 也是这种情形）", () => {
    expect(realResolve(join(ws, "escape"))).toBe(realResolve(other));
  });
});

// 清理（测试进程退出前）
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});
