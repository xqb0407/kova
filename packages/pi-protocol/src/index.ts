/**
 * pi-protocol：sidecar ⇄ desktop 线协议的单一契约源。
 * 设计文档见 plans/session-context-design.md（§1 契约层、§9 兼容性铁律）。
 * 铁律：协议只增不改；schema 一律 loose（未知字段透传保留）；
 * 出帧 dev/test parse-throw、prod 记 report 放行；入帧同款策略。
 */
export * from "./queue";
export * from "./stamp";
export * from "./transcript";
export * from "./notifications";
export * from "./interactions";
export * from "./errors";
export * from "./payloads";
export * from "./validate";
export * from "./workflow";
