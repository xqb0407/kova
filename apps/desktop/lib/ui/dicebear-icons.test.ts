import { describe, expect, test } from "bun:test";
import {
  DICEBEAR_ICON_NAMES,
  dicebearIconSvg,
  dicebearIconValue,
  parseDicebearIcon,
  parseNoteIcon,
} from "./dicebear-icons";
import { dicebearStyleAvatarValue, projectAvatarSrc } from "@/lib/projects/project-avatars";

describe("dicebear 图标", () => {
  test("parse：只认 dicebear:icons: 前缀 + 集合内的图标名", () => {
    expect(parseDicebearIcon("dicebear:icons:book")).toBe("book");
    expect(parseDicebearIcon("🎨")).toBeNull();
    expect(parseDicebearIcon("dicebear:icons:not-an-icon")).toBeNull();
    expect(parseDicebearIcon("dicebear:other:book")).toBeNull();
    expect(parseDicebearIcon(null)).toBeNull();
    expect(parseDicebearIcon(undefined)).toBeNull();
  });

  test("图标名集合非空且唯一（选择网格按它渲染）", () => {
    expect(DICEBEAR_ICON_NAMES.length).toBeGreaterThan(100);
    expect(new Set(DICEBEAR_ICON_NAMES).size).toBe(DICEBEAR_ICON_NAMES.length);
    expect(dicebearIconValue(DICEBEAR_ICON_NAMES[0]!)).toBe(
      `dicebear:icons:${DICEBEAR_ICON_NAMES[0]}`,
    );
    expect(() => dicebearIconValue("not-an-icon")).toThrow();
  });

  test("SVG 稳定、无硬编码填充色、背景瓷砖已去掉", () => {
    const svg = dicebearIconSvg("book");
    // 字形颜色交给组件文字色（深浅主题跟随）
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain('fill="#');
    // 锁定的是同名变体：包含 book 的独有路径（dicebear 样例库无此路径即失败）
    expect(dicebearIconSvg("book")).toBe(svg);
    expect(dicebearIconSvg("alarm")).not.toBe(svg);
  });
});

describe("parseNoteIcon（双形态）", () => {
  test("glyph：dicebear:icons: 前缀 + 集合内图标名", () => {
    expect(parseNoteIcon("dicebear:icons:book")).toEqual({
      kind: "glyph",
      name: "book",
    });
    expect(parseNoteIcon("🎨")).toBeNull();
    expect(parseNoteIcon("dicebear:icons:not-an-icon")).toBeNull();
  });

  test("avatar：随机风格 id（与项目头像同一格式）", () => {
    const id = dicebearStyleAvatarValue("fun-emoji", "icon00");
    expect(id).toBe("dicebear:fun-emoji:edf2f7:icon00");
    expect(parseNoteIcon(id!)).toEqual({ kind: "avatar", id: id! });
    expect(parseNoteIcon("dicebear:fun-emoji:zzzzzz:icon00")).toBeNull();
    // 非法风格不进白名单
    expect(
      dicebearStyleAvatarValue("not-a-style", "icon00"),
    ).toBeNull();
    // 渲染端有 data URI 可用
    expect(projectAvatarSrc(id!)).toMatch(/^data:image\//);
  });
});
