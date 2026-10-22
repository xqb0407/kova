import { describe, expect, test } from "bun:test";
import {
  enterShareMode,
  exitShareMode,
  getShareState,
  materializeAutoAll,
  syncShareTurns,
  toggleShareMessage,
} from "./share-store";

/** 两轮对话：u1→a1、u2→a2（轮表由工具栏从消息列表算出后同步） */
const TURNS = new Map([
  ["u1", ["u1", "a1"]],
  ["a1", ["u1", "a1"]],
  ["u2", ["u2", "a2"]],
  ["a2", ["u2", "a2"]],
]);

describe("share-store 轮联动选择", () => {
  test("「分享此条」进入时把选中项扩成整轮", () => {
    exitShareMode();
    enterShareMode(["a1"]);
    syncShareTurns(TURNS);
    expect([...getShareState().selected].sort()).toEqual(["a1", "u1"]);
    // 一次性意图：再次同步不重复扩散
    syncShareTurns(TURNS);
    expect(getShareState().selected.size).toBe(2);
  });

  test("勾用户消息联动 AI 回复；再点整轮取消", () => {
    exitShareMode();
    enterShareMode([]);
    syncShareTurns(TURNS);
    toggleShareMessage("u2");
    expect([...getShareState().selected].sort()).toEqual(["a2", "u2"]);
    toggleShareMessage("a2");
    expect(getShareState().selected.size).toBe(0);
  });

  test("「全选」意图由工具栏落成具体集合", () => {
    exitShareMode();
    enterShareMode();
    expect(getShareState().autoAll).toBe(true);
    materializeAutoAll(["u1", "a1", "u2", "a2"]);
    expect(getShareState().selected.size).toBe(4);
    expect(getShareState().autoAll).toBe(false);
  });

  test("轮表未同步（极端时序）时退化为单条勾选", () => {
    exitShareMode();
    enterShareMode(["u1"]);
    toggleShareMessage("u1");
    expect(getShareState().selected.size).toBe(0);
  });

  test("退出后回到空闲态", () => {
    exitShareMode();
    expect(getShareState().mode).toBe("idle");
    expect(getShareState().selected.size).toBe(0);
    expect(getShareState().turns.size).toBe(0);
  });
});
