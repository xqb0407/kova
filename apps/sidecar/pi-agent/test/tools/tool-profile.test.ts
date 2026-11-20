import { afterEach, describe, expect, test } from "bun:test";
import { buildTools } from "../../src/tools/tools";
import {
  applyToolProfile,
  CODING_PROFILE_DROPPED_TOOLS,
  getToolProfile,
  isDroppedInCodingProfile,
  resetToolProfileForTest,
} from "../../src/tools/tool-profile";
import { resetVisionToolConfigForTest } from "../../src/tools/vision-tool-config";

afterEach(() => {
  resetToolProfileForTest();
  resetVisionToolConfigForTest();
});

describe("tool profile 的工具面收敛", () => {
  test("full（默认）：桌面/资料类工具都在工具表", () => {
    const names = buildTools("/tmp", "t-profile").map((tool) => tool.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("kb_search");
    expect(names).toContain("open_file");
    // screenshot/generate_image/search_external_files 由各自配置开关/附加目录
    // 条件注入（测试环境默认关），不在此断言
  });

  test("coding：只收创作/辅助类工具，调试与编码主干全保留", () => {
    resetToolProfileForTest("coding");
    const names = buildTools("/tmp", "t-profile").map((tool) => tool.name);
    for (const dropped of ["generate_image", "open_plugin_panel"]) {
      expect(names).not.toContain(dropped);
    }
    // 调试刚需与编码主干一律保留
    for (const kept of [
      "browser_navigate",
      "kb_search",
      "open_file",
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "todo",
      "WebFetch",
    ]) {
      expect(names).toContain(kept);
    }
    expect(getToolProfile()).toBe("coding");
  });

  test("isDroppedInCodingProfile：仅创作/辅助类清单", () => {
    for (const name of CODING_PROFILE_DROPPED_TOOLS) {
      expect(isDroppedInCodingProfile(name)).toBe(true);
    }
    expect(isDroppedInCodingProfile("browser_click")).toBe(false);
    expect(isDroppedInCodingProfile("browsers")).toBe(false);
    expect(isDroppedInCodingProfile("bash")).toBe(false);
    expect(isDroppedInCodingProfile("edit")).toBe(false);
  });

  test("applyToolProfile 更新内存态（kv 落盘失败不阻断），未知值回落 full", async () => {
    expect(await applyToolProfile("coding")).toBe("coding");
    expect(getToolProfile()).toBe("coding");
    expect(await applyToolProfile({ profile: "full" })).toBe("full");
    expect(getToolProfile()).toBe("full");
    expect(await applyToolProfile("bogus")).toBe("full");
    expect(getToolProfile()).toBe("full");
  });
});
