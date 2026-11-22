import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * 个性化镜像测试：设置页挂载/聚焦时需要重新拉取 sidecar 的实时值（身份文件
 * 可被 AI/外部编辑器改写）；保存时 changed 必须原样透传，并用 sidecar 返回的
 * 整包同步本地镜像——否则旧快照会把 rules.md 的规则覆盖掉。
 *
 * piRequest 打桩换响应（同 lib/pi/pi-context.test.ts 的做法），其余导出透传。
 */

const requests: Record<string, unknown>[] = [];
let reply: Record<string, unknown> = {};

const realPiBridge = await import("@/lib/pi/pi-bridge");
mock.module("@/lib/pi/pi-bridge", () => ({
  ...realPiBridge,
  piRequest: (req: Record<string, unknown>) => {
    requests.push(req);
    return Promise.resolve(reply);
  },
}));

const settings = (over: Record<string, unknown> = {}) => ({
  style: "default",
  styles: [],
  styleOverrides: [],
  userName: "",
  assistantName: "",
  persona: "",
  customInstructions: "",
  ...over,
});

const paths = { soul: "/tmp/kova-test/soul.md", rules: "/tmp/kova-test/rules.md" };

reply = { type: "personalization", settings: settings(), paths };

const store = await import("@/lib/settings/personalization");

beforeEach(() => {
  requests.length = 0;
});

describe("personalization store", () => {
  test("refreshPersonalization 重新拉取并更新镜像（外部写入的规则可见）", async () => {
    reply = {
      type: "personalization",
      settings: settings({ customInstructions: "AI 写入的全局规则" }),
      paths,
    };
    await store.refreshPersonalization();
    expect(
      requests.some((request) => request.type === "get_personalization"),
    ).toBe(true);
    expect(store.getPersonalization().customInstructions).toBe(
      "AI 写入的全局规则",
    );
    expect(store.getPersonalizationPaths()).toEqual(paths);
  });

  test("savePersonalization 透传 changed，并用响应保留未改动的身份文件", async () => {
    // 本地草稿的 customInstructions 是旧空值；changed 只声明 userName
    reply = {
      type: "personalization",
      settings: settings({
        userName: "新名",
        customInstructions: "AI 写入的全局规则",
      }),
      paths,
    };
    await store.savePersonalization(
      {
        ...store.getPersonalization(),
        userName: "新名",
        customInstructions: "",
      },
      ["userName"],
    );

    const save = requests.find(
      (request) => request.type === "set_personalization",
    );
    expect(save).toMatchObject({
      type: "set_personalization",
      changed: ["userName"],
      settings: { userName: "新名", customInstructions: "" },
    });
    // 乐观值被响应里的实时规则校正：未改动的字段以 sidecar 为准
    expect(store.getPersonalization().userName).toBe("新名");
    expect(store.getPersonalization().customInstructions).toBe(
      "AI 写入的全局规则",
    );
  });
});
