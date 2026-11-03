# Univer 升级与快照迁移结论（office 插件）

> 结论先行：**当前不引入通用快照迁移器**。表格/文档的持久格式是 Univer 快照，
> 我们通过「版本对齐 + 载入容错层 + 往返门禁测试」把兼容风险压在升级时刻暴露，
> 而不是提前写一套没有目标版本的迁移框架。触发条件与做法见下文。

## 1. 版本策略

- 所有 `@univerjs/*` 包**锁定同一 minor（当前 1.0.4）**，新增能力（如 sheets-filter/sort/
  conditional-formatting/find-replace）必须用同版本；混 minor 会出现 DI 插件契约不匹配。
- **不要引入 `@univerjs/preset-sheets-advanced`**：它是 Pro 全家桶（`@univerjs-pro/*`、
  透视表/打印/exchange/license），需要商业授权且体积不可控。需要新能力时优先找
  OSS 细粒度包（本仓 P2 已按此原则接入 7 个包，体积仅 +约 0.4MB）。
- `@univerjs/presets` 元包的版本仅提供 `createUniver` 等壳，升级时与各 preset 同步。

## 2. 快照边界与容错层

| 文档 | 持久格式 | 载入容错层 | 说明 |
|---|---|---|---|
| 幻灯片 | `.deck.canvas.json`（自有 v2） | `ui/src/doc.ts` 的 `parseDoc`（字段白名单/缺省值/v1→v2 迁移） | 未知字段在解析时丢弃；新增字段一律「可选 + 缺省」 |
| 表格 | `.sheet.univer.json`（Univer 工作簿快照） | `ui/src/sheet/sanitize.ts`（sheet.id 对齐、冻结负值修正、剥离保护/鉴权与空壳 resources） | 只改已知坏字段，其余原样透传 |
| 文档 | `.doc.univer.json`（Univer 文档快照） | `ui/src/doc/normalize.ts`（dataStream 结尾 `\r\n`、paragraphs/sectionBreaks 补齐） | 高级块（customBlocks/tables）与未知字段原样保留 |

关键约定：插件数据都在工作簿快照的 `resources` 里（如 `SHEET_FILTER_PLUGIN`、
`SHEET_CONDITIONAL_FORMATTING_PLUGIN`）。容错层**不解析、不改写**这些资源，只剥离
空壳与 `PROTECTION|AuthzIo`（沙箱 iframe 无 IndexedDB，鉴权/保护资源会阻断编辑）。

## 3. 可执行门禁（迁移层的当前形态）

- `ui/test/snapshot-compat.test.ts`：
  - sheet：filter/CF 资源内容逐字节保留、merge/freeze/rowData/columnData 不变、
    未知顶层与子表字段保留、`appVersion` 保留、保护/鉴权资源剥离、负冻结钳位；
  - doc：normalize 幂等，`customBlocks`/`tables`/`settings`/未知字段保留；
  - deck：`pageNumber`/`footer`/`notes`/`lineHeight` 等可选字段 parse→serialize→parse 不丢。
- 任何 Univer 升级只要跑不过这份门禁，就说明出现了需要显式迁移的破坏性变更。
- 性能门禁：`bun run bench`（纯函数）、`bun run bench:browser`（200 页 deck 真实渲染路径）、
  `bun run bench:sheet`（5 万格表格命令连发/序列化对比），升级后对比首屏与连发上报量是否劣化。

## 4. 升级检查清单（每次 bump 逐项勾）

1. 统一改 `@univerjs/*` 与 `@univerjs/presets` 到同一新版本，`bun install`。
2. `bun test ui/test` 全绿（含 snapshot-compat 门禁）。
3. `bun bench/pure.ts` + `bun bench/run.ts`：首屏/滚动/输入帧间隔无显著劣化。
4. 三类文档手工冒烟：新建（含 doc 空 body 种子）→ 打开既有档 → 编辑 → 导出
   （sheet: csv/xlsx；doc: html/txt；deck: pptx/pdf/svg/html）。
5. 检查保存后的快照：`resources` 里 filter/CF 数据仍在；`appVersion` 被更新；
   工作表字段无丢失（可用 snapshot-compat 的 fixture 作为对照样本）。
6. 若 3/5 出现结构变化：进入第 5 节。

## 5. 何时需要真正的迁移层

触发条件（满足任一）：
- Univer 大版本（如 2.x）重命名/重构快照字段，或插件资源名变化；
- 门禁测试出现「新代码保存后旧字段消失/资源丢失」；
- 我方 deck schema 做破坏性变更（目前只增可选字段，v1→v2 已有透明迁移先例）。

实现方式（届时）：
1. 在 `sanitize.ts` / `normalize.ts` 前加 `migrateSnapshot(snapshot)`，按 `appVersion` 或
   结构特征分支，输出**新结构**；迁移是纯函数、幂等、可单测。
2. 面板载入时迁移 + 首次保存即写回新结构；原文件由宿主写盘/ git 历史兜底。
3. 门禁测试补「旧 fixture → 迁移 → 新结构」用例，并保留旧 fixture 在
   `ui/test/fixtures/`（当前用内联对象，升级时抽成文件）。
4. 同步更新 `skills/sheet|doc|deck/SKILL.md` 的 schema 段落。

## 6. 已知风险

- 面板保存的是**全量** Univer 快照：旧版本面板打开新版本写出的档再保存，可能丢掉
  它不认识的新插件资源。因此**插件版本需要与应用一起滚动**，不要让用户混用新旧面板。
- Pro 包（advanced preset / exchange / print）不要混入 OSS 构建，否则引入 license 依赖。
- 表格快照的 `appVersion` 是升级判定依据，容错层必须保留（门禁已覆盖）。
