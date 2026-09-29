/**
 * UI 插件桥协议 `kova-ui-plugin/1` 的纯定义层（宿主侧实现见
 * agent-panel/plugin-panel-host.tsx，插件侧对照 SKILL.md 自行实现）。
 *
 * 线路形状：postMessage 一个可克隆纯对象
 *   { v: "kova-ui-plugin/1", dir: "host" | "ui", kind, ...载荷 }
 * 宿主对 UI→host 消息做严格校验（decodeUiMessage）：协议版本/方向/kind
 * 白名单/逐字段类型/base64 长度上限，任一不合即整条丢弃——iframe 里跑的是
 * 第三方代码，解码层就是安全边界，不做"尽力解析"。
 */

export const UI_PLUGIN_PROTOCOL = "kova-ui-plugin/1";

/** 面板声明的权限位（与 sidecar PANEL_PERMISSIONS 对齐） */
export type PanelPermission = "document" | "export" | "agent" | "notify";

/** kind → 所需权限；缺省权限的面板只能收 handshake/主题/视图事件（纯展示 iframe） */
export const MESSAGE_PERMISSION: Record<string, PanelPermission> = {
  "doc.request": "document",
  "doc.change": "document",
  "doc.create": "document",
  "doc.attach": "document",
  "doc.export": "export",
  "asset.request": "document",
  "doc.list": "document",
  "doc.bind": "document",
  "agent.prefill": "agent",
  "ui.notify": "notify",
};

/* ---------------- 历史卡片摘要 ---------------- */

/** 列表项（宿主按已装面板 opens glob 扫描 cwd 得到；preview 已按 MAX 截断） */
export type DocListItem = {
  /** workspace 相对路径；doc.bind 原样回传 */
  path: string;
  name: string;
  /** board/deck/ui=画布档；design=UI 设计档（`*.uidesign.json`）；sheet/doc=Univer 快照档（`*.sheet/.doc.univer.json`） */
  kind: "board" | "deck" | "ui" | "design" | "sheet" | "doc";
  /** 文件最后修改时间（ms epoch；取不到为 0） */
  mtime: number;
  frames: number;
  objects: number;
  /** 页框布局摘要，供卡片画示意缩略图 */
  preview: { x: number; y: number; w: number; h: number; bg: string }[];
  /** 盘上存在但 JSON 已损坏（agent 半途写坏等）：卡片墙照常列出并标注，不再静默消失 */
  corrupt?: boolean;
};

/* ---------------- 宿主 → UI ---------------- */

export type HostMessage =
  /** 握手：主题 + 环境上下文（UI 收到后应发 doc.request 拉文档） */
  | {
      kind: "handshake";
      theme: "light" | "dark";
      context: { workspaceName: string; fileRelPath: string | null };
    }
  /** 文档推送：rev 为宿主单调计数；external=true 表示盘上内容来自 agent/手改；
   *  path 为当前绑定的 workspace 相对文档（换绑后 UI 据此重算资产目录） */
  | { kind: "doc.open"; rev: number; json: string; path?: string; external?: boolean }
  /** 宿主已把 UI 的最近内容写盘 */
  | { kind: "doc.saved"; rev: number }
  /** 宿主侧错误（读盘/写盘失败）；UI 据此回退未保存态 */
  | { kind: "doc.error"; errorText: string }
  | { kind: "theme.update"; theme: "light" | "dark" }
  | { kind: "view.focus" }
  | { kind: "view.hidden" }
  /** asset.request 的回包：workspace 相对文件 → base64；读不到 null */
  | { kind: "asset.reply"; reqId: string; base64: string | null }
  /** doc.list 的回包：工作区里的画布档摘要（按 mtime 倒序） */
  | { kind: "doc.list.reply"; reqId: string; items: DocListItem[] };

export function encodeHostMessage(m: HostMessage): Record<string, unknown> {
  return { v: UI_PLUGIN_PROTOCOL, dir: "host", ...m };
}

/* ---------------- UI → 宿主 ---------------- */

