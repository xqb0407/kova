import { describe, expect, it } from "bun:test";
import {
  searchSettings,
  SETTINGS_SEARCH_PAGE_SECTIONS,
} from "./settings-search";
import { SETTINGS_SECTION_LABEL_KEYS } from "./settings-sections";

describe("searchSettings", () => {
  it("空查询不返回结果", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  it("中文能命中设置行与所属页面", () => {
    const hits = searchSettings("代理");
    const sections = new Set(hits.map((hit) => hit.section));
    expect(sections.has("network-proxy")).toBe(true);
    expect(
      hits.some((hit) => hit.section === "network-proxy" && hit.zh.includes("代理")),
    ).toBe(true);
  });

  it("英文能命中对应分类", () => {
    const hits = searchSettings("proxy");
    expect(hits.some((hit) => hit.section === "network-proxy")).toBe(true);
    expect(hits.some((hit) => hit.section === "access-accel")).toBe(false);
  });

  it("webhook 命中 Webhooks 页面", () => {
    const hits = searchSettings("webhook");
    expect(hits[0]?.section).toBe("webhooks");
  });

  it("网页搜索命中独立的 websearch 分区", () => {
    const hits = searchSettings("网页搜索");
    expect(hits[0]?.section).toBe("websearch");
  });

  it("合并后的菜单名也能搜到，且紧凑写法可命中", () => {
    expect(searchSettings("网络与 SSH")[0]?.section).toBe("access-accel");
    expect(searchSettings("网络与SSH")[0]?.section).toBe("access-accel");
    expect(searchSettings("收件箱与 Webhook")[0]?.section).toBe("inbox-sources");
    expect(searchSettings("收件箱与Webhook")[0]?.section).toBe("inbox-sources");
  });

  it("合并入口与成员页同文案时不产生重复页面条目", () => {
    const pages = searchSettings("模型", 100).filter(
      (hit) => hit.isPage && hit.section === "models",
    );
    expect(pages).toHaveLength(1);
  });

  it("多关键词按 AND 过滤", () => {
    const hits = searchSettings("网络 代理");
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const text = `${hit.zh} ${hit.en} ${hit.keywords.join(" ")}`.toLowerCase();
      expect(text).toContain("网络");
      expect(text).toContain("代理");
    }
  });

  it("命中结果受 limit 限制", () => {
    expect(searchSettings("设置", 3).length).toBeLessThanOrEqual(3);
  });
});

describe("设置搜索索引覆盖", () => {
  it("每个可搜索分区都有页面条目且标签非空", () => {
    for (const section of SETTINGS_SEARCH_PAGE_SECTIONS) {
      const hits = searchSettings(SETTINGS_SECTION_LABEL_KEYS[section].split(".").at(-1)!);
      const page = hits.find((hit) => hit.section === section && hit.isPage);
      expect(page, `missing page entry for ${section}`).toBeDefined();
      expect(page?.zh.length).toBeGreaterThan(0);
      expect(page?.en.length).toBeGreaterThan(0);
    }
  });

  it("设置行（非页面）也进入索引", () => {
    const hits = searchSettings("代理地址");
    expect(hits.some((hit) => !hit.isPage && hit.section === "network-proxy")).toBe(true);
  });

  it("页面条目排在同类普通条目前面", () => {
    const hits = searchSettings("网页搜索");
    const pageIndex = hits.findIndex((hit) => hit.isPage && hit.section === "websearch");
    const leafIndex = hits.findIndex((hit) => !hit.isPage && hit.section === "websearch");
    expect(pageIndex).toBeGreaterThanOrEqual(0);
    expect(leafIndex).toBeGreaterThanOrEqual(0);
    expect(pageIndex).toBeLessThan(leafIndex);
  });
});
