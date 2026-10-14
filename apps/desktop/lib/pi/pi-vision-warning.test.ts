import { describe, expect, test } from "bun:test";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import {
  imageSupportFromMetadata,
  shouldWarnUnsupportedImages,
} from "@/lib/pi/pi-vision-warning";

/**
 * 发图能力提示的判定测试。钉住四条语义：
 * 1. 元数据明确排除图像（input 存在且不含 "image"）且本次发送含图 → 提示；
 * 2. input 缺失不判定（元数据不可靠是移除 sidecar 硬门的原委，桌面提示同样
 *    宁缺勿误报）；
 * 3. 目录为空（未加载/远程模式）不判定——与 pi-model-gate 同口径；
 * 4. 目录里按 gate 同口径找不到选择（无凭据/被过滤隐藏/已删）不判定。
 */

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

const selected = { provider: "custom-qoder", modelId: "qfmodel" };

describe("imageSupportFromMetadata", () => {
  test("input 明确排除图像 → false；含 image → true", () => {
    expect(imageSupportFromMetadata(model({ input: ["text"] }))).toBe(false);
    expect(imageSupportFromMetadata(model({ input: ["text", "image"] }))).toBe(
      true,
    );
  });

  test("input 缺失或模型不存在 → null（不判定）", () => {
    expect(imageSupportFromMetadata(model({}))).toBeNull();
    expect(imageSupportFromMetadata(undefined)).toBeNull();
    expect(imageSupportFromMetadata(null)).toBeNull();
  });
});

describe("shouldWarnUnsupportedImages", () => {
  test("含图 + 选中的纯文本模型 → 提示", () => {
    expect(
      shouldWarnUnsupportedImages(true, selected, [model({ input: ["text"] })]),
    ).toBe(true);
  });

  test("不含图 / 未选模型 → 不提示", () => {
    const models = [model({ input: ["text"] })];
    expect(shouldWarnUnsupportedImages(false, selected, models)).toBe(false);
    expect(shouldWarnUnsupportedImages(true, null, models)).toBe(false);
  });

  test("视觉模型不提示；input 缺失的模型不提示（宁缺勿误报）", () => {
    expect(
      shouldWarnUnsupportedImages(true, selected, [
        model({ input: ["text", "image"] }),
      ]),
    ).toBe(false);
    expect(shouldWarnUnsupportedImages(true, selected, [model({})])).toBe(
      false,
    );
  });

  test("空目录不判定（未加载/远程模式）", () => {
    expect(shouldWarnUnsupportedImages(true, selected, [])).toBe(false);
  });

  test("按 gate 同口径找不到选择就不判定：无凭据/被隐藏/目录里没有", () => {
    expect(
      shouldWarnUnsupportedImages(true, selected, [
        model({ input: ["text"], authed: false }),
      ]),
    ).toBe(false);
    expect(
      shouldWarnUnsupportedImages(true, selected, [
        model({ input: ["text"], enabled: false }),
      ]),
    ).toBe(false);
    expect(
      shouldWarnUnsupportedImages(true, selected, [
        model({ input: ["text"], id: "other-model" }),
      ]),
    ).toBe(false);
  });
});
