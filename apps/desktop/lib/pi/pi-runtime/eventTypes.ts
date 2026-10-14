// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/eventTypes.ts（runtime/ 子目录对应上游 src/runtime/）

import type { PiClientEventBody } from "./types";

const KNOWN_PI_CLIENT_EVENT_TYPES = {
  snapshot: true,
  agent_start: true,
  agent_end: true,
  agent_settled: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  queue_update: true,
  compaction_start: true,
  compaction_end: true,
  entry_appended: true,
  auto_retry_start: true,
  auto_retry_end: true,
  session_info_changed: true,
  thinking_level_changed: true,
  context_usage: true,
  extension_ui_request: true,
  extension_ui_resolved: true,
  error: true,
} satisfies Record<PiClientEventBody["type"], true>;

export const isKnownPiClientEventType = (
  type: string,
): type is PiClientEventBody["type"] =>
  Object.prototype.hasOwnProperty.call(KNOWN_PI_CLIENT_EVENT_TYPES, type);
