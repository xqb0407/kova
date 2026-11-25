import { describe, expect, test } from "bun:test";
import {
  coreCapabilities,
  conformanceClassFor,
  disabledCapabilities,
  extendedCapabilities,
  fullCapabilities,
} from "../src/capabilities";
import { UHP_CAPABILITY_KEYS } from "../src/types";

describe("capability maps", () => {
  test("all capability keys are always present", () => {
    for (const caps of [
      coreCapabilities(),
      extendedCapabilities(),
      fullCapabilities(),
    ]) {
      expect(Object.keys(caps).sort()).toEqual([...UHP_CAPABILITY_KEYS].sort());
      for (const key of UHP_CAPABILITY_KEYS) expect(typeof caps[key]).toBe("boolean");
    }
  });

  test("extended requires files and session listing", () => {
    expect(conformanceClassFor(coreCapabilities())).toBe("core");
    expect(conformanceClassFor(extendedCapabilities())).toBe("extended");
    expect(conformanceClassFor(fullCapabilities())).toBe("full");
  });

  test("false capabilities are reported explicitly", () => {
    const disabled = disabledCapabilities(extendedCapabilities());
    expect(disabled).toContain("harness_management");
    expect(disabled).toContain("session_sharing");
    expect(disabled).not.toContain("files_input");
  });

  test("overrides cannot silently erase required class capabilities", () => {
    const caps = extendedCapabilities({ files_output: false });
    expect(conformanceClassFor(caps)).toBe("core");
  });
});
