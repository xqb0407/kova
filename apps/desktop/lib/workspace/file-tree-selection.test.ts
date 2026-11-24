import { describe, expect, test } from "bun:test";
import {
  applyRowSelection,
  parseTreeDragPayload,
  pruneCollapsedSelection,
  pruneSelectionOnCollapse,
  serializeTreeDragPayload,
  topLevelTargets,
} from "./file-tree-selection";

const visible = [
  { value: "a.txt" },
  { value: "dir" },
  { value: "dir/b.txt" },
  { value: "dir/sub" },
  { value: "dir/sub/c.txt" },
  { value: "loading", disabled: true },
  { value: "z.txt" },
];

const plain = { toggle: false, range: false };
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };
const addRange = { toggle: true, range: true };

describe("applyRowSelection", () => {
  test("普通点击只选当前行并更新锚点", () => {
    expect(
      applyRowSelection({
        current: ["a.txt", "z.txt"],
        anchor: "a.txt",
        visible,
        clicked: "dir/b.txt",
        modifiers: plain,
      }),
    ).toEqual({
      selected: ["dir/b.txt"],
      anchor: "dir/b.txt",
      active: "dir/b.txt",
      additive: false,
      range: false,
    });
  });

  test("Cmd/Ctrl 切换选择；移除后锚点仍跟到被点行", () => {
    expect(
      applyRowSelection({
        current: ["a.txt"],
        anchor: "a.txt",
        visible,
        clicked: "dir",
        modifiers: toggle,
      }).selected,
    ).toEqual(["a.txt", "dir"]);

    expect(
      applyRowSelection({
        current: ["a.txt", "dir"],
        anchor: "dir",
        visible,
        clicked: "a.txt",
        modifiers: toggle,
      }),
    ).toMatchObject({ selected: ["dir"], anchor: "a.txt", additive: true });
  });

  test("Shift 区间替换；Cmd/Ctrl+Shift 区间并入", () => {
    expect(
      applyRowSelection({
        current: ["z.txt"],
        anchor: "a.txt",
        visible,
        clicked: "dir/sub",
        modifiers: range,
      }).selected,
    ).toEqual(["a.txt", "dir", "dir/b.txt", "dir/sub"]);

    expect(
      applyRowSelection({
        current: ["z.txt"],
        anchor: "a.txt",
        visible,
        clicked: "dir/b.txt",
        modifiers: addRange,
      }).selected,
    ).toEqual(["a.txt", "dir", "dir/b.txt", "z.txt"]);
  });

  test("锚点缺失/不可见时 Shift 退化为普通点击", () => {
    expect(
      applyRowSelection({
        current: ["z.txt"],
        anchor: "missing",
        visible,
        clicked: "dir",
        modifiers: range,
      }),
    ).toMatchObject({ selected: ["dir"], anchor: "dir", range: false });
  });

  test("disabled 行不参与选择，区间跳过占位行", () => {
    expect(
      applyRowSelection({
        current: [],
        anchor: "dir/sub",
        visible,
        clicked: "z.txt",
        modifiers: range,
      }).selected,
    ).toEqual(["dir/sub", "dir/sub/c.txt", "z.txt"]);
    expect(
      applyRowSelection({
        current: ["a.txt"],
        anchor: "a.txt",
        visible,
        clicked: "loading",
        modifiers: plain,
      }).selected,
    ).toEqual(["a.txt"]);
  });
});

describe("pruneCollapsedSelection", () => {
  test("只剔除被折叠目录的后代，目录自身与其他项保留", () => {
    expect(
      pruneCollapsedSelection(
        ["dir", "dir/sub", "dir/sub/c.txt", "z.txt"],
        ["dir"],
      ),
    ).toEqual(["dir", "z.txt"]);
    expect(pruneCollapsedSelection(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("pruneSelectionOnCollapse", () => {
  test("折叠时剪掉折叠前已选中的后代", () => {
    expect(
      pruneSelectionOnCollapse(
        ["dir/sub/c.txt", "z.txt"],
        ["dir/sub/c.txt", "z.txt"],
        ["dir"],
      ),
    ).toEqual(["z.txt"]);
  });

  test("换根/外部恢复的新选区不被这次 expanded 收缩误删", () => {
    expect(
      pruneSelectionOnCollapse(
        ["旧根/旧文件.md"],
        ["dir/new.md"],
        ["dir"],
      ),
    ).toEqual(["dir/new.md"]);
  });

  test("点击文件夹的同一帧：新选区是该目录时不被子项剪枝覆盖", () => {
    expect(
      pruneSelectionOnCollapse(["dir/sub/c.txt"], ["dir"], ["dir"]),
    ).toEqual(["dir"]);
  });

  test("同前缀兄弟不受影响", () => {
    expect(
      pruneSelectionOnCollapse(["dir2/a"], ["dir2/a"], ["dir"]),
    ).toEqual(["dir2/a"]);
  });
});

describe("topLevelTargets", () => {
  test("父目录在选区时去掉全部后代", () => {
    expect(
      topLevelTargets(["dir/b.txt", "dir", "dir/sub/c.txt", "z.txt"]),
    ).toEqual(["dir", "z.txt"]);
  });

  test("不误伤同前缀兄弟", () => {
    expect(topLevelTargets(["dir/a", "dir2/b", "dir2"])).toEqual([
      "dir/a",
      "dir2",
    ]);
  });
});

describe("拖拽载荷", () => {
  test("多选数组往返；旧单值兼容", () => {
    expect(parseTreeDragPayload(serializeTreeDragPayload(["a", "dir/b"]))).toEqual([
      "a",
      "dir/b",
    ]);
    expect(parseTreeDragPayload("legacy/rel")).toEqual(["legacy/rel"]);
    expect(parseTreeDragPayload("")).toEqual([]);
  });

  test("方括号文件名解析失败时按单值处理", () => {
    expect(parseTreeDragPayload("[not json")).toEqual(["[not json"]);
  });
});
