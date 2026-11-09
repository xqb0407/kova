import { describe, expect, test } from "bun:test";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import {
  hasUsableVisionModel,
  imageSupportFromMetadata,
  shouldWarnUnsupportedImages,
} from "@/lib/pi/pi-vision-warning";

/**
 * 发图能力提示的判定测试。钉住五条语义：
 * 1. 元数据明确排除图像（input 存在且不含 "image"）且本次发送含图 → 提示；
 * 2. input 缺失不判定（元数据不可靠是移除 sidecar 硬门的原委，桌面提示同样
 *    宁缺勿误报）；
 * 3. 目录为空（未加载/远程模式）不判定——与 pi-model-gate 同口径；
 * 4. 目录里按 gate 同口径找不到选择（无凭据/被过滤隐藏/已删）不判定；
 * 5. 视觉辅助就绪（开关开 + 有可用视觉模型）不提示——模型可调 see_image 看图。
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
const visionModel = model({
  provider: "vision-p",
  id: "vision-m",
  input: ["text", "image"],
});

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

  test("开关开 + 有可用视觉模型 → 不提示；缺省（测试镜像默认关）→ 仍提示", () => {
    const models = [model({ input: ["text"] }), visionModel];
    expect(shouldWarnUnsupportedImages(true, selected, models)).toBe(true);
    expect(shouldWarnUnsupportedImages(true, selected, models, true)).toBe(false);
  });

  test("开关开但视觉模型不可用/不存在 → 仍提示", () => {
    // 无任何视觉模型
    expect(
      shouldWarnUnsupportedImages(true, selected, [model({ input: ["text"] })], true),
    ).toBe(true);
    // 视觉模型无凭据
    expect(
      shouldWarnUnsupportedImages(
        true,
        selected,
        [model({ input: ["text"] }), model({ ...visionModel, authed: false })],
        true,
      ),
    ).toBe(true);
    // 视觉模型被隐藏
    expect(
      shouldWarnUnsupportedImages(
        true,
        selected,
        [model({ input: ["text"] }), model({ ...visionModel, enabled: false })],
        true,
      ),
    ).toBe(true);
    // 只有文生图模型（非聊天视觉模型）
    expect(
      shouldWarnUnsupportedImages(
        true,
        selected,
        [model({ input: ["text"] }), model({ ...visionModel, t2i: true })],
        true,
      ),
    ).toBe(true);
  });
});

describe("hasUsableVisionModel", () => {
  test("凭据 + 可见 + 图像输入 + 非文生图 才算可用", () => {
    expect(hasUsableVisionModel([visionModel])).toBe(true);
    expect(hasUsableVisionModel([model({ ...visionModel, authed: false })])).toBe(false);
    expect(hasUsableVisionModel([model({ ...visionModel, enabled: false })])).toBe(false);
    expect(hasUsableVisionModel([model({ ...visionModel, t2i: true })])).toBe(false);
    expect(hasUsableVisionModel([model({ ...visionModel, input: undefined })])).toBe(false);
    expect(hasUsableVisionModel([])).toBe(false);
  });
});
