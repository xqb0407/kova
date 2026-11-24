/**
 * UHP SSE event vocabulary (2026-10-19 / Streaming chapter).
 *
 * Every event carries a gapless, strictly monotonic `sequence_number`
 * starting at 0. Exactly one terminal event is sent last:
 * response.completed | response.incomplete | response.failed.
 */
import type {
  UhpAnnotation,
  UhpOutputContent,
  UhpOutputItem,
  UhpResponse,
} from "./types";

export type UhpEventBase = {
  type: string;
  sequence_number: number;
};

export type UhpResponseEvent = UhpEventBase & { response: UhpResponse };

export type UhpCreatedEvent = UhpEventBase & {
  type: "response.created";
  response: UhpResponse;
};

export type UhpInProgressEvent = UhpEventBase & {
  type: "response.in_progress";
};

export type UhpTerminalEvent = UhpEventBase &
  (
    | { type: "response.completed"; response: UhpResponse }
    | { type: "response.incomplete"; response: UhpResponse }
    | { type: "response.failed"; response: UhpResponse }
  );

export type UhpOutputItemAddedEvent = UhpEventBase & {
  type: "response.output_item.added";
  output_index: number;
  item: UhpOutputItem;
};

export type UhpOutputItemDoneEvent = UhpEventBase & {
  type: "response.output_item.done";
  output_index: number;
  item: UhpOutputItem;
};

export type UhpContentPartAddedEvent = UhpEventBase & {
  type: "response.content_part.added";
  item_id: string;
  output_index: number;
  content_index: number;
  part: UhpOutputContent;
};

export type UhpOutputTextDeltaEvent = UhpEventBase & {
  type: "response.output_text.delta";
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
};

export type UhpOutputTextDoneEvent = UhpEventBase & {
  type: "response.output_text.done";
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
};

export type UhpContentPartDoneEvent = UhpEventBase & {
  type: "response.content_part.done";
  item_id: string;
  output_index: number;
  content_index: number;
  part: UhpOutputContent;
};

export type UhpAnnotationAddedEvent = UhpEventBase & {
  type: "response.output_text.annotation.added";
  item_id: string;
  output_index: number;
  content_index: number;
  annotation_index: number;
  annotation: UhpAnnotation;
};

export type UhpReasoningSummaryPartAddedEvent = UhpEventBase & {
  type: "response.reasoning_summary_part.added";
  item_id: string;
  output_index: number;
  summary_index: number;
  part: { type: "summary_text"; text: string };
};

export type UhpReasoningSummaryTextDeltaEvent = UhpEventBase & {
  type: "response.reasoning_summary_text.delta";
  item_id: string;
  output_index: number;
  summary_index: number;
  delta: string;
};

export type UhpReasoningSummaryPartDoneEvent = UhpEventBase & {
  type: "response.reasoning_summary_part.done";
  item_id: string;
  output_index: number;
  summary_index: number;
  part: { type: "summary_text"; text: string };
};

export type UhpFunctionCallArgumentsDeltaEvent = UhpEventBase & {
  type: "response.function_call_arguments.delta";
  item_id: string;
  output_index: number;
  delta: string;
};

export type UhpFunctionCallArgumentsDoneEvent = UhpEventBase & {
  type: "response.function_call_arguments.done";
  item_id: string;
  output_index: number;
  arguments: string;
};

export type UhpErrorEvent = UhpEventBase & {
  type: "error";
  code: string;
  message: string;
  param: string | null;
};

export type UhpStreamEvent =
  | UhpCreatedEvent
  | UhpInProgressEvent
  | UhpTerminalEvent
  | UhpOutputItemAddedEvent
  | UhpOutputItemDoneEvent
  | UhpContentPartAddedEvent
  | UhpOutputTextDeltaEvent
  | UhpOutputTextDoneEvent
  | UhpContentPartDoneEvent
  | UhpAnnotationAddedEvent
  | UhpReasoningSummaryPartAddedEvent
  | UhpReasoningSummaryTextDeltaEvent
  | UhpReasoningSummaryPartDoneEvent
  | UhpFunctionCallArgumentsDeltaEvent
  | UhpFunctionCallArgumentsDoneEvent
  | UhpErrorEvent;

export const UHP_TERMINAL_EVENTS = [
  "response.completed",
  "response.incomplete",
  "response.failed",
] as const;

export function isUhpTerminalEvent(
  event: { type?: unknown },
): event is UhpTerminalEvent {
  return (
    event.type === "response.completed" ||
    event.type === "response.incomplete" ||
    event.type === "response.failed"
  );
}

export function terminalEventFor(
  response: UhpResponse,
): "response.completed" | "response.incomplete" | "response.failed" {
  if (response.status === "completed") return "response.completed";
  if (response.status === "incomplete") return "response.incomplete";
  return "response.failed";
}
