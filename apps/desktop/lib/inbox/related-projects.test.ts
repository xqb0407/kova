import { describe, expect, test } from "bun:test";
import type { InboxItem } from "pi-protocol";
import type { ProjectRecord } from "@/lib/pi/pi-projects";
import {
  matchProject,
  relatedSessionsForProject,
} from "./related-projects";

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    displayName: "Kova",
    nameIsCustom: true,
    appearanceJson: null,
    createdAt: "",
    updatedAt: "",
    archived: false,
    showWhenEmpty: false,
    hiddenFromSidebar: false,
    folders: [{ path: "/work/kova", sortOrder: 0, isPrimary: true }],
    ...overrides,
  };
}

function externalItem(key: string, sourceName?: string): InboxItem {
  return {
    id: `external:github:${key}`,
    kind: "external",
    external: { provider: "github", key, sourceName },
  } as unknown as InboxItem;
}

describe("matchProject", () => {
  test("按项目显示名匹配", () => {
    expect(
      matchProject(externalItem("acme/kova#12", "acme/kova"), [project()])?.id,
    ).toBe("p1");
  });

  test("按目录 basename 兜底", () => {
    const p = project({ displayName: "Monorepo" });
    expect(
      matchProject(externalItem("acme/kova#12", "acme/kova"), [p])?.id,
    ).toBe("p1");
  });

  test("无 repo 信息时不硬匹配", () => {
    expect(
      matchProject(externalItem("PAY-1", undefined), [project()]),
    ).toBeNull();
  });
});

describe("relatedSessionsForProject", () => {
  const cwdMap = new Map([
    ["s1", "/work/kova"],
    ["s2", "/work/kova/packages/app"],
    ["s3", "/work/other"],
    ["s4", "/work/kova/../other"],
  ]);
  const items = [
    { id: "t1", remoteId: "s1", title: "Root", status: "regular", lastMessageAt: new Date(100) },
    { id: "t2", remoteId: "s2", title: "Nested", status: "regular", lastMessageAt: new Date(200) },
    { id: "t3", remoteId: "s3", title: "Other", status: "regular", lastMessageAt: new Date(300) },
    { id: "t4", remoteId: "s4", title: "Archived", status: "archived", lastMessageAt: new Date(400) },
    { id: "t5", remoteId: "s5", title: "Missing cwd", status: "regular", lastMessageAt: new Date(500) },
  ];

  test("只取项目目录内、regular 且在 cwdMap 里的会话，按最近排序", () => {
    const related = relatedSessionsForProject(project(), items, cwdMap);
    expect(related.map((entry) => entry.id)).toEqual(["s2", "s1"]);
  });

  test("limit 截断", () => {
    const related = relatedSessionsForProject(project(), items, cwdMap, 1);
    expect(related.map((entry) => entry.id)).toEqual(["s2"]);
  });

  test("没有项目/目录时返回空", () => {
    expect(relatedSessionsForProject(null, items, cwdMap)).toEqual([]);
    expect(
      relatedSessionsForProject(project({ folders: [] }), items, cwdMap),
    ).toEqual([]);
  });
});
