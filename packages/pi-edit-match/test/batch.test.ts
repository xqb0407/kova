import { describe, expect, test } from "bun:test";
import { applyBatchEdits, batchFailureMessage, MAX_BATCH_EDITS } from "../src/index";

describe("applyBatchEdits 成功路径", () => {
  test("多成员对同一份原文件独立匹配，按区间一次写回", () => {
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const r = applyBatchEdits({
      content,
      filePath: "x.ts",
      edits: [
        { oldText: "const a = 1;", newText: "const a = 10;" },
        { oldText: "const c = 3;", newText: "const c = 30;" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updated).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");
    expect(r.count).toBe(2);
    expect(r.notes).toEqual([]);
  });

  test("成员顺序与文件出现顺序无关", () => {
    const content = "aaa\nbbb\n";
    const r = applyBatchEdits({
      content,
      filePath: "f",
      edits: [
        { oldText: "bbb", newText: "B" },
        { oldText: "aaa", newText: "A" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updated).toBe("A\nB\n");
  });

  test("BOM：剥出后匹配，写回原样补回", () => {
    const content = "\uFEFFhello world\n";
    const r = applyBatchEdits({ content, filePath: "f", edits: [{ oldText: "world", newText: "kova" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updated).toBe("\uFEFFhello kova\n");
  });

  test("CRLF 文件：exact 成员不动行尾，宽策略成员的替换文本适配 CRLF", () => {
    const content = "first\r\n  indented\r\nlast\r\n";
    const r = applyBatchEdits({
      content,
      filePath: "f",
      edits: [
        // 行级 trim 等值命中（line_trimmed），替换文本按实际命中的 CRLF 风格回写
        { oldText: "first\nindented", newText: "first2\nindented2" },
        { oldText: "last", newText: "last2" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updated).toBe("first2\r\nindented2\r\nlast2\r\n");
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).toContain("line_trimmed");
    expect(r.notes[0]).toContain("edits[0]");
  });

  test("全部成员零变化 → 空转拒绝（与单条管线同语义）", () => {
    const r = applyBatchEdits({ content: "aaa\n", filePath: "f", edits: [{ oldText: "aaa", newText: "aaa" }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("No changes made");
  });
});

describe("applyBatchEdits 原子失败", () => {
  test("任一成员 not_found → 整批失败、逐条列出、不产出 updated", () => {
    const r = applyBatchEdits({
      content: "aaa\nbbb\n",
      filePath: "f.txt",
      edits: [
        { oldText: "aaa", newText: "XXX" },
        { oldText: "ccc", newText: "YYY" },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no changes were written");
    expect(r.error).toContain("edits[1]");
    expect(r.failures).toEqual([{ index: 1, error: expect.any(String), attempted: "ccc" }]);
    // not_found 回显模型原串：自愈靠它看出差异，而不是盲猜
    expect(r.error).toContain('old: "ccc"');
    expect("updated" in r).toBe(false);
  });

  test("多命中成员（批量模式必须唯一）→ 失败", () => {
    const r = applyBatchEdits({ content: "dup\ndup\n", filePath: "f", edits: [{ oldText: "dup", newText: "x" }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Found 2 candidate blocks");
  });

  test("重叠区间 → 整批拒绝（pi 同款文案）", () => {
    const r = applyBatchEdits({
      content: "abcdef\n",
      filePath: "f",
      edits: [
        { oldText: "abc", newText: "X" },
        { oldText: "cde", newText: "Y" },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("edits[1] and edits[0] overlap in f");
    expect(r.error).toContain("Merge them into one edit or target disjoint regions");
  });

  test("空批量与超上限", () => {
    expect(applyBatchEdits({ content: "x", filePath: "f", edits: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_BATCH_EDITS + 1 }, () => ({ oldText: "a", newText: "b" }));
    const r = applyBatchEdits({ content: "a", filePath: "f", edits: many });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(`batch limit of ${MAX_BATCH_EDITS}`);
  });

  test("batchFailureMessage 把多行错误压成首行；带 attempted 时回显原串", () => {
    const msg = batchFailureMessage("f.txt", [{ index: 2, error: "line1\nline2" }]);
    expect(msg).toContain("  - edits[2]: line1");
    expect(msg).not.toContain("line2");
    const withPreview = batchFailureMessage("f.txt", [
      { index: 0, error: "String to replace not found in file: f.txt", attempted: "const a = 1;" },
    ]);
    expect(withPreview).toContain('old: "const a = 1;"');
  });
});
