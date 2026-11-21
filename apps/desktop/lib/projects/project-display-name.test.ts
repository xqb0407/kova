import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  PROJECT_NAME_MAX_CHARS,
  normalizeProjectName,
  projectDisplayNameFor,
  projectLabelFor,
  resetProjectDisplayNamesForTest,
  setProjectDisplayName,
} from "./project-display-name";

/** 最小 localStorage 替身：测 hydration（预置）与落盘 */
function installStorageStub(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  };
  return store;
}

describe("项目显示名", () => {
  beforeEach(() => {
    resetProjectDisplayNamesForTest();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    resetProjectDisplayNamesForTest();
  });

  describe("normalizeProjectName", () => {
    it("trim 并保留内部空格", () => {
      expect(normalizeProjectName("  我的 项目  ")).toBe("我的 项目");
    });

    it("空值/非字符串返回 null", () => {
      expect(normalizeProjectName("")).toBeNull();
      expect(normalizeProjectName("   ")).toBeNull();
      expect(normalizeProjectName(null)).toBeNull();
      expect(normalizeProjectName(42)).toBeNull();
    });

    it("剔除控制字符并截断超长", () => {
      expect(normalizeProjectName("a\u0000b\u007fc")).toBe("abc");
      const long = "名".repeat(PROJECT_NAME_MAX_CHARS + 10);
      expect(normalizeProjectName(long)).toHaveLength(PROJECT_NAME_MAX_CHARS);
    });
  });

  it("未设置时回退目录名", () => {
    expect(projectDisplayNameFor("/work/demo")).toBeNull();
    expect(projectLabelFor("/work/demo")).toBe("demo");
  });

  it("设置、覆盖与清除", () => {
    setProjectDisplayName("/work/demo", "前台");
    expect(projectDisplayNameFor("/work/demo")).toBe("前台");
    expect(projectLabelFor("/work/demo")).toBe("前台");

    setProjectDisplayName("/work/demo", " 新名字 ");
    expect(projectDisplayNameFor("/work/demo")).toBe("新名字");

    setProjectDisplayName("/work/demo", null);
    expect(projectDisplayNameFor("/work/demo")).toBeNull();
    expect(projectLabelFor("/work/demo")).toBe("demo");
  });

  it("从 localStorage 水合并落盘", () => {
    const store = installStorageStub({
      "project-display-name-v1": JSON.stringify({
        "/work/demo": "  后台项目 ",
        "/work/broken": 3,
      }),
    });
    expect(projectDisplayNameFor("/work/demo")).toBe("后台项目");
    expect(projectDisplayNameFor("/work/broken")).toBeNull();

    setProjectDisplayName("/work/broken", "修复");
    const persisted = JSON.parse(
      store.get("project-display-name-v1") ?? "{}",
    ) as Record<string, string>;
    expect(persisted["/work/demo"]).toBe("后台项目");
    expect(persisted["/work/broken"]).toBe("修复");
  });
});
