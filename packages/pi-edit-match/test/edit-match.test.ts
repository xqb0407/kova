import { describe, expect, test } from "bun:test";
import {
  adaptReplacementLineEndings,
  applyEditMatch,
  BROAD_STRATEGY_MAX_CHARS,
  editAmbiguousMessage,
  editNoChangeMessage,
  editNotFoundMessage,
  editMatchedNote,
  findEditMatch,
  normalizeReplacementForMatch,
  preserveQuoteStyle,
  stripReadLineNumberPrefixes,
} from "../src/index";

describe("exact", () => {
  test("命中：唯一子串", () => {
    const m = findEditMatch({ content: "const a = 1;\nconst b = 2;\n", search: "const b = 2;", replaceAll: false });
    expect(m).toEqual({ status: "matched", actualString: "const b = 2;", strategy: "exact", candidateCount: 1 });
  });

  test("零命中 → not_found", () => {
    expect(findEditMatch({ content: "foo\nbar\n", search: "baz", replaceAll: false }).status).toBe("not_found");
  });

  test("空 search → not_found（旧实现会误报 N 次命中，这里显式拒绝）", () => {
    expect(findEditMatch({ content: "foo", search: "", replaceAll: false }).status).toBe("not_found");
  });
});

describe("quote_normalized", () => {
  test("模型直引号 vs 文件弯引号：命中且 actualString 取原文弯引号", () => {
    const content = "say \u201Chello world\u201D loudly;\n";
    const m = findEditMatch({ content, search: 'say "hello world" loudly;', replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.strategy).toBe("quote_normalized");
      expect(m.actualString).toBe("say \u201Chello world\u201D loudly;");
    }
  });

  test("弯引号出现两处且同值：匹配器返回 matched（多命中歧义由调用方按出现次数判定）", () => {
    const content = "\u201Caaa\u201D\n\u201Caaa\u201D\n";
    const m = findEditMatch({ content, search: '"aaa"', replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.candidateCount).toBe(2);
  });

  test("preserveQuoteStyle：new_string 里的直引号按文件上下文回写弯引号", () => {
    const actual = "he said \u201Chi there\u201D ok";
    const styled = preserveQuoteStyle('"hi there"', actual, 'x "hi there" y');
    expect(styled).toBe("x \u201Chi there\u201D y");
  });

  test("preserveQuoteStyle：actual 与 search 一致时原样返回", () => {
    expect(preserveQuoteStyle("abc", "abc", "xyz")).toBe("xyz");
  });
});

describe("line_number_prefix_stripped", () => {
  const file = "function a() {\n  return 1;\n}\n";

  test("tab 行号前缀（本地 read 格式）", () => {
    const m = findEditMatch({ content: file, search: "1\tfunction a() {\n2\t  return 1;\n3\t}", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("line_number_prefix_stripped");
  });

  test("宽列带前导空格（远程 read 格式）", () => {
    const m = findEditMatch({ content: file, search: "     1\tfunction a() {\n     2\t  return 1;\n     3\t}", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("line_number_prefix_stripped");
  });

  test("`N: ` 格式", () => {
    const m = findEditMatch({ content: file, search: "1: function a() {\n2:   return 1;\n3: }", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("line_number_prefix_stripped");
  });

  test("非全文带行号 → 本策略跳过（落后续策略/not_found）", () => {
    expect(findEditMatch({ content: file, search: "1\tfunction a() {\n  return 1;", replaceAll: false }).status).toBe("not_found");
  });

  test("stripReadLineNumberPrefixes 直接导出行为", () => {
    expect(stripReadLineNumberPrefixes("1\taaa\n2\tbbb")).toBe("aaa\nbbb");
    expect(stripReadLineNumberPrefixes(" 12: aaa\n 13: bbb")).toBe("aaa\nbbb");
    expect(stripReadLineNumberPrefixes("aaa\nbbb")).toBeNull();
  });
});

describe("escape_normalized", () => {
  test("模型写字面 \\n 而文件是真实换行", () => {
    const m = findEditMatch({ content: "line one\nline two\n", search: "line one\\nline two", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("escape_normalized");
  });

  test("normalizeReplacementForMatch 对 new_string 做同样还原", () => {
    expect(normalizeReplacementForMatch("escape_normalized", "a\\tb")).toBe("a\tb");
    expect(normalizeReplacementForMatch("exact", "a\\tb")).toBe("a\\tb");
  });

  test("已无转义差异时本策略跳过", () => {
    const m = findEditMatch({ content: "plain", search: "plain", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("exact");
  });
});

describe("unicode_escape_normalized", () => {
  test("模型写 \\uXXXX 而文件是真实字符", () => {
    const m = findEditMatch({ content: "value: 中文值\n", search: "value: \\u4e2d\\u6587\\u503c", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.strategy).toBe("unicode_escape_normalized");
      expect(m.actualString).toBe("value: 中文值");
    }
  });
});

describe("line_trimmed", () => {
  test("行内尾随空白差异", () => {
    const content = "function a() {   \n  return 1;  \n}\n";
    const m = findEditMatch({ content, search: "function a() {\n  return 1;\n}", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.strategy).toBe("line_trimmed");
      expect(m.actualString).toBe("function a() {   \n  return 1;  \n}");
    }
  });

  test("多候选同值 → matched（调用方按 actualString 出现次数判歧义）", () => {
    const content = "aaa\nbbb\naaa\nbbb\n";
    const m = findEditMatch({ content, search: "aaa \nbbb", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.candidateCount).toBe(2);
  });
});

describe("indentation_flexible", () => {
  const content = "if (x) {\n    deep();\n    other();\n}\n";

  test("整块缩进错位命中（trim 等价涵盖缩进弹性，line_trimmed 先于本策略承接）", () => {
    const m = findEditMatch({ content, search: "if (x) {\n  deep();\n  other();\n}", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.strategy).toBe("line_trimmed");
      expect(m.actualString).toBe("if (x) {\n    deep();\n    other();\n}");
    }
  });

  test("单行缩进差异（tab vs 空格，非子串）→ line_trimmed 承接", () => {
    const m = findEditMatch({ content, search: "\tdeep();", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("line_trimmed");
  });
});

describe("block_anchor", () => {
  test("首尾行精确、中间近似（≥0.8）命中", () => {
    const content = "start();\nalpha beta\ngamma delta\nend();\n";
    // 单字符差异：avg = (1 + 1 - 1/12) / 2 ≈ 0.958 ≥ 0.8
    const m = findEditMatch({ content, search: "start();\nalpha beta\ngamma deltax\nend();", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("block_anchor");
  });

  test("中间行差异过大（<0.8）→ not_found", () => {
    const content = "start();\nalpha beta\ngamma delta\nend();\n";
    const m = findEditMatch({ content, search: "start();\nalpha beta\nzzz zzz\nend();", replaceAll: false });
    expect(m.status).toBe("not_found");
  });

  test("少于 3 行 → 本策略不参与", () => {
    expect(findEditMatch({ content: "a\nb\n", search: "a\nc", replaceAll: false }).status).toBe("not_found");
  });
});

describe("replaceAll 与宽策略", () => {
  test("replaceAll=true 跳过宽匹配：缩进错位多块时不再兜底", () => {
    const content = "if (x) {\n    deep();\n}\n";
    const m = findEditMatch({ content, search: "if (x) {\n  deep();\n}", replaceAll: true });
    expect(m.status).toBe("not_found");
  });

  test("replaceAll=true 时非宽策略仍可用", () => {
    const m = findEditMatch({ content: "\u201Caa\u201D\n", search: '"aa"', replaceAll: true });
    expect(m.status).toBe("matched");
  });
});

describe("体积保护栏", () => {
  test("超行级宽策略上限时行级策略被跳过，子串策略不受影响", () => {
    // 构造一个超限文件：exact 命中仍工作
    const big = `${"x".repeat(BROAD_STRATEGY_MAX_CHARS + 1)}\nneedle\n`;
    const m = findEditMatch({ content: big, search: "needle", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("exact");

    // 同一文件上 quote 归一等子串策略也仍工作
    const bigQuoted = `${"x".repeat(BROAD_STRATEGY_MAX_CHARS + 1)}\n\u201Cneedle\u201D\n`;
    const q = findEditMatch({ content: bigQuoted, search: '"needle"', replaceAll: false });
    expect(q.status).toBe("matched");
    if (q.status === "matched") expect(q.strategy).toBe("quote_normalized");

    // 行级策略被跳过：只差空白的多行块在超限文件中落 not_found
    const bigLines = `${"if (x) {\n    deep();\n}\n".repeat(10_000)}${"y".repeat(BROAD_STRATEGY_MAX_CHARS)}\n`;
    const lineM = findEditMatch({ content: bigLines, search: "if (x) {\n  deep();\n}", replaceAll: false });
    expect(lineM.status).toBe("not_found");
  }, 20_000);
});

describe("CRLF", () => {
  const crlfFile = "if (x) {\r\n    deep();\r\n    other();\r\n}\r\n";

  test("行级宽匹配在 CRLF 文件命中且候选保留 CRLF", () => {
    const m = findEditMatch({ content: crlfFile, search: "if (x) {\n  deep();\n  other();\n}", replaceAll: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.strategy).toBe("line_trimmed");
      // 候选止于末行内容，行终止符 \r\n 留在候选外——写回保留文件原行尾
      expect(m.actualString).toBe("if (x) {\r\n    deep();\r\n    other();\r\n}");
    }
  });

  test("adaptReplacementLineEndings：new_string 适配为 CRLF", () => {
    expect(adaptReplacementLineEndings("a\r\nb", "x\ny")).toBe("x\r\ny");
    expect(adaptReplacementLineEndings("a\r\nb", "x\r\ny")).toBe("x\r\ny");
    expect(adaptReplacementLineEndings("a\nb", "x\ny")).toBe("x\ny");
  });

  test("LF 文件上 exact 行为不变", () => {
    const m = findEditMatch({ content: "a\nb\n", search: "a", replaceAll: false });
    expect(m).toEqual({ status: "matched", actualString: "a", strategy: "exact", candidateCount: 1 });
  });
});

describe("统一文案", () => {
  test("not_found 文案含路径、回显搜索串与恢复指引", () => {
    const msg = editNotFoundMessage("src/a.ts", "const old = 1;");
    expect(msg).toContain("src/a.ts");
    expect(msg).toContain("const old = 1;");
    expect(msg).toContain("Re-read the file with read");
  });

  test("ambiguous 文案含候选数、路径与 replace_all 指引", () => {
    const msg = editAmbiguousMessage(2, "src/a.ts", "abc");
    expect(msg).toContain("Found 2 candidate blocks");
    expect(msg).toContain("src/a.ts");
    expect(msg).toContain("replace_all=true");
  });

  test("长 old_string 回显截断到 200 字", () => {
    const msg = editNotFoundMessage("f.ts", "x".repeat(500));
    expect(msg).toContain("x".repeat(200));
    expect(msg).not.toContain("x".repeat(201));
  });
});

describe("策略优先级", () => {
  test("exact 优先于一切：即使宽策略也能匹配", () => {
    const m = findEditMatch({ content: "function a() {  \n}\n", search: "function a() {", replaceAll: false });
    expect(m).toEqual({ status: "matched", actualString: "function a() {", strategy: "exact", candidateCount: 1 });
  });

  test("子串策略优先于行级策略", () => {
    // quote_normalized 可命中时不应落到 line_trimmed
    const content = "const s = \u201Cvalue\u201D;\n";
    const m = findEditMatch({ content, search: 'const s = "value";', replaceAll: false });
    if (m.status === "matched") expect(m.strategy).toBe("quote_normalized");
  });
});

describe("applyEditMatch 共享管线（三处 edit 调用点共用）", () => {
  test("exact 成功：替换生效、计数 1、note 为空", () => {
    const r = applyEditMatch({ content: "aa\nbb\n", filePath: "f.txt", oldString: "bb", newString: "cc", replaceAll: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toBe("aa\ncc\n");
      expect(r.count).toBe(1);
      expect(r.strategy).toBe("exact");
      expect(editMatchedNote(r.strategy)).toBe("");
    }
  });

  test("replace_all：计数为真实出现次数", () => {
    const r = applyEditMatch({ content: "aa x aa", filePath: "f", oldString: "aa", newString: "z", replaceAll: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updated).toBe("z x z");
      expect(r.count).toBe(2);
    }
  });

  test("多命中且未 replaceAll → 歧义错误（调用方层面的实际出现次数判定）", () => {
    const r = applyEditMatch({ content: "aa x aa", filePath: "f", oldString: "aa", newString: "z", replaceAll: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(editAmbiguousMessage(2, "f", "aa"));
  });

  test("not_found → 自愈式错误", () => {
    const r = applyEditMatch({ content: "aa", filePath: "f", oldString: "zz", newString: "z", replaceAll: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(editNotFoundMessage("f", "zz"));
  });

  test("降级命中：note 提示策略、替换按 actualString 计数", () => {
    const r = applyEditMatch({
      content: "function a() {  \n  return 1;   \n}\n",
      filePath: "a.js",
      oldString: "function a() {\n  return 1;\n}",
      newString: "function a() {\n  return 2;\n}",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("line_trimmed");
      expect(r.updated).toBe("function a() {\n  return 2;\n}\n");
      expect(r.count).toBe(1);
      expect(editMatchedNote(r.strategy)).toContain("matched via line_trimmed");
    }
  });

  test("行号前缀在 old_string 侧：剥前缀后命中并回写干净内容", () => {
    const r = applyEditMatch({
      content: "function a() {\n  return 1;\n}\n",
      filePath: "a.js",
      oldString: "1\tfunction a() {\n2\t  return 1;\n3\t}",
      newString: "function a() {\n  return 2;\n}",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("line_number_prefix_stripped");
      expect(r.updated).toBe("function a() {\n  return 2;\n}\n");
    }
  });

  test("CRLF 文件降级命中：写回保留全 CRLF（远程 cat > file 同样安全）", () => {
    const r = applyEditMatch({
      content: "alpha\r\nbeta\r\ngamma\r\n",
      filePath: "crlf.txt",
      oldString: "alpha\nbeta",
      newString: "alpha\nbeta2",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe("alpha\r\nbeta2\r\ngamma\r\n");
  });

  test("escape 命中：old_string 与 new_string 的字面转义同链还原", () => {
    // 模型把整段都写成字面 \n：old_string 靠还原命中，new_string 也必须还原——
    // 否则文件里会被插进字面反斜杠文本
    const r = applyEditMatch({
      content: "line one\nline two\n",
      filePath: "e.txt",
      oldString: "line one\\nline two",
      newString: "line one\\nline three",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("escape_normalized");
      expect(r.updated).toBe("line one\nline three\n");
      expect(r.updated).not.toContain("\\n");
    }
  });

  test("unicode 命中：new_string 的 \\uXXXX 与 old_string 对称还原", () => {
    const r = applyEditMatch({
      content: "value: 中文值\n",
      filePath: "u.txt",
      oldString: "value: \\u4e2d\\u6587\\u503c",
      newString: "value: \\u65b0\\u7684\\u503c",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("unicode_escape_normalized");
      expect(r.updated).toBe("value: 新的值\n");
      expect(r.updated).not.toContain("\\u");
    }
  });

  test("quote 命中：new_string 直引号按文件上下文回写弯引号", () => {
    const r = applyEditMatch({
      content: "say \u201Chello world\u201D loudly;\n",
      filePath: "q.md",
      oldString: 'say "hello world" loudly;',
      newString: 'say "hi there" softly;',
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("quote_normalized");
      expect(r.updated).toBe("say \u201Chi there\u201D softly;\n");
    }
  });

  test("exact 命中 CRLF 文件：new_string 原样插入（回归守护——行尾适配不作用于 exact）", () => {
    const r = applyEditMatch({
      content: "alpha\r\nbeta\r\ngamma\r\n",
      filePath: "crlf.txt",
      oldString: "alpha\r\n",
      newString: "x\ny",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("exact");
      // 与旧实现逐字节一致：不因 actualString 含 \r\n 而改写 new_string
      expect(r.updated).toBe("x\nybeta\r\ngamma\r\n");
    }
  });

  test("病态锚点文件（大量重复首尾行）也能正常返回歧义而非卡死", () => {
    const repeated = "head\nmiddle content line\nhead\n".repeat(5_000);
    const r = applyEditMatch({
      content: repeated,
      filePath: "big.txt",
      oldString: "head\nno match middle\nhead",
      newString: "z",
      replaceAll: false,
    });
    // 首尾锚点处处命中但中间行不匹配 → 全部窗口拒绝 → not_found（不做 O(n²) 偏移累加）
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(editNotFoundMessage("big.txt", "head\nno match middle\nhead"));
  });

  test("对抗：行号前缀 + replace_all 不允许剥前缀短串扩散到模型未见的位置", () => {
    // 文件不含行号；模型贴回 read 输出并要求 replace_all——剥前缀后的
    // "unique-token" 会命中另两行模型从未见过的文本，必须拒绝
    const r = applyEditMatch({
      content: "unique-token\nplain unique-token here\nanother unique-token\n",
      filePath: "f",
      oldString: "1\tunique-token",
      newString: "REPLACED",
      replaceAll: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(editNotFoundMessage("f", "1\tunique-token"));
  });

  test("对抗：replacement 里的 $&/$' 模式串按字面写入（单命中同路径）", () => {
    const r = applyEditMatch({
      content: "a-b",
      filePath: "g",
      oldString: "-",
      newString: "$&$&",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe("a$&$&b");
  });

  test("lookalike 归一：模型普通连字符 vs 文件 em-dash / NBSP 命中", () => {
    // 富文本拷贝粘贴高频引入的替身字符：en-dash、NBSP、em-dash
    // （1:1 映射，坐标可回映原文；原空格 + NBSP→空格 = 两个空格）
    const m = findEditMatch({
      content: "range A\u2013B \u00A0wide \u2014 end\n",
      search: "range A-B  wide - end",
      replaceAll: false,
    });
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.strategy).toBe("quote_normalized");
  });

  test("BOM 文件：剥离后匹配、写回保留 BOM", () => {
    const r = applyEditMatch({
      content: "\uFEFFconst a = 1;\n",
      filePath: "bom.js",
      oldString: "const a = 1;",
      newString: "const a = 2;",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("exact");
      expect(r.updated).toBe("\uFEFFconst a = 2;\n");
    }
  });

  test("无变化：old_string 与 new_string 相同（空转）→ 报错而非假成功", () => {
    const r = applyEditMatch({
      content: "keep\n",
      filePath: "n.txt",
      oldString: "keep",
      newString: "keep",
      replaceAll: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(editNoChangeMessage("n.txt"));
  });

  test("对抗：两侧都超长的中间行走长行护栏，常数时间退出而非 O(L²) 冻结", () => {
    // 首尾锚点命中、中间行两侧都 10KB 且内容不同：无护栏时每窗口
    // Levenshtein O(L1×L2)≈10⁸ ops（electron 主进程同步执行 → 冻结数秒）；
    // 护栏下 per-line 常数判 0 → 拒绝 → not_found
    const hugeX = `const a="${"x".repeat(10 * 1024)}";`;
    const hugeY = `const a="${"y".repeat(10 * 1024)}";`;
    const content = `head();\n${hugeX}\nmore\nhead();\n${hugeX}!\nmore\n`;
    const started = performance.now();
    const r = applyEditMatch({
      content,
      filePath: "bundle.js",
      oldString: `head();\n${hugeY}\nmore\nhead();`,
      newString: "head();\nconst replaced = true;\nmore\nhead();",
      replaceAll: false,
    });
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(
        editNotFoundMessage("bundle.js", `head();\n${hugeY}\nmore\nhead();`),
      );
    }
  });

  test("长行护栏不误伤边界：护栏内（<500 字符）的近似行仍命中 block_anchor", () => {
    // 490 字符行对、差 1 字符：相似度 ≈ 1-1/490 ≈ 0.998 ≥ 0.8 → 命中。
    // line_trimmed 对「内部差异」失配（trim 不改变行内容），此处只有
    // block_anchor 的相似度能救回——证明护栏没有把合规近似行一刀切
    const lineA = `const cfg = { name: "${"x".repeat(460)}", v: 1 };`;
    const lineB = `const cfg = { name: "${"x".repeat(459)}y", v: 1 };`;
    const r = applyEditMatch({
      content: `head();\n${lineA}\nmore\n`,
      filePath: "cfg.js",
      oldString: `head();\n${lineB}\nmore`,
      newString: "head();\nconst cfg = { replaced: true };\nmore",
      replaceAll: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.strategy).toBe("block_anchor");
  });
});