export type UiMessage =
  /** iframe 内脚本就绪，等待 handshake */
  | { kind: "ui.ready" }
  /** 请求当前绑定文档（handshake 后或用户主动重载时发） */
  | { kind: "doc.request" }
  /** 内容变更：宿主防抖写盘 */
  | { kind: "doc.change"; json: string }
  /** 新建并绑定文档：宿主写盘（拒绝覆盖已有文件）→ tab.path 绑定 → doc.open */
  | { kind: "doc.create"; path: string; json: string }
  /** 落盘图片等附属资产：宿主写 <文档名>-assets/<name> */
  | { kind: "doc.attach"; name: string; base64: string }
  /** 导出产物（如 .pptx）：宿主按 filename（workspace 相对）写盘 + 提示；silent 抑制逐文件成功提示（工程包多文件成批写时用，由面板自己收尾提示） */
  | { kind: "doc.export"; filename: string; base64: string; silent?: boolean }
  /** 读任意 workspace 文件字节（图片元素渲染源） */
  | { kind: "asset.request"; reqId: string; path: string }
  /** 列工作区里的画布档（首页历史卡片）；宿主回 doc.list.reply */
  | { kind: "doc.list"; reqId: string }
  /** 打开已有画布档并让本面板绑定过去（宿主重绑 tab.path → 推 doc.open） */
  | { kind: "doc.bind"; path: string }
  /** 预填会话输入框（选中元素「问 AI」） */
  | { kind: "agent.prefill"; text: string }
  /** 轻提示 */
  | { kind: "ui.notify"; text: string; level?: "info" | "error" };

/** base64 字段长度上限（≈ Rust fs_write_file 32MB 字节上限的编码后体积） */
const MAX_B64_CHARS = 45_000_000;
const MAX_TEXT_CHARS = 8_000_000;

/** 非空单段相对路径（无 ".."、绝对前缀、反斜杠），且不允许以 "." 开头隐藏文件 */
function isRelName(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 1024 &&
    !s.startsWith("/") &&
    !s.includes("\\") &&
    !s.includes("\0") &&
    !s.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}

function isB64(s: unknown): s is string {
  return typeof s === "string" && s.length <= MAX_B64_CHARS;
}

/**
 * 严格解码 UI→宿主消息：非本协议/方向/kind 不在白名单/字段类型不符 → null。
 * 不认识的 kind 静默丢弃（向前兼容：UI 可携带新 kind，旧宿主不响应）。
 */
export function decodeUiMessage(data: unknown): UiMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.v !== UI_PLUGIN_PROTOCOL || m.dir !== "ui") return null;
  const str = (x: unknown, max = MAX_TEXT_CHARS): string | null =>
    typeof x === "string" && x.length <= max ? x : null;
  switch (m.kind) {
    case "ui.ready":
      return { kind: "ui.ready" };
    case "doc.request":
      return { kind: "doc.request" };
    case "doc.change": {
      const json = str(m.json);
      return json === null ? null : { kind: "doc.change", json };
    }
    case "doc.create": {
      const path = str(m.path);
      const json = str(m.json);
      if (path === null || json === null || !isRelName(path)) return null;
      return { kind: "doc.create", path, json };
    }
    case "doc.attach": {
      const name = str(m.name);
      // 资产名限单段（宿主拼 <doc>-assets/ 目录，不给路径自由度）
      if (name === null || !isRelName(name) || name.includes("/")) return null;
      return isB64(m.base64) ? { kind: "doc.attach", name, base64: m.base64 } : null;
    }
    case "doc.export": {
      const filename = str(m.filename);
      if (filename === null || !isRelName(filename)) return null;
      if (!isB64(m.base64)) return null;
      // silent 缺省不带键，保持既有解码结果的形状不变
      return m.silent === true
        ? { kind: "doc.export", filename, base64: m.base64, silent: true }
        : { kind: "doc.export", filename, base64: m.base64 };
    }
    case "asset.request": {
      const reqId = str(m.reqId, 128);
      const path = str(m.path);
      if (reqId === null || path === null || !isRelName(path)) return null;
      return { kind: "asset.request", reqId, path };
    }
    case "doc.list": {
      const reqId = str(m.reqId, 128);
      return reqId === null ? null : { kind: "doc.list", reqId };
    }
    case "doc.bind": {
      const path = str(m.path);
      if (path === null || !isRelName(path)) return null;
      return { kind: "doc.bind", path };
    }
    case "agent.prefill": {
      const text = str(m.text, 100_000);
      return text === null ? null : { kind: "agent.prefill", text };
    }
    case "ui.notify": {
      const text = str(m.text, 2000);
      if (text === null) return null;
      const level = m.level === "error" ? "error" : m.level === "info" ? "info" : undefined;
      return { kind: "ui.notify", text, ...(level ? { level } : {}) };
    }
    default:
      return null;
  }
}
