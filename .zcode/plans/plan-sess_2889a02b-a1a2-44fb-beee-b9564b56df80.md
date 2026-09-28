# 文生图工具落地计划（方案 A · OpenAI images 协议）

## 目标与既有结论

给 agent 加一个 `generate_image` 工具（模型自主决定何时调用，Codex 同款机制），协议走 **OpenAI 兼容 `/v1/images/generations`**（一家覆盖 OpenAI/302AI/custom 网关等绝大多数场景）。配置走方案 A：**SQLite kv 整包 + 设置页一行区域**，含"默认文生图模型"选择。UI 投影链路已就绪（`image-parts.ts` 闸门 + `data-image` 渲染），**零 Rust 改动**（sidecar 直连出网有 `fetch_models` 先例：`protocol/handlers/providers.ts:83` 直接 `fetch()` + Bearer）。

已核实的复用先例：
- 配置整包三面一致：`src/tools/browser-config.ts`（kv + init + apply）→ `protocol/handlers/preferences.ts:146-154`（get/set_browser）→ 前端 `lib/settings/browser-config.ts`（镜像 store）→ `computer-control-settings.tsx:30-48`（SettingRow+Switch）
- 常驻注册 + execute 实时门控婉拒：`browser-tools.ts:48-55`
- 图片块返回形状：`http-tools.ts:180-189`（WebFetch 的 image 块先例）、echo_image
- 凭据读取：`hostdb.ts:120 credentialGet(provider)` → `{apiKey}`（fetch_models 同款用法）
- baseUrl 来源：`getModels().getModel(provider, modelId).baseUrl`（custom provider 注册时已挂上，语义 = OpenAI SDK 前缀，`custom-providers.ts:63-65`；endpoint = `${baseUrl}/images/generations`）

## 一、sidecar（apps/sidecar/pi-agent/src/）

### 1. `tools/imagegen-config.ts`（新建，逐字仿 browser-config）
```ts
export const IMAGEGEN_KV_KEY = "pi.imagegen";
export type ImageGenConfig = {
  enabled: boolean;      // 总开关：关闭时工具婉拒
  provider: string;      // "" = 未配置
  modelId: string;
  size: string;          // 默认 "1024x1024"
};
```
normalize / current / getConfig / initImageGenConfig / applyImageGenConfig 全套。

### 2. `tools/imagegen-tool.ts`（新建）
- schema：`generate_image(prompt*, size?, format?)`；`format: "png"|"jpeg"` 描述注明"大图建议 jpeg，避免 2MiB 内联上限被投影闸门降级为占位"（>2MiB 闸门行为已存在，P1 引用式是终局——image-next-plan §3）
- execute 四道门（顺序）：①`!enabled` 婉拒；②provider/modelId 未配置婉拒（文案指向设置页）；③`credentialGet` 无凭据婉拒；④baseUrl 解析失败报错文本
- 请求：`fetch(url, {method:POST, Authorization: Bearer, body:{model, prompt, n:1, size: params.size ?? cfg.size, response_format:"b64_json", format?→output_format}})`，`AbortSignal.timeout(180_000)`
- 响应：`data[0].b64_json` 直取；只有 `url` 时再 fetch 下载转 base64；mimeType 从下载 content-type / base64 魔数嗅探（png/jpeg/webp/gif），缺省 png
- 返回 `[{type:"text", text:"已生成图片 <model> <size>（约 N KB）"}, {type:"image", data, mimeType}]`（自动走既有投影上屏；图同时回放进模型上下文供验收重画）
- 纯函数拆出来单测：`buildImagesRequest(cfg, params, baseUrl)`、`parseGenerationResponse(json)`、`sniffImageMime(b64)`

### 3. 注册与接线
- `tools/tools.ts:349` 附近（screenshot 之后）加 `buildImageGenTool()`——一次性注册，之后配置开关只进门控不动工具表（缓存纪律）
- `index.ts:101` 后加 `await initImageGenConfig()`
- `protocol/handlers/preferences.ts:154` 后加 `get_imagegen` / `set_imagegen`（send `type:"imagegen"`）
- `protocol/protocol.ts` 协议注释清单补两行；`types.ts` 导出 `PiImageGenConfig`

## 二、desktop 前端

### 4. `lib/pi/pi-bridge.ts`
- 加 `PiImageGenConfig` 类型（:465 PiBrowserConfig 旁）；响应联合 :786 旁加 `{ type: "imagegen"; settings: PiImageGenConfig }`

### 5. `lib/settings/imagegen-config.ts`（新建，仿 lib/settings/browser-config.ts）
水合 `get_imagegen`、`useImageGenConfig()`、乐观保存 `set_imagegen` 回滚。

### 6. 设置页 UI：**`general-settings.tsx` 新增 section「文生图」**（渲染 section :188 附近）
理由：生图走云端 API，远程 web 端同样可用，不挂"电脑控制"（那页明示依赖桌面宿主）。控件：
- Switch 启用（SettingRow，仿 computer-control-settings:36-48）
- 模型选择：`usePiModels()`（lib/pi/pi-models.ts）按 provider 分组出下拉，仅列 `authed` 的；选中写 provider+modelId
- 默认尺寸：Select（1024x1024 / 1792x1024 / 1024x1792 / auto）
- 未配置模型时行下灰字提示"生图模型需在 模型服务 里添加（OpenAI 兼容端点）"

## 三、明确不做（本计划边界）

- 无 Rust 改动；不新增宿主 HTTP 命令；secretEnv 机制不涉及（provider 凭据已有专用通道）
- 不做混元/Gemini/Stability 原生协议适配器（只留 imagegen-tool 的响应解析扩展位）；不做图生图/局部重绘；不做落盘工作区（P1 随引用式大图一起做）
- 不改系统提示词（工具 description 自说明，避免 prompt churn）

## 四、测试

- `test/tools/imagegen-config.test.ts`：normalize 宽松规整、kv 持久化回落（仿 browser-config 测试，若有）
- `test/tools/imagegen-tool.test.ts`：stub `globalThis.fetch`——四道门婉拒文案；请求体形状（size 缺省回落到配置、response_format、Bearer 头）；b64 直取 / url 下载两分支；非 2xx → isError 文本；魔数嗅探 mime
- 全量回归：`cd apps/sidecar/pi-agent && ~/.bun/bin/bun test && ~/.bun/bin/bun x tsc --noEmit`；desktop `bun x tsc --noEmit`
- 手工验收：设置里选模型 → 对话"画一张科技蓝 banner" → 工具行下出图卡、放大/保存、F5 刷新图还在；关掉开关再画 → 婉拒文案

## 五、已知限制（如实记录）

- 2MiB 内联闸门：gpt-image 高清 PNG 可能超限 → 占位降级（模型侧看到提示可改 jpeg 重试）；引用式大图是既有 P1
- 生图模型若不在 `list_models` 目录（未加进任何 provider），下拉里选不到——需先在模型服务里手动加 modelId（现有能力）