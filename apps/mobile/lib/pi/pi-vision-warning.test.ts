import { describe, expect, test } from "vitest";
import {
  hasUsableVisionModel,
  imageSupportFromMetadata,
  shouldWarnUnsupportedImages,
} from "./pi-vision-warning";

/**
 * 移动端发图能力提示的判定测试（与桌面 pi-vision-warning.test.ts 同口径）。
 * 钉住：元数据明确排除图像才提示；视觉辅助开关开且有可用视觉模型时不误报
 * （模型可调 see_image 看图）；enabled 参数可显式覆写（模块镜像缺省关）。
 */

const model = (over: Partial<import("./pi-bridge").PiModelSummary>) => ({
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
const visionModel = model({
  provider: "vision-p",
  id: "vision-m",
  input: ["text", "image"],
});

describe("imageSupportFromMetadata", () => {
  test("input 明确排除图像 → false；含 image → true；缺失 → null", () => {
    expect(imageSupportFromMetadata(model({ input: ["text"] }))).toBe(false);
    expect(imageSupportFromMetadata(model({ input: ["text", "image"] }))).toBe(true);
    expect(imageSupportFromMetadata(model({}))).toBeNull();
    expect(imageSupportFromMetadata(undefined)).toBeNull();
  });
});

describe("hasUsableVisionModel", () => {
  test("凭据 + 可见 + 图像输入 + 非文生图 才算可用", () => {
    expect(hasUsableVisionModel([visionModel])).toBe(true);
    expect(hasUsableVisionModel([model({ ...visionModel, authed: false })])).toBe(false);
    expect(hasUsableVisionModel([model({ ...visionModel, enabled: false })])).toBe(false);
    expect(hasUsableVisionModel([model({ ...visionModel, t2i: true })])).toBe(false);
    expect(hasUsableVisionModel([])).toBe(false);
  });
});

describe("shouldWarnUnsupportedImages", () => {
  test("含图 + 选中纯文本模型 → 提示；不含图/未选模型 → 不提示", () => {
    expect(shouldWarnUnsupportedImages(true, selected, [model({ input: ["text"] })])).toBe(true);
    expect(shouldWarnUnsupportedImages(false, selected, [model({ input: ["text"] })])).toBe(false);
    expect(shouldWarnUnsupportedImages(true, null, [model({ input: ["text"] })])).toBe(false);
  });

  test("开关开 + 有可用视觉模型 → 不提示；开关关 → 仍提示", () => {
    const models = [model({ input: ["text"] }), visionModel];
    expect(shouldWarnUnsupportedImages(true, selected, models, true)).toBe(false);
    expect(shouldWarnUnsupportedImages(true, selected, models, false)).toBe(true);
  });

  test("开关开但视觉模型不可用（无凭据/隐藏/文生图）→ 仍提示", () => {
    expect(
      shouldWarnUnsupportedImages(
        true,
        selected,
        [model({ input: ["text"] }), model({ ...visionModel, authed: false })],
        true,
      ),
    ).toBe(true);
    expect(
      shouldWarnUnsupportedImages(
        true,
        selected,
        [model({ input: ["text"] }), model({ ...visionModel, enabled: false })],
        true,
      ),
    ).toBe(true);
    expect(
      shouldWarnUnsupportedImages(
        true,
        selected,
        [model({ input: ["text"] }), model({ ...visionModel, t2i: true })],
        true,
      ),
    ).toBe(true);
  });

  test("空目录不判定", () => {
    expect(shouldWarnUnsupportedImages(true, selected, [])).toBe(false);
  });
});
