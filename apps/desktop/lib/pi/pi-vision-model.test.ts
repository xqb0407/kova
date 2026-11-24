import { describe, expect, test } from "bun:test";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import {
  isImageInputUnknown,
  isTextOnlyModel,
  isUsableVisionModel,
} from "@/lib/pi/pi-vision-model";

const model = (over: Partial<PiModelSummary>): PiModelSummary => ({
  provider: "custom-qoder",
  providerName: "Qoder",
  id: "qfmodel",
  name: "QF Model",
  reasoning: false,
  contextWindow: 128_000,
  authed: true,
  ...over,
});

const visionModel = model({
  provider: "vision-p",
  id: "vision-m",
  input: ["text", "image"],
  supportsImage: true,
});

describe("isUsableVisionModel", () => {
  test("凭据 + 可见 + 明确支持图像 + 非文生图 才算可用", () => {
    expect(isUsableVisionModel(visionModel)).toBe(true);
    expect(isUsableVisionModel(model({ ...visionModel, authed: false }))).toBe(false);
    expect(isUsableVisionModel(model({ ...visionModel, enabled: false }))).toBe(false);
    expect(isUsableVisionModel(model({ ...visionModel, t2i: true }))).toBe(false);
    expect(
      isUsableVisionModel(model({ input: ["text"], supportsImage: false })),
    ).toBe(false);
    expect(
      isUsableVisionModel(model({ input: ["text"], supportsImage: null })),
    ).toBe(false);
    expect(
      isUsableVisionModel(model({ input: undefined, supportsImage: undefined })),
    ).toBe(false);
  });

  test("supportsImage 缺省时回退 input（旧 sidecar 兼容）", () => {
    expect(isUsableVisionModel(model({ input: ["text", "image"] }))).toBe(true);
    expect(isUsableVisionModel(model({ input: ["text"] }))).toBe(false);
  });
});

describe("isTextOnlyModel / isImageInputUnknown", () => {
  test("只有明确 false 才算纯文本；null 是未知", () => {
    expect(isTextOnlyModel(model({ input: ["text"], supportsImage: false }))).toBe(true);
    expect(isTextOnlyModel(model({ input: ["text"], supportsImage: null }))).toBe(false);
    expect(isTextOnlyModel(model({ input: ["text", "image"], supportsImage: true }))).toBe(false);
    // 字段缺失回退 input
    expect(isTextOnlyModel(model({ input: ["text"] }))).toBe(true);
    expect(isTextOnlyModel(model({ input: ["text", "image"] }))).toBe(false);
    expect(isTextOnlyModel(model({ input: undefined }))).toBe(false);
    expect(isTextOnlyModel(null)).toBe(false);
    expect(isTextOnlyModel(undefined)).toBe(false);
  });

  test("未知能力只由显式 null 判定", () => {
    expect(isImageInputUnknown(model({ supportsImage: null }))).toBe(true);
    expect(isImageInputUnknown(model({ supportsImage: false }))).toBe(false);
    expect(isImageInputUnknown(model({ supportsImage: true }))).toBe(false);
    expect(isImageInputUnknown(model({ input: ["text"] }))).toBe(false);
    expect(isImageInputUnknown(null)).toBe(false);
  });
});
