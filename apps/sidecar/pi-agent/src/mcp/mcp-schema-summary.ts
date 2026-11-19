/**
 * MCP 工具 inputSchema → 单行参数摘要（search 结果内联用）。
 *
 * 目标不是完整还原 JSON Schema，而是让模型在大多数情况下不调 describe 就能
 * 直接 call：字段名、可选性、基础类型、枚举、数组元素、一层嵌套足够；遇到
 * $ref / oneOf 等复杂结构只给一个省略标记，由 `needsRawSchema` 判定是否在
 * 结果里再附原始 schema（以及模型是否要改走 describe）。
 *
 * 全部是纯函数：不读磁盘、不依赖缓存，测试直接构造 schema。
 */

/** 嵌套对象展开深度；到达上限输出 `{...}`。顶层 + 一层 */
const MAX_DEPTH = 2;
/** 枚举最多展示多少个值 */
const MAX_ENUM_VALUES = 8;
/** oneOf/anyOf/allOf 最多展开几支 */
const MAX_UNION = 3;
/** 顶层最多列多少个参数（更多只留省略标记） */
const MAX_TOP_LEVEL_PROPS = 20;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
  if (typeof value === "string") {
    // 按 code point 截断：slice 以 UTF-16 单元计，会把 emoji 的代理对切半
    const chars = Array.from(value);
    const text = chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : value;
    return JSON.stringify(text);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "…";
}

function requiredSet(raw: JsonObject): Set<string> {
  return new Set(
    Array.isArray(raw.required)
      ? raw.required.filter((name): name is string => typeof name === "string")
      : [],
  );
}

function typeList(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string");
  }
  return [];
}

function describeSingle(type: string, raw: JsonObject, depth: number): string {
  if (type === "array") {
    // 数组同样要有深度闸门：病态 schema（几十层 items 嵌套）不能把摘要递归爆栈；
    // 到上限给省略标记，needsRawSchema 会据此要求原文。数组闸门比对象宽两档：
    // `number[][]` 这类常见嵌套仍要能读出来，只是别无限展开。
    if (depth >= MAX_DEPTH + 2) return "[...]";
    const items = raw.items;
    if (Array.isArray(items)) {
      return `[${items.map((item) => describeType(item, depth + 1)).join(", ")}]`;
    }
    if (items !== undefined) {
      return `${describeType(items, depth + 1)}[]`;
    }
    return "array";
  }
  if (type === "object") {
    if (depth >= MAX_DEPTH) return "{...}";
    const properties = isObject(raw.properties) ? raw.properties : undefined;
    if (!properties || Object.keys(properties).length === 0) {
      return raw.additionalProperties ? "{ +additional: unknown }" : "object";
    }
    const required = requiredSet(raw);
    const names = Object.keys(properties);
    const shown = names.slice(0, MAX_TOP_LEVEL_PROPS).map(
      (name) =>
        `${name}${required.has(name) ? "" : "?"}: ${describeType(properties[name], depth + 1)}`,
    );
    if (names.length > shown.length) shown.push("…");
    if (raw.additionalProperties) shown.push("+additional: unknown");
    return `{ ${shown.join(", ")} }`;
  }
  return type || "unknown";
}

function describeType(raw: unknown, depth: number): string {
  // 组合子会按同一 depth 递归；给一条硬上限，防止深层 oneOf 链把栈打穿
  if (depth > MAX_DEPTH + 2) return "…";
  if (raw === true) return "unknown";
  if (!isObject(raw)) return "unknown";
  if (raw.$ref !== undefined) return "object";
  if (Array.isArray(raw.enum) && raw.enum.length > 0) {
    const shown = raw.enum.slice(0, MAX_ENUM_VALUES).map(literal);
    if (raw.enum.length > shown.length) shown.push("…");
    return shown.join("|");
  }
  if (raw.const !== undefined) return literal(raw.const);
  const union = Array.isArray(raw.oneOf)
    ? raw.oneOf
    : Array.isArray(raw.anyOf)
      ? raw.anyOf
      : undefined;
  if (union && union.length > 0) {
    const shown = union.slice(0, MAX_UNION).map((item) => describeType(item, depth + 1));
    if (union.length > shown.length) shown.push("…");
    return shown.join("|");
  }
  if (Array.isArray(raw.allOf) && raw.allOf.length > 0) {
    const shown = raw.allOf.slice(0, MAX_UNION).map((item) => describeType(item, depth + 1));
    if (raw.allOf.length > shown.length) shown.push("…");
    return shown.join("&");
  }
  const types = typeList(raw.type);
  const nullable = types.includes("null") && types.length > 1;
  const concrete = types.filter((type) => type !== "null");
  if (concrete.length > 1) {
    return `${concrete.map((type) => describeSingle(type, raw, depth)).join("|")}${
      nullable ? "|null" : ""
    }`;
  }
  if (concrete.length === 1) {
    return `${describeSingle(concrete[0]!, raw, depth)}${nullable ? "|null" : ""}`;
  }
  if (isObject(raw.properties)) return describeSingle("object", raw, depth);
  return "unknown";
}

/**
 * 顶层 schema → `a: string (required), b?: number` 形态的单行摘要。
 * 非对象 schema 返回其顶层类型（如 `array`）；无参数返回 `(no parameters)`。
 */
export function summarizeInputSchema(schema: unknown): string {
  if (schema === undefined || schema === null) return "(no parameters)";
  if (!isObject(schema)) return "(no parameters)";
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  if (properties && Object.keys(properties).length > 0) {
    const required = requiredSet(schema);
    const names = Object.keys(properties);
    const parts = names.slice(0, MAX_TOP_LEVEL_PROPS).map(
      (name) =>
        `${name}${required.has(name) ? "" : "?"}: ${describeType(properties[name], 1)}`,
    );
    if (names.length > parts.length) parts.push("…");
    if (schema.additionalProperties) parts.push("+additional: unknown");
    return parts.join(", ");
  }
  if (schema.type === "object" || properties) {
    // 空对象但允许任意键：仍要告诉模型可以自由传参，而不是"无参数"
    return schema.additionalProperties ? "+additional: unknown" : "(no parameters)";
  }
  return describeType(schema, 0);
}

/** `$ref` / 组合子 / 深层嵌套：摘要只能给出省略标记，需要原始 schema 兜底 */
function hasComplexNode(raw: unknown, depth: number): boolean {
  if (!isObject(raw)) return false;
  if (
    raw.$ref !== undefined ||
    raw.oneOf !== undefined ||
    raw.anyOf !== undefined ||
    raw.allOf !== undefined ||
    raw.not !== undefined ||
    raw.if !== undefined
  ) {
    return true;
  }
  if (depth >= 4) return false;
  const properties = isObject(raw.properties) ? Object.values(raw.properties) : [];
  if (properties.some((item) => hasComplexNode(item, depth + 1))) return true;
  if (hasComplexNode(raw.items, depth + 1)) return true;
  if (hasComplexNode(raw.additionalProperties, depth + 1)) return true;
  return false;
}

/**
 * 摘要是否不足以支撑一次调用：出现省略标记、摘要过长，或 schema 本身含
 * $ref/组合子/深层嵌套。true 时调用方应内联原始 schema（受字节预算约束），
 * 并提示模型复杂参数可走 describe。
 */
export function needsRawSchema(schema: unknown, summary: string): boolean {
  if (summary.length > 200) return true;
  if (summary.includes("...") || summary.includes("…")) return true;
  return hasComplexNode(schema, 0);
}
