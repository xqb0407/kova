import { describe, expect, it } from "bun:test";
import {
  WORKSPACE_MAX_FOLDERS,
  appendWorkspaceFolder,
  hasWorkspaceFolder,
  normalizeFolderPath,
  splitWorkspaceFolders,
  workspaceFolderName,
} from "./workspace-creation";

describe("新建工作区路径逻辑", () => {
  describe("normalizeFolderPath", () => {
    it("去首尾空白与尾部重复分隔符", () => {
      expect(normalizeFolderPath("  /tmp/demo  ")).toBe("/tmp/demo");
      expect(normalizeFolderPath("/tmp/demo/")).toBe("/tmp/demo");
      expect(normalizeFolderPath("/tmp/demo///")).toBe("/tmp/demo");
      expect(normalizeFolderPath("C:\\work\\demo\\")).toBe("C:\\work\\demo");
    });

    it("根目录保留分隔符", () => {
      expect(normalizeFolderPath("/")).toBe("/");
      expect(normalizeFolderPath("///")).toBe("/");
      expect(normalizeFolderPath("C:\\")).toBe("C:\\");
      expect(normalizeFolderPath("D:/")).toBe("D:\\");
    });

    it("空输入返回空串", () => {
      expect(normalizeFolderPath("")).toBe("");
      expect(normalizeFolderPath("   ")).toBe("");
    });
  });

  describe("appendWorkspaceFolder", () => {
    it("追加并规范化", () => {
      expect(appendWorkspaceFolder([], "/tmp/a/")).toEqual(["/tmp/a"]);
      expect(appendWorkspaceFolder(["/tmp/a"], "/tmp/b")).toEqual([
        "/tmp/a",
        "/tmp/b",
      ]);
    });

    it("重复路径（含尾斜杠差异）不重复加入", () => {
      expect(appendWorkspaceFolder(["/tmp/a"], "/tmp/a/")).toEqual(["/tmp/a"]);
      expect(hasWorkspaceFolder(["/tmp/a/"], "/tmp/a")).toBe(true);
    });

    it("空路径与上限外不加入", () => {
      expect(appendWorkspaceFolder(["/tmp/a"], "  ")).toEqual(["/tmp/a"]);
      const full = Array.from(
        { length: WORKSPACE_MAX_FOLDERS },
        (_, i) => `/tmp/${i}`,
      );
      expect(appendWorkspaceFolder(full, "/tmp/extra")).toEqual(full);
    });
  });

  describe("splitWorkspaceFolders", () => {
    it("首项为主目录，其余为附加根", () => {
      expect(splitWorkspaceFolders(["/tmp/a/", "/tmp/b", "/tmp/c"])).toEqual({
        main: "/tmp/a",
        additional: ["/tmp/b", "/tmp/c"],
      });
    });

    it("去重后仍保持首项为主目录", () => {
      expect(
        splitWorkspaceFolders(["/tmp/a", "/tmp/a/", "/tmp/b", ""]),
      ).toEqual({
        main: "/tmp/a",
        additional: ["/tmp/b"],
      });
    });

    it("空列表没有主目录", () => {
      expect(splitWorkspaceFolders([])).toEqual({ main: null, additional: [] });
    });
  });

  it("workspaceFolderName 取目录名", () => {
    expect(workspaceFolderName("/tmp/demo/")).toBe("demo");
    expect(workspaceFolderName("C:\\work\\demo")).toBe("demo");
  });
});
