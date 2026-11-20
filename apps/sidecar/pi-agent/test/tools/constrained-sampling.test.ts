import { afterEach, describe, expect, test } from "bun:test";
import { toToolDeclaration } from "@earendil-works/pi-ai";
import { buildTools } from "../../src/tools/tools";
import { resetVisionToolConfigForTest } from "../../src/tools/vision-tool-config";
import {
  setConstrainedSamplingForTest,
  constrainedSamplingEnabled,
} from "../../src/tools/constrained-sampling-config";

afterEach(() => {
  setConstrainedSamplingForTest(true);
  resetVisionToolConfigForTest();
});

describe("edit 工具的 constrainedSampling", () => {
  test("默认开启：edit 挂 json_schema strict prefer，其他工具不挂", () => {
    const tools = buildTools("/tmp", "t-cs");
    const edit = tools.find((tool) => tool.name === "edit");
    expect(edit?.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    const bash = tools.find((tool) => tool.name === "bash");
    expect(bash?.constrainedSampling).toBeUndefined();
  });

  test("开关关闭：edit 不带 constrainedSampling（工具表其余不变）", () => {
    setConstrainedSamplingForTest(false);
    const tools = buildTools("/tmp", "t-cs");
    const edit = tools.find((tool) => tool.name === "edit");
    expect(edit?.constrainedSampling).toBeUndefined();
    expect(edit?.parameters).toBeDefined();
  });

  test("toToolDeclaration 透传该字段（provider 层消费的入口）", () => {
    const tools = buildTools("/tmp", "t-cs");
    const edit = tools.find((tool) => tool.name === "edit");
    expect(edit).toBeDefined();
    const declaration = toToolDeclaration(edit!);
    expect(declaration.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  test("env KOVA_CONSTRAINED_SAMPLING=off 兜底关闭（优先于内存态）", () => {
    const previous = process.env.KOVA_CONSTRAINED_SAMPLING;
    process.env.KOVA_CONSTRAINED_SAMPLING = "off";
    try {
      expect(constrainedSamplingEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KOVA_CONSTRAINED_SAMPLING;
      else process.env.KOVA_CONSTRAINED_SAMPLING = previous;
    }
  });
});
