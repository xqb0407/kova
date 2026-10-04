import { describe, expect, it } from "bun:test";
import { isKnownPiSessionEntry } from "./types";
import type {
  PiAgentMessage,
  PiAnySessionEntry,
  PiSessionEntry,
} from "./types";

const baseEntry = {
  id: "entry-1",
  parentId: null,
  timestamp: "2026-07-17T00:00:00.000Z",
};

describe("isKnownPiSessionEntry", () => {
  it("distinguishes known entry types from future entry types", () => {
    const known: PiAnySessionEntry = {
      ...baseEntry,
      type: "custom",
      customType: "extension-state",
    };
    const unknown: PiAnySessionEntry = {
      ...baseEntry,
      type: "future_entry",
    };

    expect(isKnownPiSessionEntry(known)).toBe(true);
    expect(isKnownPiSessionEntry(unknown)).toBe(false);
  });

  it("preserves payload narrowing for known entries", () => {
    const assertKnownMessage = (entry: PiSessionEntry) => {
      if (entry.type !== "message") return;
      // 编译期断言（替代 vitest expectTypeOf）：通过赋值检查类型收窄
      const _typeCheck: PiAgentMessage = entry.message;
      void _typeCheck;
    };
    const assertAnyMessage = (entry: PiAnySessionEntry) => {
      if (!isKnownPiSessionEntry(entry) || entry.type !== "message") return;
      const _typeCheck: PiAgentMessage = entry.message;
      void _typeCheck;
    };
    const message: PiAgentMessage = {
      role: "user",
      content: "Hello",
      timestamp: 0,
    };
    const entry: PiSessionEntry = {
      ...baseEntry,
      type: "message",
      message,
    };

    assertKnownMessage(entry);
    assertAnyMessage(entry);
  });
});
