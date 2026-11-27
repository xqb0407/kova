import { beforeEach, describe, expect, test } from "bun:test";
import {
  consumeInboxSelfActivity,
  recordInboxSelfActivity,
  resetInboxSelfActivityForTest,
  selfActivityKeysFor,
} from "../../main/inbox-connectors/self-activity";

describe("inbox self activity", () => {
  beforeEach(() => {
    resetInboxSelfActivityForTest();
  });

  test("按 provider 记录并返回 key", () => {
    recordInboxSelfActivity("github", "o/r#1");
    expect(selfActivityKeysFor("github")).toEqual(["o/r#1"]);
    expect(selfActivityKeysFor("gitlab")).toEqual([]);
  });

  test("裁剪到 keepReadKeys 协议上限 50", () => {
    for (let i = 0; i < 55; i += 1) {
      recordInboxSelfActivity("github", `o/r#${i}`);
    }
    const keys = selfActivityKeysFor("github");
    expect(keys).toHaveLength(50);
    expect(keys.at(-1)).toBe("o/r#54");
  });

  test("空 key 不记录", () => {
    recordInboxSelfActivity("github", "   ");
    expect(selfActivityKeysFor("github")).toEqual([]);
  });

  test("只返回写入之后开始的同步；消费后不再下发", () => {
    recordInboxSelfActivity("github", "o/r#1");
    const beforeWrite = Date.now() - 1;
    expect(selfActivityKeysFor("github", beforeWrite)).toEqual([]);
    expect(selfActivityKeysFor("github", Date.now())).toEqual(["o/r#1"]);
    consumeInboxSelfActivity("github", ["o/r#1"]);
    expect(selfActivityKeysFor("github", Date.now())).toEqual([]);
  });
});
