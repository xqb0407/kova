import { describe, expect, test } from "bun:test";
import {
  createHarness,
  discoveryDocument,
  isContainerId,
  isFileId,
  isHarnessId,
  isResponseId,
  isSessionId,
  kovaSessionIdFrom,
  newContainerId,
  newFileId,
  newHarnessId,
  newResponseId,
  uhpSessionIdFor,
} from "../src/ids";
import { extendedCapabilities } from "../src/capabilities";

describe("UHP ids", () => {
  test("prefixes match the protocol", () => {
    expect(isResponseId(newResponseId())).toBe(true);
    expect(isHarnessId(newHarnessId())).toBe(true);
    expect(isFileId(newFileId())).toBe(true);
    expect(isContainerId(newContainerId())).toBe(true);
  });

  test("session id round-trips to a Kova session id", () => {
    const uhp = uhpSessionIdFor("abc-123");
    expect(uhp).toBe("hsess_abc-123");
    expect(isSessionId(uhp)).toBe(true);
    expect(kovaSessionIdFrom(uhp)).toBe("abc-123");
    expect(kovaSessionIdFrom("nope")).toBeNull();
  });

  test("createHarness fills required fields", () => {
    const harness = createHarness({
      id: "chrn_test",
      name: "Test",
      base: "kova-pi-agent",
      defaultModel: "openai/gpt-5",
      createdAt: 1,
    });
    expect(harness.object).toBe("harness");
    expect(harness.defaultModel).toBe("openai/gpt-5");
    expect(harness.createdAt).toBe(1);
  });

  test("discovery advertises only the supported version", () => {
    const discovery = discoveryDocument({
      capabilities: extendedCapabilities(),
      conformanceClass: "extended",
      implementation: { name: "kova" },
    });
    expect(discovery.object).toBe("uhp.discovery");
    expect(discovery.protocol).toBe("uhp");
    expect(discovery.versions).toEqual(["2026-10-19"]);
    expect(discovery.default_version).toBe("2026-10-19");
    expect(discovery.conformance_class).toBe("extended");
    expect(discovery.implementation?.name).toBe("kova");
    expect(discovery.plugin_schemas).toBeUndefined();
  });
});
