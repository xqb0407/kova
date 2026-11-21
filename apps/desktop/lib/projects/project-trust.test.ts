import { afterAll, describe, expect, test, beforeEach } from "bun:test";
import {
  isProjectFolderTrusted,
  trustProjectFolders,
  untrustedProjectFolders,
} from "./project-trust";

const store = new Map<string, string>();
const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};

afterAll(() => {
  // 还原全局桩，避免影响同一测试进程内的其它文件
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  } else {
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  }
});

describe("工作区文件夹信任", () => {
  beforeEach(() => store.clear());

  test("默认未信任；确认后按路径记忆（尾斜杠等价）", () => {
    expect(isProjectFolderTrusted("/work/a")).toEqual(false);
    expect(untrustedProjectFolders(["/work/a", "/work/b"])).toEqual([
      "/work/a",
      "/work/b",
    ]);
    trustProjectFolders(["/work/a/"]);
    expect(isProjectFolderTrusted("/work/a")).toEqual(true);
    expect(untrustedProjectFolders(["/work/a", "/work/b"])).toEqual([
      "/work/b",
    ]);
  });

  test("同一输入里的重复路径只提醒一次", () => {
    expect(untrustedProjectFolders(["/work/a", "/work/a/"])).toEqual([
      "/work/a",
    ]);
  });
});
