/**
 * browser_evaluate 结果的有界格式化（纯函数、无 electron 依赖）。
 *
 * 旧实现把 `Runtime.evaluate(returnByValue)` 拿到的值整包 `JSON.stringify(.., null, 2)`
 * 之后才截断——对象大时这一下就在**主进程主线程**上分配整份字符串；页面上随便一个
 * `scene` / `renderer.info` / canvas dataURL 都能让内存翻倍、UI 停顿。这里改成
 * 带预算的遍历：边写边停，字符串/数组/对象都有上限，循环引用与 getter/Proxy 异常也兜住。
 *
 * 注意：工具结果里只保留这段文本，不再回传原始 `value`（见 browser.ts）——
 * 原始值下游没人用，却要再走一遍 redact / JSON.stringify / stdio。
 */

export const EVALUATED_VALUE_MAX_CHARS = 20_000;

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_CHARS = 2_000;

export interface BoundedJsonText {
  text: string;
  truncated: boolean;
}

/** 有界、容错的 JSON 化。输出不保证是合法 JSON（截断/循环/函数会带标记）。 */
export function boundedJsonText(value: unknown, maxChars: number): BoundedJsonText {
  let out = "";
  let truncated = false;
  const seen = new Set<object>();

  const push = (s: string): boolean => {
    if (truncated) return false;
    if (out.length + s.length > maxChars) {
      const room = maxChars - out.length;
      if (room > 0) out += s.slice(0, room);
      truncated = true;
      return false;
    }
    out += s;
    return true;
  };

  const walk = (v: unknown, depth: number): boolean => {
    if (truncated) return false;
    if (v === null) return push("null");
    switch (typeof v) {
      case "string": {
        const s = v as string;
        return push(JSON.stringify(s.length > MAX_STRING_CHARS ? `${s.slice(0, MAX_STRING_CHARS)}…` : s));
      }
      case "number":
        return push(Number.isFinite(v as number) ? String(v) : "null");
      case "boolean":
        return push(v ? "true" : "false");
      case "undefined":
        return push("undefined");
      case "bigint":
        return push(JSON.stringify(`${String(v)}n`));
      case "symbol":
        return push(JSON.stringify(String(v)));
      case "function":
        return push('"[Function]"');
    }

    const obj = v as object;
    if (seen.has(obj)) return push('"[Circular]"');
    seen.add(obj);
    try {
      if (depth >= MAX_DEPTH) return push('"…"');
      if (obj instanceof Date) return push(JSON.stringify(obj.toISOString()));
      if (obj instanceof Error) return push(JSON.stringify(`${obj.name}: ${obj.message}`));

      if (Array.isArray(obj)) {
        if (!push("[")) return false;
        const len = Math.min(obj.length, MAX_ARRAY_ITEMS);
        for (let i = 0; i < len; i += 1) {
          if (i > 0 && !push(",")) return false;
          let item: unknown;
          try {
            item = obj[i];
          } catch {
            item = "[Thrown]";
          }
          if (!walk(item, depth + 1)) return false;
        }
        if (obj.length > len) {
          if (!push(`,"…+${obj.length - len}"`)) return false;
        }
        return push("]");
      }

      let keys: string[] = [];
      try {
        keys = Object.keys(obj).slice(0, MAX_OBJECT_KEYS);
      } catch {
        keys = [];
      }
      if (!push("{")) return false;
      let first = true;
      for (const key of keys) {
        if (!first && !push(",")) return false;
        first = false;
        if (!push(`${JSON.stringify(key)}:`)) return false;
        let item: unknown;
        try {
          item = (obj as Record<string, unknown>)[key];
        } catch {
          item = "[Thrown]";
        }
        if (!walk(item, depth + 1)) return false;
      }
      return push("}");
    } catch {
      // revoke 的 Proxy / throwing getPrototypeOf 等异常：单块降级，不拖垮整条结果
      return push('"[Unserializable]"');
    } finally {
      // 只把当前路径上的对象视为循环；同一对象在两个兄弟分支出现时正常展开两次
      seen.delete(obj);
    }
  };

  try {
    walk(value, 0);
  } catch {
    // 最后一道保险：walk 自身出现意外异常也不能让 browser_evaluate 失败
    if (!truncated) {
      if (out.length > 0) out += "\n";
      out += '"[Unserializable]"';
      truncated = true;
    }
  }
  return { text: out, truncated };
}

/** browser_evaluate 的展示文本：字符串原样（先截再拼），其余有界 JSON。 */
export function formatEvaluatedValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > EVALUATED_VALUE_MAX_CHARS
      ? `${value.slice(0, EVALUATED_VALUE_MAX_CHARS)}\n…[截断]`
      : value;
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const kind = typeof value;
  // function 也走有界序列化（否则 String(fn) 会输出完整函数源码，可能远超预算）
  if (kind !== "object" && kind !== "function") {
    try {
      return String(value).slice(0, EVALUATED_VALUE_MAX_CHARS);
    } catch {
      return "[Unserializable]";
    }
  }
  try {
    const { text, truncated } = boundedJsonText(value, EVALUATED_VALUE_MAX_CHARS);
    return truncated ? `${text}\n…[截断]` : text;
  } catch {
    try {
      return String(value).slice(0, EVALUATED_VALUE_MAX_CHARS);
    } catch {
      return "[Unserializable]";
    }
  }
}
