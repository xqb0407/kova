import { describe, expect, test } from "bun:test";
import {
  emitSubagentYaml,
  parseSubagentDraftYaml,
  parseSubagentYaml,
} from "../../src/subagent/subagent-definitions";

describe("UHP subagent definitions", () => {
  const yaml = [
    'name: "external-reviewer"',
    'description: "External UHP harness"',
    "backend: uhp",
    "uhp:",
    "  server: harnessrouter-local",
    "  harness: chrn_abc",
    "  model: openai/gpt-5",
    'prompt: "Review the change."',
    "",
  ].join("\n");

  test("parses backend=uhp without local tools", () => {
    const parsed = parseSubagentYaml(yaml, { scope: "system" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.backend).toBe("uhp");
    expect(parsed.definition.tools).toEqual([]);
    expect(parsed.definition.uhp).toEqual({
      server: "harnessrouter-local",
      harness: "chrn_abc",
      model: "openai/gpt-5",
    });
  });

  test("YAML view round-trips backend and uhp", () => {
    const parsed = parseSubagentDraftYaml(yaml, "system");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const emitted = emitSubagentYaml(parsed.draft);
    const again = parseSubagentYaml(emitted, { scope: "system" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.definition.backend).toBe("uhp");
    expect(again.definition.uhp).toEqual(parsed.draft.uhp);
  });

  test("local definitions still require a tool", () => {
    const parsed = parseSubagentYaml(
      ['name: local', 'description: local', 'prompt: "Do it."', ""].join("\n"),
      { scope: "system" },
    );
    expect(parsed.ok).toBe(false);
  });
});
