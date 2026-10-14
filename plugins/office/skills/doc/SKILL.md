---
name: doc
description: 用 Office 插件的「文档」面板创作/修改富文本文档（`<名称>.doc.univer.json`）：真实文字处理（标题层级、加粗斜体、列表、段落），agent 以 Univer 快照 JSON 协作。当用户想要文档（Word、doc、文章、纪要、方案、README 式长文、公告、合同草稿）、或想在工作区里可视化继续编辑某个 .doc.univer.json 时使用。
---

# Office · Doc：文字文档工作台

文档就是工作区里一个**普通的 JSON 文件**（约定名 `<名称>.doc.univer.json`），
你用现有工具（write / edit / read）直接读写它；用户在右侧「文档」面板（Office 插件，
Univer 引擎）里实时看到渲染结果、可以手动继续编辑（工具栏、标题样式、加粗等都可用）。

**文件内容 = Univer 文档快照**（本 SKILL 下方有完整格式）。面板保存时会把用户的
手动编辑写回同一文件，所以**迭代前必须先 read 最新内容**；从面板回读的档是全量
格式，直接在最新内容上小步 edit，别整档重写成自己的精简版。

## 工作流（按此顺序）

1. **创作（分段写盘）**：第一步 `write` 骨架（`title` + `body.dataStream` 含全部
   段落文本、`paragraphs` 对齐），之后每次 `edit` 补样式或追加段落。每次落盘的
   JSON 必须完整有效；面板在落盘后约半秒自动重渲染，骨架一落盘宿主就自动开板。
2. **面板唤起（通常自动，工具是兜底）**：需要换绑或面板没出来时，显式调
   `open_plugin_panel`，参数 `plugin: "office", panel: "office", path: "..."`（幂等）。
3. **迭代前必须先 read**（同表格）。

## 快照格式（文档）

```jsonc
{
  "title": "季度方案",        // 文档名（首页卡片显示名）
  "documentStyle": {},        // 页面级样式，可空对象
  "body": {
    // 全部文字拼成一条流：段落之间用 \r 分隔，整流以 "\r\n" 结尾。
    // 最后那个 \n 是"节分隔符"，必须有——缺了它文档没有节，整页空白。
    // ⚠️ \n 只允许出现在结尾这一处（段内换行请拆成多个段落，别在段里用 \n）。
    "dataStream": "季度方案\r\r一、背景\r今年聚焦增长。\r\r二、目标\r三个口径。\r\n",
    // 段落列表：startIndex = 该段首个字符在 dataStream 里的偏移（0 起）
    "paragraphs": [
      { "startIndex": 0, "paragraphStyle": { "namedStyleType": 2 } },
      { "startIndex": 5 },
      { "startIndex": 6, "paragraphStyle": { "namedStyleType": 4 } },
      { "startIndex": 11 },
      { "startIndex": 19 },
      { "startIndex": 20, "paragraphStyle": { "namedStyleType": 4 } },
      { "startIndex": 25 }
    ],
    // 节分隔：必须有，且指向结尾那个 \n 的下标（= dataStream 长度 - 1）
    "sectionBreaks": [{ "startIndex": 31 }],
    // 可选：加粗/斜体等行内样式（span 偏移，st 含头不含尾）
    "textRuns": [
      { "st": 6, "ed": 10, "ts": { "bl": 1 } }
    ]
  }
}
```

`paragraphId`/`sectionId` 可全省（面板载入时自动补齐）。**偏移量是本文档最易错的地方**，按下面的机械规则写就不会错：

1. 先把全文按段落写好（数组 `["一、背景", "今年聚焦……", …]`）。
2. `dataStream` = 段落数组用 `\r` 连接，末尾补一个 `\r` 再补一个 `\n`
   （`\r` 终结最后一段，`\n` 是节分隔符；**`\n` 全文只此一处**）。
3. `paragraphs`：从 0 开始逐段累加 `段落字符数 + 1`（+1 是那个 `\r`），得到每段的
   startIndex；**每个段落都要有条目**（包括空段，空段就是常见的空行间隔）。
4. `sectionBreaks` = `[{ "startIndex": dataStream.length - 1 }]`（即结尾 `\n` 的下标）。
5. 标题段落加 `"paragraphStyle": { "namedStyleType": N }`：`2`=大标题 `3`=副标题
   `4`=一级 `5`=二级 `6`=三级（普通正文不写 paragraphStyle）。
6. `textRuns` 可省略；要加粗/斜体时 `st`/`ed` 用同一套偏移（st 含头不含尾），
   `ts` 支持 `bl`(粗) `it`(斜) `ul`(下划线) `fs`(字号) `cl: {rgb}` `ff`(字体) 等。

### 快速自检（写完必对）

- dataStream 以 `\r\n` 结尾，且 `\n` 全文只出现这一次。
- dataStream 里 `\r` 的个数 == paragraphs 条目个数。
- `sectionBreaks[0].startIndex == dataStream 长度 - 1`（指向那个 `\n`）。
- 每个 startIndex < dataStream 长度，且首段是 0。
- textRuns 的 st/ed 不越过段落边界之外的实际文字长度。

## 经验值

- 结构先行：长文档先写全部段落文本（无样式）落盘一次，再一次性 edit 加标题
  级别与重点加粗——用户能先看到内容再看到排版。
- 别写 `textRuns` 覆盖整个段落做"假标题"——标题用 `namedStyleType`，才有大纲结构。
- 列表/表格/图片等高级块（bullet、tables、customBlocks）面板支持有限，v1 先用
  段落文本 + 前缀符号（如 "1. " / "· "）表达。
- 从面板回读后可能多出 `settings`/`styles`/`resources` 等字段——保留，别删。

## 导出（向用户说明用）

- 「导出 TXT」按钮：把正文导出纯文本（段落转 \n；样式不进 TXT）。
- docx 导入导出需要 Univer Pro 转换服务，当前版本不支持；持久格式就是
  `.doc.univer.json` 本身。

## 示例（可直接 write 的骨架；textRuns 给「一、进展」加了粗：st=8 含头，ed=12 不含尾）

```json
{
  "title": "会议纪要",
  "documentStyle": {},
  "body": {
    "dataStream": "项目周会纪要\r\r一、进展\r搜索改版联调完成。\r\r二、风险\r测试环境不稳定。\r\n",
    "paragraphs": [
      { "startIndex": 0, "paragraphStyle": { "namedStyleType": 2 } },
      { "startIndex": 7 },
      { "startIndex": 8, "paragraphStyle": { "namedStyleType": 4 } },
      { "startIndex": 13 },
      { "startIndex": 23 },
      { "startIndex": 24, "paragraphStyle": { "namedStyleType": 4 } },
      { "startIndex": 29 }
    ],
    "sectionBreaks": [{ "startIndex": 38 }],
    "textRuns": [
      { "st": 8, "ed": 12, "ts": { "bl": 1 } }
    ]
  }
}
```
