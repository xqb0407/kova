/**
 * 配对二维码 / 深链的载荷解析（宿主无关，纯字符串 → 结构）。
 *
 * 桌面端「设置 → 远程访问」的二维码内容有两种形态（remote-settings.tsx 的 qr）：
 *   1. 有局域网 http 预览地址（默认）：扫码直达链接
 *      `http://192.168.1.5:8787/#h=<base64url({v,host,code})>`
 *      —— 网页端扫它即打开自身并自动填配对信息；
 *   2. 无 http 预览地址（降级）：裸 JSON `{"v":1,"host":"ws://…/ws","code":"483920"}`。
 *
 * 移动端还要吃第三种：deep link `pikova://pair#h=<base64url>`（粘贴或系统分享进来）。
 * 第四种 `ws://host:8787|483920` 明文留给口述/手抄场景。
 *
 * 早先只认「纯 base64url」，于是扫桌面端默认二维码必然解析失败——配对码在 URL
 * 的 #h= 片段里，整串不是 base64。这里把四种形态一次覆盖，扫码与粘贴共用同一条路径。
 */

export type PairPayload = {
  v: 1;
  /** 桌面网关地址，如 ws://192.168.1.5:8787/ws 或 wss://xxx.trycloudflare.com/ws */
  host: string;
  /** 6 位配对码（remote.rs generate_code 零填充，恒为 6 位数字） */
  code: string;
};

/** `#h=` / `?h=` 参数：直达链接与 deep link 共用同一编码 */
const H_PARAM = /[?#]h=([^&\s]+)/;

/** 桌面端降级形态：裸 JSON */
const CODE_RE = /^\d{6}$/;

function asPayload(v: unknown): PairPayload | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Partial<PairPayload>;
  if (p.v !== 1 || typeof p.host !== "string" || typeof p.code !== "string") {
    return null;
  }
  if (!CODE_RE.test(p.code)) return null;
  return { v: 1, host: p.host, code: p.code };
}

/** base64url（无 padding，-_ 替 +/）→ JSON → 载荷；非该形态返回 null */
function fromBase64Url(value: string): PairPayload | null {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    return asPayload(JSON.parse(atob(padded)));
  } catch {
    return null;
  }
}

export function decodePairPayload(raw: string): PairPayload | null {
  const text = raw.trim();
  if (!text) return null;

  // 3. 明文 host|code（人工口述/手抄）
  const plain = /^(\S+)\|(\d{6})$/.exec(text);
  if (plain) return { v: 1, host: plain[1], code: plain[2] };

  // 1. 桌面端默认二维码 / 2. deep link：配对码藏在 #h= 或 ?h= 里
  const h = H_PARAM.exec(text);
  if (h) {
    let encoded = h[1];
    try {
      encoded = decodeURIComponent(encoded);
    } catch {
      /* 非法百分号转义：原样试解 */
    }
    const payload = fromBase64Url(encoded);
    if (payload) return payload;
  }

  // 4. 降级形态：裸 JSON
  if (text.startsWith("{")) {
    try {
      const payload = asPayload(JSON.parse(text));
      if (payload) return payload;
    } catch {
      /* 继续按 base64url 试一次 */
    }
  }

  // 5. 纯 base64url（旧版二维码、手工分享的编码串）
  return fromBase64Url(text);
}
