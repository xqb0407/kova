import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PTC_CONFIG,
  getPtcConfig,
  normalizePtcConfig,
  resetPtcConfigForTest,
} from "../../src/tools/ptc-config";

describe("ptc-config", () => {
  test("defaults to disabled", () => {
    expect(DEFAULT_PTC_CONFIG.enabled).toBe(false);
    resetPtcConfigForTest();
    expect(getPtcConfig().enabled).toBe(false);
  });

  test("normalizes booleans and falls back on bad input", () => {
    expect(normalizePtcConfig({ enabled: true })).toEqual({ enabled: true });
    expect(normalizePtcConfig({ enabled: "yes" })).toEqual({ enabled: false });
    expect(normalizePtcConfig(null)).toEqual({ enabled: false });
    expect(normalizePtcConfig("nope")).toEqual({ enabled: false });
  });
});
