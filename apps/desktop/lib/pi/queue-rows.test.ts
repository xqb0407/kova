import { describe, expect, test } from "bun:test";
import { mergeQueueRows } from "./queue-rows";

type Entry = { id: string; content: string };

const entry = (id: string): Entry => ({ id, content: id });

describe("mergeQueueRows", () => {
  test("无 ghost：原样返回，全部标记为真实行", () => {
    expect(mergeQueueRows([entry("a"), entry("b")], [])).toEqual([
      { item: entry("a"), ghost: false },
      { item: entry("b"), ghost: false },
    ]);
  });

  test("多条相邻 ghost 按原下标插回（连续并入不再互相覆盖）", () => {
    const rows = mergeQueueRows(
      [entry("c")],
      [
        { item: entry("b"), index: 1 },
        { item: entry("a"), index: 0 },
      ],
    );
    expect(rows.map((row) => `${row.ghost ? "ghost" : "real"}:${row.item.id}`)).toEqual([
      "ghost:a",
      "ghost:b",
      "real:c",
    ]);
  });

  test("ghost 条目已回到队列：不重复插入", () => {
    const rows = mergeQueueRows([entry("a")], [{ item: entry("a"), index: 0 }]);
    expect(rows).toEqual([{ item: entry("a"), ghost: false }]);
  });

  test("原下标越界时 clamp 到末尾", () => {
    const rows = mergeQueueRows([entry("a")], [{ item: entry("b"), index: 99 }]);
    expect(rows.map((row) => row.item.id)).toEqual(["a", "b"]);
  });
});
