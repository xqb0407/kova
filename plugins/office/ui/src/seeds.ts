/**
 * 新建文档骨架工厂（纯数据，无 React/引擎依赖）。
 * UI 首页（OfficeHome）与 office MCP 的 create_doc 共用同一份种子，
 * 保证「面板新建」和「agent create_doc」建出的档完全一致。
 */
import { blankDoc, blankFrame, serializeDoc, type PagePreset } from "./doc";

/** 幻灯片骨架：meta(kind=deck) + 一张空白页 */
export function deckSeed(name: string, preset: PagePreset = "16:9"): string {
  const clean = name.trim().replace(/[/\\:*?"<>|？：＊｜＞＜＼／]/g, "");
  const d = blankDoc(preset, clean || "幻灯片", "deck");
  d.frames.push(blankFrame(preset));
  return serializeDoc(d);
}

/** 表格骨架：Univer 工作簿最小快照（引擎载入时自动补全缺省字段） */
export function sheetSeed(name: string): string {
  const sheetId = "sheet-01";
  return JSON.stringify(
    {
      id: `wb-${Date.now().toString(36)}`,
      name,
      sheetOrder: [sheetId],
      styles: {},
      sheets: {
        [sheetId]: { id: sheetId, name: "Sheet1", rowCount: 100, columnCount: 20, cellData: {} },
      },
    },
    null,
    2,
  );
}

/** 文档骨架：带完整最小 body（机械规则：\r 终结空段、结尾 \r\n 节分隔），
 *  让 agent 纯 MCP 流（create_doc → patch_doc，面板未必已开过）也能直接工作；
 *  面板载入时 normalize/引擎会在此基础上补齐其余缺省字段。 */
export function docSeed(name: string): string {
  return JSON.stringify(
    {
      id: `doc-${Date.now().toString(36)}`,
      title: name,
      documentStyle: {},
      body: {
        dataStream: "\r\n",
        textRuns: [],
        paragraphs: [{ startIndex: 0 }],
        sectionBreaks: [{ startIndex: 1 }],
      },
    },
    null,
    2,
  );
}

/** 新建名称归一（与面板 safeName 同规则）：空格转 -，拒绝路径分隔符/前导点 */
export function safeDocName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, "-");
  if (!name || /[\\/]/.test(name) || name.startsWith(".")) return null;
  return name;
}
