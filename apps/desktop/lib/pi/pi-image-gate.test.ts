import { describe, expect, test } from "bun:test";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import type { SelectedModel } from "@/lib/model/model-settings";
import { imageGateBlocked } from "@/lib/pi/pi-image-gate";

const model = (overrides: Partial<PiModelSummary>): PiModelSummary =>
  ({
    provider: "custom",
    id: "model-a",
    name: "Model A",
    authed: true,
    input: ["text"],
    ...overrides,
  }) as PiModelSummary;

const selected: SelectedModel = { provider: "custom", modelId: "model-a" };

describe("imageGateBlocked（纯文本输入模型的图片附件闸）", () => {
  test("元数据明确排除图像 → 禁止", () => {
    const models = [model({ input: ["text"] })];
    expect(imageGateBlocked(models, selected)).toBe(true);
  });

  test("元数据含图像 → 放行", () => {
    const models = [model({ input: ["text", "image"] })];
    expect(imageGateBlocked(models, selected)).toBe(false);
  });

  test("input 缺失 → 不判定（放行，避免误禁）", () => {
    const models = [model({ input: undefined as unknown as string[] })];
    expect(imageGateBlocked(models, selected)).toBe(false);
  });

  test("空目录（未加载/远程/web 预览）→ 不判定", () => {
    expect(imageGateBlocked([], selected)).toBe(false);
  });

  test("无选择 → 不判定", () => {
    const models = [model({})];
    expect(imageGateBlocked(models, null)).toBe(false);
  });

  test("目录里的模型必须 authed 且未停用，否则视为找不到 → 不判定", () => {
    expect(imageGateBlocked([model({ authed: false })], selected)).toBe(false);
    expect(imageGateBlocked([model({ enabled: false })], selected)).toBe(false);
  });

  test("provider/modelId 任一不匹配 → 不判定", () => {
    expect(
      imageGateBlocked([model({ id: "model-b" })], selected),
    ).toBe(false);
    expect(
      imageGateBlocked([model({ provider: "other" })], selected),
    ).toBe(false);
  });

  test("视觉辅助就绪（开关开 + 有可用视觉模型）→ 放行纯文本模型加图", () => {
    const models = [
      model({ input: ["text"] }),
      model({ provider: "vision-p", id: "vision-m", input: ["text", "image"] }),
    ];
    expect(imageGateBlocked(models, selected, true)).toBe(false);
    // 缺省取值（测试环境镜像默认关）→ 维持拦截
    expect(imageGateBlocked(models, selected)).toBe(true);
  });

  test("开关开但无可用视觉模型 → 维持拦截", () => {
    const models = [model({ input: ["text"] })];
    expect(imageGateBlocked(models, selected, true)).toBe(true);
  });

  test("开关关：目录里即使有视觉模型也维持拦截（提示词零污染）", () => {
    const models = [
      model({ input: ["text"] }),
      model({ provider: "vision-p", id: "vision-m", input: ["text", "image"] }),
    ];
    expect(imageGateBlocked(models, selected, false)).toBe(true);
  });
});
