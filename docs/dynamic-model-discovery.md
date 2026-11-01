# 动态模型发现（autoDiscover）

状态：设计中（实现进行中）
范围：自定义 AI 服务的模型自动发现、AUTO 模型注册与缓存、服务列表 UI 与刷新
来源：移植 [pi-extensions 的 pi-dynamic-models 扩展](https://github.com/shelken/pi-extensions)（v0.2.8），
适配 kova 的 pi-ai 直连架构
非目标：内置厂商的模型发现（内置目录由 pi-ai 维护）；图片/向量模型的自动注册；
发现结果的计费单价（网关 /models 不报价，走目录种子/零价）

## 一、来源分析：pi-dynamic-models 扩展做了什么

该扩展是 pi coding agent 的 ExtensionAPI 插件，核心行为：

1. **发现**：请求 provider 的 `/models` 端点（`/models` 与 `/v1/models` 竞速，
   任一非空立即采用；全部成功且都空才算权威空结果，存在失败不得用空列表覆盖缓存），
   从网关自报字段解析能力：上下文窗口、输出上限、输入模态、思考档位。
2. **合并**：`registerProvider` 是整表替换语义，扩展在注册前合并
   `内置 → models.json 手写 → 新 AUTO`——AUTO 只追加缺失 id，永不覆盖手写模型参数。
3. **缓存**：按 provider 落盘（6h 新鲜期），与配置指纹（端点/协议/凭据引用/头）
   绑定——换端点或换账户自动失效重新发现；失败冷却 10 分钟，冷却期不重试网络。
4. **触发**：factory 同步读缓存（启动不联网）；联网发生在 session_start 或显式
   `/dynamic-models refresh`；缺缓存的 provider 冷启动发现一次（带锁与超时上限）。
5. **解析容错**：裸数组 / `{data:[...]}` / `{models:[...]}` 三种枚举响应；单行脏数据
   只丢该行；只有 id 的行仍可注册；非对话输出（图片、向量）不注册。
6. **补全**：models.dev 目录作为缺失元数据的可选来源（6h 缓存）。

## 二、现状：kova 的模型体系与差距

kova 的 sidecar 直接依赖 `@earendil-works/pi-ai` 包（**不是** pi-coding-agent 的
ExtensionAPI），扩展无法安装、只能移植逻辑。现状模型链路：

- 自定义服务存 `custom_providers` 表（baseUrl/api/headers/enabled），模型行存
  `models` 表（属性覆盖、enabled），注册在 `model/custom-providers.ts`
  （`registerCustomProvider` → pi-ai `createProvider` + `setProvider`）。
- 模型属性三级兜底：`models` 表行值 → 内置目录同名种子（`lookupCatalogModelSeed`，
  pi-ai 内置目录本身就是 models.dev 数据的整理版）→ `CUSTOM_MODEL_DEFAULTS` 猜测值。
- 用户必须**手动**逐个添加模型 id；「获取列表」（`fetch_models`）只能把网关
  返回的 id 与窗口元数据预填进添加弹窗，不会注册任何模型。

差距 = 扩展的「自动发现并注册缺失 id」能力；kova 已有的种子反查 ≈ 扩展的
models.dev 补全（因此**不再移植** models.dev 拉取/缓存子系统）。

## 三、方案总览

```text
UI（设置 → 模型配置）
  │ add_custom_provider { autoDiscover }        服务卡片「刷新发现」按钮
  ▼
sidecar protocol/handlers/providers.ts
  │  保存/启用后后台刷新；refresh_dynamic_models 显式刷新（两段式，不占 mgmt 队列）
  ▼
model/custom-providers.ts
  ├─ refreshProviderDiscovery(row)   联网发现 → 落缓存 → 整体重注册
  ├─ sweepStaleDiscoveries()         启动后台扫描（过期才联网，串行）
  └─ registerCustomProvider(row)     注册 = 手写行 + AUTO 缓存模型
       ▼
model/dynamic-discovery.ts（新，纯逻辑）
  ├─ parseDiscoveredModels()   三种信封、字段别名、思考档位映射、非对话过滤
  ├─ fetchDiscoveredModels()   按接口格式探测（openai 竞速 /v1/models；anthropic x-api-key）
  └─ 缓存读写/指纹/新鲜期/冷却  （hostdb kv：pi.dynamic-models.<providerId>）
       ▼
广播 dynamic_models_updated 帧 → 前端重拉清单 + toast
```

注册路径不联网：`registerCustomProvider` 只读缓存合并 AUTO 模型；联网只发生在
保存/启停后的后台刷新、显式刷新、启动扫描三处（与扩展「factory 同步读缓存」
同构——kova 的目录注册必须同步可用，冷启动问题不存在，因为 sidecar 启动时
`loadCustomProviders` 本来就异步且命令分发有 init 闸门）。

## 四、AUTO 模型语义

- **边界**：AUTO = 发现缓存里存在、但 `models` 表没有手写行的 id。手写行
  （哪怕只手填了 id、属性全空）永远优先；用户对 AUTO 模型执行 `update_model`
  会在 `models` 表落行，效果即「钉住/晋升为手写」，之后该 id 不再是 AUTO。
- **属性优先级**：网关自报 → 目录种子 → `CUSTOM_MODEL_DEFAULTS`。网关只对
  自报字段生效（contextWindow/maxTokens/input/reasoning/thinkingLevelMap），
  cost 网关不报，走种子或零价。
- **思考档位映射**：网关自报档位列表时，自报档位映射为自身、未自报档位显式
  `null`（防止档位选择器暴露网关不接受的档位）；`off` 不写（off 的语义是
  「关闭思考时下发的参数值」，网关不会自报，留空走默认关闭行为）。
- **显示名**：网关 `display_name ?? name`，缺失回落 id。名称不加 "(AUTO)" 后缀
  （与扩展不同）——kova 用独立的 auto 标记在 UI 标注，不污染模型名。
- **compat**：与手写模型同口径保守禁用 `supportsDeveloperRole` /
  `supportsLongCacheRetention`（未知网关兼容性）。
- **停用/删除服务**：目录移除照旧；发现缓存保留（含模型能力摘要，无敏感数据，
  重新启用立即可用）。关闭 autoDiscover 后缓存只在注册时被忽略，不清理。

## 五、发现与缓存

- **指纹**：`sha256([baseUrl, api, sha256(apiKey), headers 排序项])`。密钥只进
  sha256 摘要——换端点/换账户/换头都失效缓存，磁盘不出现密钥原文。
- **存储**：hostdb kv，键 `pi.dynamic-models.<providerId>`，值
  `{ version: 2, fingerprint, models: DiscoveredModel[], fetchedAt, lastFailedUnix? }`。
  读时逐条降级校验（坏行丢弃不拖垮整份缓存）。
- **新鲜期 6h / 失败冷却 10min**：`需要联网 = force || 无缓存 || (过期 && 不在冷却)`。
  「过期但冷却中」不重试（离线/网关故障时保存、启动都不会反复等 15s 超时），
  继续用旧缓存注册。
- **网络**：单端点 15s 超时；openai 系 baseUrl 不以 `/v1` 结尾时
  `/models` 与 `/v1/models` 竞速（firstNonEmpty：非空立即采用，全部成功且都空
  才是权威空，有失败不用空结果覆盖缓存）；anthropic 系
  `GET {base}/v1/models?limit=1000` + `x-api-key` + `anthropic-version`。
  自定义头最后合并（用户显式头覆盖默认 Authorization，大小写不敏感）。
- **触发点**：
  | 触发 | 行为 | 联网条件 |
  |---|---|---|
  | 保存/启用 autoDiscover 服务 | 后台刷新 → 重注册 → 广播 | 按新鲜期（首开必拉） |
  | 换密钥（set_credential） | 后台刷新（指纹含 key 摘要，旧缓存已失效） | 总是（等价首次发现） |
  | 服务卡片「刷新」按钮 | `refresh_dynamic_models` 强制刷新 | 总是（force） |
  | sidecar 启动 | `sweepStaleDiscoveries` 串行扫描 | 过期且不在冷却 |
  | 目录重注册（启停/保存/覆盖应用） | 只读缓存合并 | 从不 |

## 六、存储变更

- `custom_providers` 增列 `auto_discover INTEGER NOT NULL DEFAULT 0`（两侧实现
  同步：`hostdb/local.ts` 与 `electron/main/data.ts`，含旧库 ALTER 迁移），
  `CustomProviderRow.autoDiscover: boolean`。
- 发现缓存入 kv（见上）；`models` 表**不存** AUTO 行（保持「models 表 = 手写
  意图」的单一事实源，AUTO 的存在感由缓存与目录承载）。

## 七、协议变更

命令（`protocol/handlers/providers.ts`）：

- `add_custom_provider` / `list_custom_providers` 消息增 `autoDiscover` 字段
  （list 下发 `autoDiscover`，模型 spec 增 `auto: true` 标记）。
- 新命令 `refresh_dynamic_models { provider }`：两段式（受理后联网，15s+ 网络
  等待不占 mgmt 串行队列，与 fetch_models/test_provider 同款），完成回
  `{ type: "dynamic_models_refreshed", provider, added, removed, total }`。

自发通知（`packages/pi-protocol/src/notifications.ts` 登记）：

- `{ type: "dynamic_models_updated", provider, added, removed, total, source }`，
  source ∈ `save | startup`。宿主对无 id 帧是全量广播（无白名单），前端
  `subscribeWireFrames(["dynamic_models_updated"])` 订阅后重拉清单 + toast。

## 八、UI 变更（桌面）

- **添加/编辑服务弹窗**（model-add-dialog）：自定义表单加「自动发现模型」开关
  （保存进 add_custom_provider；编辑态回填现值）。开启时模型区非必填——零手写
  模型可保存，模型清单由保存后的后台发现补齐（sidecar 同步豁免「至少一个模型」
  校验）。编辑弹窗**只列手写模型**，AUTO 模型不进可编辑行——保存会整表替换
  models 行，把 AUTO 一起提交会把全部发现结果晋升为手写、冻住发现语义。
- **服务卡片**（model-settings）：autoDiscover 服务显示「自动发现」徽标与模型
  总数（手写 + AUTO）；enabled 且 autoDiscover 时显示刷新按钮（转圈 → toast
  新增/移除计数）；订阅 `dynamic_models_updated` 帧自动重拉列表。
- **fetch_models（获取列表预填）**：解析器统一切到 `parseDiscoveredModels`
  （fetch 路径不做非对话过滤——用户仍可手动添加图片模型走 imagegen）。

## 九、与原扩展的差异清单

| 扩展 | kova 移植版 | 原因 |
|---|---|---|
| pi ExtensionAPI `registerProvider` | pi-ai `createProvider` + `setProvider` | 架构不同（直连包） |
| models.dev 目录补全 + 6h 缓存 + ETag | 复用 `lookupCatalogModelSeed` 内置目录反查 | pi-ai 目录即 models.dev 整理版，去一整套网络子系统 |
| 冷启动同步发现（锁 + 冷却标记文件） | 不需要：注册路径不联网，目录就绪有 init 闸门 | kova 无 `pi -p --model` 先于 session_start 的解析路径 |
| 模型名加 " (AUTO)" 后缀 | 名称原样，UI 用 auto 标记 | 模型名进请求展示与选择器，污染名不值 |
| `$VAR`/`${VAR}` 凭据模板解析 | 凭据直读 credentialStore（hostdb） | kova 凭据体系不同 |
| 文件缓存 + mtime 新鲜期 | hostdb kv + fetchedAt 字段 | 数据目录归宿主管 |
| 非对话模型一律不注册 | 发现路径过滤；fetch_models 预填路径不过滤 | kova 支持图片模型（imagegen） |
| `/dynamic-models` 斜杠命令 | 设置页刷新按钮 + 自动广播 | kova 无斜杠命令体系 |

## 十、安全考量

- 发现请求带 `Authorization: Bearer <key>`（或 anthropic `x-api-key`），key 取自
  credentialStore；自定义头经 `validateHeaderInput` 同款校验规则（存储态经
  `parseStoredHeaders` 宽容解析）。
- 缓存与日志不落密钥：指纹只含 apiKey 的 sha256；错误信息不含响应体
  （网关回显可能带凭据，与扩展同款规避）。
- `dynamic_models_updated` 帧只含计数与 providerId，不含模型清单（前端按需
  list_custom_providers 拉取，掩码口径不变）。

## 十一、改动文件清单

**sidecar**（apps/sidecar/pi-agent）
- `src/model/dynamic-discovery.ts`（新）：解析/探测/缓存/指纹/冷却
- `src/model/custom-providers.ts`：注册合并 AUTO；`refreshProviderDiscovery`、
  `sweepStaleDiscoveries`
- `src/model/catalog.ts`：`mergeModelRowUpdate`（单行更新合并进整包替换——
  顺带修复 `update_model` 单条 `modelsReplace` 清空兄弟行的既有数据丢失 bug）
- `src/model/model-metadata.ts`：`parseFetchedModelList` 迁移到统一解析器（契约不变）
- `src/storage/hostdb.ts` + `src/storage/hostdb/local.ts`：auto_discover 列
- `src/protocol/handlers/providers.ts`：autoDiscover 透传、AUTO spec 下发、
  `refresh_dynamic_models`、保存/启停/换密钥后后台刷新与广播、零模型保存豁免、
  update_model 整包合并写回
- `src/index.ts`：启动扫描接线（catalogReady 之后）
- `src/protocol/protocol.ts`：命令注册表注释
- `test/model/dynamic-discovery.test.ts`、`test/model/model-row-merge.test.ts`（新）

**桌面/协议**
- `apps/electron/main/data.ts`：auto_discover 列（schema + 迁移 + 查询 + cpRow）
- `packages/pi-protocol/src/notifications.ts`：dynamic_models_updated 帧 schema
- `apps/desktop/lib/pi/pi-bridge.ts`：autoDiscover/auto 线类型、refresh 命令与应答
- `apps/desktop/components/settings/components/model-add-dialog.tsx` +
  `model-add-dialog-logic.ts`：自动发现开关
- `apps/desktop/components/settings/components/model-settings.tsx`：徽标、刷新、
  帧订阅

## 十二、测试计划

- 单测（bun test，sidecar）：解析器信封/别名/k·M 字符串/单行降级/去重/非对话
  过滤/思考档位 null 填充；缓存 decode 降级与指纹不匹配失效；
  `autoModelsFromCache` 手写过滤；`parseFetchedModelList` 既有契约回归（现有
  model-metadata.test.ts 不改动即通过）。
- 既有套件回归：`bun run test`（sidecar）、`bun run test:desktop`、typecheck。
- 手工验证：添加 autoDiscover 服务（首次发现广播）→ 断网重启（冷却期内不再
  等超时，AUTO 仍从缓存注册）→ 手写同 id 模型（晋升，AUTO 让位）→ 刷新按钮
  （计数 toast）。
