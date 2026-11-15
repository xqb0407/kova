import { describe, expect, test } from "bun:test";
import { isMirroredKvKey } from "../main/credential-mirror-keys";

describe("credential-mirror-keys", () => {
  test("默认模型与发现缓存进镜像；其余 kv 不触发整文件重建", () => {
    expect(isMirroredKvKey("pi.model")).toBe(true);
    expect(isMirroredKvKey("pi.dynamic-models.custom-gw")).toBe(true);
    expect(isMirroredKvKey("pi.thinking")).toBe(false);
    // 前缀必须带点：不带点的同名前缀不是发现缓存键
    expect(isMirroredKvKey("pi.dynamic-models")).toBe(false);
    expect(isMirroredKvKey("ui.prefs")).toBe(false);
  });
});
