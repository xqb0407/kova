import { describe, expect, test } from "bun:test";
import {
  findRemoteProjectConflict,
  normalizeRemotePath,
  type RemoteProject,
} from "./remote-projects";

const base = {
  hostId: "host-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const projects: RemoteProject[] = [
  {
    ...base,
    id: "rp-1",
    name: "示例项目",
    hostId: "host-1",
    remotePath: "/home/me/demo",
  },
  {
    ...base,
    id: "rp-2",
    name: "Docs",
    hostId: "host-1",
    remotePath: "/home/me/docs",
  },
  {
    ...base,
    id: "rp-3",
    name: "Same name other host",
    hostId: "host-2",
    remotePath: "/home/me/demo",
  },
];

describe("远程项目冲突检查", () => {
  test("路径规范化只影响比较，不吞掉根目录", () => {
    expect(normalizeRemotePath("/home/me/demo/")).toEqual("/home/me/demo");
    expect(normalizeRemotePath("/")).toEqual("/");
    expect(normalizeRemotePath("  ")).toEqual("/");
  });

  test("同名（忽略大小写）拒绝，编辑自身不冲突", () => {
    expect(
      findRemoteProjectConflict(projects, {
        name: "示例项目",
        hostId: "host-1",
        remotePath: "/elsewhere",
      })?.kind,
    ).toEqual("name");
    expect(
      findRemoteProjectConflict(projects, {
        name: "docs",
        hostId: "host-1",
        remotePath: "/elsewhere",
      })?.kind,
    ).toEqual("name");
    expect(
      findRemoteProjectConflict(projects, {
        id: "rp-2",
        name: "Docs",
        hostId: "host-1",
        remotePath: "/home/me/docs",
      }),
    ).toEqual(null);
  });

  test("同主机同远端路径拒绝（尾斜杠等价），不同主机允许", () => {
    const conflict = findRemoteProjectConflict(projects, {
      name: "另一个名字",
      hostId: "host-1",
      remotePath: "/home/me/demo/",
    });
    expect(conflict?.kind).toEqual("path");
    expect(conflict?.project.id).toEqual("rp-1");
    expect(
      findRemoteProjectConflict(projects, {
        name: "另一个名字",
        hostId: "host-2",
        remotePath: "/home/me/docs",
      }),
    ).toEqual(null);
  });
});
