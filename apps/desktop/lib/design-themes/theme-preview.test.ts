import { describe, expect, test } from "bun:test";

import {
  extractThemeFonts,
  extractThemePalette,
  normalizeHex,
  readableTextOn,
} from "./theme-preview";

/**
 * 预览提取器（纯函数）：色板 = accents 优先 + 正文 hex 补序去重；
 * 字体 = `### Font Family` 小节内 角色→字体 对。样例取自真实主题文档形状。
 */

describe("normalizeHex / readableTextOn", () => {
  test("三位展开、统一小写；非法拒绝", () => {
    expect(normalizeHex("#F80")).toBe("#ff8800");
    expect(normalizeHex("7c5cff")).toBe("#7c5cff");
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
  });

  test("亮度选文字色：浅底深字、深底白字", () => {
    expect(readableTextOn("#EFDF00")).toBe("#111");
    expect(readableTextOn("#000000")).toBe("#fff");
    expect(readableTextOn("#7c5cff")).toBe("#fff");
  });
});

describe("extractThemePalette", () => {
  test("accents 在前；正文 hex 按首次出现补齐并大小写去重", () => {
    const doc = [
      "Renault Yellow (`#EFDF00`) as the super-primary accent",
      "Renault Blue (`#1883FD`) — link hover",
      "again `#efdf00` dup",
      "Pure White (`#FFFFFF`)",
    ].join("\n");
    expect(extractThemePalette(["#1883FD", "not-a-color"], doc)).toEqual([
      "#1883fd",
      "#efdf00",
      "#ffffff",
    ]);
  });

  test("上限裁剪", () => {
    const doc = "#111111 #222222 #333333 #444444 #555555 #666666 #777777";
    expect(extractThemePalette([], doc, 3).length).toBe(3);
  });
});

describe("extractThemeFonts", () => {
  const cohere = `### Font Family

- **Display**: \`CohereText\`, with fallbacks: \`Space Grotesk, Inter, ui-sans-serif, system-ui\`
- **Body / UI**: \`Unica77 Cohere Web\`, with fallbacks: \`Inter, Arial, ui-sans-serif, system-ui\`
- **Code**: \`CohereMono\`, with fallbacks: \`Arial, ui-sans-serif, system-ui\`
- **Icons**: \`CohereIconDefault\` (custom icon font)

### Hierarchy
`;

  test("无 Font Family 小节返回空", () => {
    expect(extractThemeFonts("# 色板\n只有一句 `#ff6b35`")).toEqual([]);
  });

  test("列表行形：角色加粗、回退栈取第一个字体", () => {
    const got = extractThemeFonts(cohere);
    expect(got.map((f) => f.role)).toEqual(["Display", "Body / UI", "Code", "Icons"]);
    expect(got[0].name).toBe("CohereText");
    expect(got[1].name).toBe("Unica77 Cohere Web");
  });

  test("表行形：角色=首格、字体=次格；表头行跳过", () => {
    const table = `### Font Family

| Role | Font | Size | Weight |
| --- | --- | --- | --- |
| **Heading** | \`SF Pro Display\` | 32px | 700 |
| Body | \`SF Pro Text\` | 17px | 400 |
`;
    expect(extractThemeFonts(table)).toEqual([
      { role: "Heading", name: "SF Pro Display" },
      { role: "Body", name: "SF Pro Text" },
    ]);
  });

  test("同名去重 + 最多 4 对", () => {
    const many = `### Font Family

- **A**: \`Inter\`
- **B**: \`Inter\`
- **C**: \`Roboto\`
- **D**: \`Mono X\`
- **E**: \`Fifth\`

### Next
`;
    const got = extractThemeFonts(many);
    expect(got).toEqual([
      { role: "A", name: "Inter" },
      { role: "C", name: "Roboto" },
      { role: "D", name: "Mono X" },
      { role: "E", name: "Fifth" },
    ]);
  });

  test("小节边界：止于下条标题；裸名无引号也能取", () => {
    const doc = `### Font Family
- **Primary**: Inter var, system fallbacks

## 色板
- **Accent**: \`#ff6b35\`
`;
    expect(extractThemeFonts(doc)).toEqual([{ role: "Primary", name: "Inter var" }]);
  });
});
