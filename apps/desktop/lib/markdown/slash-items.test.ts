import { describe, expect, it } from "bun:test";
import {
  filterSlashItems,
  SLASH_ITEM_DEFS,
  type SlashFilterItem,
} from "./slash-items";

const items: SlashFilterItem[] = [
  {
    id: "paragraph",
    label: "正文",
    description: "普通正文段落",
    keywords: ["text", "p"],
  },
  { id: "heading1", label: "标题 1", keywords: ["h1", "title"] },
  { id: "heading2", label: "标题 2", keywords: ["h2"] },
  {
    id: "taskList",
    label: "待办列表",
    description: "可勾选的待办清单",
    keywords: ["todo", "check"],
  },
];

describe("filterSlashItems", () => {
  it("空查询返回全部且保持原顺序", () => {
    expect(filterSlashItems(items, "")).toEqual(items);
    expect(filterSlashItems(items, " / ")).toEqual(items);
  });

  it("按中文标签前缀优先", () => {
    expect(filterSlashItems(items, "标题").map((i) => i.id)).toEqual([
      "heading1",
      "heading2",
    ]);
  });

  it("按英文别名命中", () => {
    expect(filterSlashItems(items, "todo").map((i) => i.id)).toEqual([
      "taskList",
    ]);
    expect(filterSlashItems(items, "h1").map((i) => i.id)).toEqual([
      "heading1",
    ]);
  });

  it("标签包含优先于关键词包含", () => {
    const result = filterSlashItems(items, "列表");
    expect(result.map((i) => i.id)).toEqual(["taskList"]);
  });

  it("无匹配返回空数组", () => {
    expect(filterSlashItems(items, "zzz")).toEqual([]);
  });

  it("也能按说明匹配", () => {
    expect(filterSlashItems(items, "勾选").map((i) => i.id)).toEqual([
      "taskList",
    ]);
  });

  it("内置项都有唯一 id、label/description/section", () => {
    const ids = SLASH_ITEM_DEFS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of SLASH_ITEM_DEFS) {
      expect(item.labelKey.startsWith("library.editor.block.")).toBe(true);
      expect(item.descriptionKey.startsWith("library.editor.slash.desc.")).toBe(
        true,
      );
      expect(["basic", "media", "advanced"]).toContain(item.section);
    }
  });
});
