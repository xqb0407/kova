import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog } from "../../../../scripts/build-changelog.mjs";
import {
  CHANGELOG_ENTRIES,
  CHANGELOG_ENTRIES_EN,
} from "./generated";
import { changelogForLocale, entryForVersion } from "./index";

const ROOT = join(import.meta.dir, "../../../..");

describe("CHANGELOG 解析", () => {
  it("解析版本、导语、分区、折行与 Unreleased 跳过", () => {
    const entries = parseChangelog(`# Changelog

## [Unreleased]

### Added

- 未发布的条目

## [1.0.0] - 2026-01-02

首个正式版。

### Added

- 支持 **粗体** 与 \`code\`
  续行内容
### Fixed

- 修复 A
`);

    expect(entries).toEqual([
      {
        version: "1.0.0",
        date: "2026-01-02",
        intro: "首个正式版。",
        sections: [
          {
            title: "Added",
            items: ["支持 **粗体** 与 `code` 续行内容"],
          },
          { title: "Fixed", items: ["修复 A"] },
        ],
      },
    ]);
  });

  it("折行拼接：英文补空格，中文全角标点后不补", () => {
    const entries = parseChangelog(`## [1.0.0] - 2026-01-01
### Added
- English words
  continue here
- 中文标点后
  接英文 arm64
- English dash —
  compatible
`);
    expect(entries[0]?.sections[0]?.items).toEqual([
      "English words continue here",
      "中文标点后接英文 arm64",
      "English dash — compatible",
    ]);
  });

  it("生成文件与 CHANGELOG.md 保持一致", () => {
    const markdown = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(parseChangelog(markdown)).toEqual([...CHANGELOG_ENTRIES]);
  });

  it("英文生成文件与 CHANGELOG_EN.md 一致，版本与中文一一对应", () => {
    const markdown = readFileSync(join(ROOT, "CHANGELOG_EN.md"), "utf8");
    const entries = parseChangelog(markdown);
    expect(entries).toEqual([...CHANGELOG_ENTRIES_EN]);
    expect(entries.map((entry) => entry.version)).toEqual(
      CHANGELOG_ENTRIES.map((entry) => entry.version),
    );
  });

  it("按界面语言取日志；未知语言回落中文", () => {
    expect(changelogForLocale("en")).toBe(CHANGELOG_ENTRIES_EN);
    expect(changelogForLocale("zh")).toBe(CHANGELOG_ENTRIES);
    expect(changelogForLocale("fr")).toBe(CHANGELOG_ENTRIES);
    expect(entryForVersion("1.2.0", "en")?.intro).toBe(
      "First open-source stable release.",
    );
    expect(entryForVersion("1.2.0")?.intro).toBe("首个开源正式版。");
  });

  it("正式版的最新一条日志就是当前应用版本", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "apps/desktop/package.json"), "utf8"),
    ) as { version: string };
    // preview 迭代不强制写 CHANGELOG；正式版必须能对上，升级弹窗才有内容
    if (!pkg.version.includes("-")) {
      expect(CHANGELOG_ENTRIES[0]?.version).toBe(pkg.version);
    }
  });

  it("版本倒序且不重复", () => {
    const versions = CHANGELOG_ENTRIES.map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
    const score = (version: string): number[] =>
      version.split(".").map((part) => Number.parseInt(part, 10));
    for (let i = 1; i < versions.length; i += 1) {
      const newer = score(versions[i - 1]!);
      const older = score(versions[i]!);
      expect(
        newer[0]! > older[0]! ||
          (newer[0] === older[0] && newer[1]! > older[1]!) ||
          (newer[0] === older[0] &&
            newer[1] === older[1] &&
            newer[2]! > older[2]!),
      ).toBe(true);
    }
  });
});
