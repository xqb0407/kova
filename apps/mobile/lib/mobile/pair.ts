import { normalizeWsUrl } from "./secure-store";

/**
 * 配对握手：一次性 WS 连接，发 {type:"pair", code} 换 {type:"paired", token}。
 *
 * 与 WsPiChannel 的 auth 路径是两条独立协议（见 remote.rs 的 read_loop）：
 * - pair：无凭据，用桌面临时显示的 6 位码换长效 token，服务端 5 次机会、10s 超时；
 * - auth：带 token 复连，token 失效才回落重新配对。
 * 所以配对不能用 WsPiChannel（它构造即连且立刻发 auth），这里裸开一条 WS。
 *
 * 网关是明文 ws://，只在局域网/隧道可达——不做 TLS 就没有中间人防护，UI 层
 * 必须让用户知道自己在往什么地址上送凭据。
 */
export function pairForToken(url: string, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error("连接超时，请检查地址是否可达")));
    }, 15000);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
      fn();
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "pair", code }));
    };

    ws.onmessage = (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type === "paired" && typeof frame.token === "string") {
        finish(() => resolve(frame.token as string));
      } else if (frame.type === "error") {
        const text = String(frame.errorText ?? "配对失败");
        const left = frame.attemptsLeft;
        finish(() =>
          reject(
            new Error(typeof left === "number" ? `${text}（剩余 ${left} 次机会）` : text),
          ),
        );
      }
    };

    ws.onerror = () => {
      finish(() => reject(new Error("无法连接到桌面端，请检查地址与网络")));
    };
    ws.onclose = () => {
      finish(() => reject(new Error("连接已关闭")));
    };
  });
}

/** 校验 + 规范化用户填的 host/URL，再发起配对 */
export async function pairWithHost(
  hostInput: string,
  codeInput: string,
): Promise<{ url: string; token: string }> {
  const code = codeInput.trim();
  if (!/^\d{6}$/.test(code)) {
    throw new Error("请输入 6 位配对码");
  }
  const url = normalizeWsUrl(hostInput);
  const token = await pairForToken(url, code);
  return { url, token };
}
