import { describe, expect, test } from "bun:test";
import type { ProjectRecord } from "@/lib/pi/pi-projects";
import { resolveLastUsedWorkspace } from "./last-used";

/**
 * 最近项目解析：项目还在 → 恢复；项目删除/目录不再属于项目 → 留空。
 * 纯函数测试，不依赖桌面桥/侧车。
 */

function project(id: string, folders: string[]): ProjectRecord {
  return {
    id,
    displayName: id,
    nameIsCustom: true,
    appearanceJson: null,
    createdAt: "",
    updatedAt: "",
    archived: false,
    showWhenEmpty: false,
    hiddenFromSidebar: false,
    folders: folders.map((path, index) => ({
      path,
      sortOrder: index,
      isPrimary: index === 0,
    })),
  };
}

const projects = [
  project("p1", ["/work/p1", "/work/p1-extra"]),
  project("p2", ["/work/p2"]),
];

const noRemote = () => null;

describe("resolveLastUsedWorkspace", () => {
  test("项目 id 还在：保留用户选过的目录", () => {
    expect(
      resolveLastUsedWorkspace(
        { dir: "/work/p1-extra", projectId: "p1" },
        projects,
        noRemote,
      ),
    ).toEqual({ dir: "/work/p1-extra", projectId: "p1" });
  });

  test("项目 id 还在但目录已移除：回落项目主目录", () => {
    expect(
      resolveLastUsedWorkspace(
        { dir: "/work/gone-folder", projectId: "p1" },
        projects,
        noRemote,
      ),
    ).toEqual({ dir: "/work/p1", projectId: "p1" });
  });

  test("项目 id 不在了但路径属于另一个项目：用匹配到的项目", () => {
    expect(
      resolveLastUsedWorkspace(
        { dir: "/work/p2", projectId: "p-deleted" },
        projects,
        noRemote,
      ),
    ).toEqual({ dir: "/work/p2", projectId: "p2" });
  });

  test("远程项目路径仍然有效：保持远程路径", () => {
    expect(
      resolveLastUsedWorkspace(
        { dir: "/remote/workspace", projectId: null },
        projects,
        (path) =>
          path === "/remote/workspace" ? { remotePath: "/remote/workspace" } : null,
      ),
    ).toEqual({ dir: "/remote/workspace", projectId: null });
  });

  test("项目已删除/路径不再属于任何项目：留空", () => {
    expect(
      resolveLastUsedWorkspace(
        { dir: "/work/deleted", projectId: "p-deleted" },
        projects,
        noRemote,
      ),
    ).toBeNull();
  });
});
