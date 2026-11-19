/**
 * 设置页保存回环：desktop 把表单草稿原样发回，sidecar 用 mcpDraftFromMessage
 * 归一化后落盘。新增的 expose 必须在这里被保留——否则用户每编辑一次服务器，
 * 直接暴露配置就被静默抹掉（工具表回退网关，且没有任何报错）。
 */
import { describe, expect, test } from "bun:test";
import { mcpDraftFromMessage } from "../../src/protocol/payloads";

describe("mcpDraftFromMessage", () => {
  const base = {
    name: "direct",
    transport: "http",
    url: "https://direct.example/mcp",
  };

  test("保留合法 expose，丢弃非法值", () => {
    expect(mcpDraftFromMessage({ ...base, expose: "direct" })).toMatchObject({
      expose: "direct",
    });
    expect(mcpDraftFromMessage({ ...base, expose: "gateway" })).toMatchObject({
      expose: "gateway",
    });
    expect(mcpDraftFromMessage({ ...base, expose: "both" })).not.toHaveProperty("expose");
    expect(mcpDraftFromMessage(base)).not.toHaveProperty("expose");
  });

  test("授权面字段原样保留：enabledTools / connectorId 不因保存丢失", () => {
    expect(
      mcpDraftFromMessage({
        ...base,
        enabledTools: ["search_*", "read_*"],
        connectorId: "catalog:github",
      }),
    ).toMatchObject({
      enabledTools: ["search_*", "read_*"],
      connectorId: "catalog:github",
    });
  });
});
