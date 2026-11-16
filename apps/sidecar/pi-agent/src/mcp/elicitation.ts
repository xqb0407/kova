/**
 * MCP Elicitation：服务器在执行工具/读取资源时向用户要结构化输入。
 *
 * 协议侧只声明 form 模式（URL 模式 M1 不支持，直接 decline）。表单映射到现有
 * Question 流：`data-question` → QuestionCard/Inbox → question_answer 结算。
 * 这样不新造一套 UI，也天然复用「Stop/新 prompt 取消挂起项」的清理链。
 *
 * 关键约束：
 * - 请求必须绑定到发起它的那一次 MCP 调用；服务器请求没有调用关联 id，因此
 *   由 manager 维护该连接的活跃调用栈，handler 取最近一次上下文；
 * - 无人值守自动化一律 decline，绝不挂起；
 * - 答案按服务器 schema 校验并转回强类型 content，不能把前端 selectedIds
 *   原样当成字段值。
 */
import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { sendEventChunk } from "../protocol/stream";
import {
  beginInteraction,
  sessionForThread,
  settleInteraction,
} from "../sessions/pending-interactions";
import { getAutomationPolicy } from "../automation/policy";
import type { QuestionAnswerItem, QuestionDef } from "../tools/question-tools";
import { logErr } from "../log";

export type McpCallContext = {
  threadId: string;
  sessionId?: string;
  server: string;
  /** call / resource / prompt；只用于日志 */
  operation?: string;
};

type FieldKind = "enum" | "multi-enum" | "boolean" | "text" | "number";

type FieldOption = { id: string; value: string; label: string };

type FieldSpec = {
  key: string;
  title?: string;
  kind: FieldKind;
  required: boolean;
  integer?: boolean;
  options?: FieldOption[];
};

type PendingElicitation = {
  threadId: string;
  server: string;
  fields: FieldSpec[];
  resolve: (result: ElicitResult) => void;
};

const pending = new Map<string, PendingElicitation>();

/** 表单字段能安全映射成 Question；任何不支持的结构都让整次 elicitation 降级 */
function buildFields(request: ElicitRequest): FieldSpec[] | null {
  const params = request.params as { requestedSchema?: unknown };
  const schema = params.requestedSchema;
  if (typeof schema !== "object" || schema === null) return null;
  const s = schema as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  if (!s.properties || typeof s.properties !== "object") return null;
  const required = new Set(
    Array.isArray(s.required)
      ? s.required.filter((v): v is string => typeof v === "string")
      : [],
  );
  const fields: FieldSpec[] = [];
  for (const [key, raw] of Object.entries(s.properties)) {
    if (typeof raw !== "object" || raw === null) return null;
    const p = raw as Record<string, unknown>;
    const title = typeof p.title === "string" ? p.title : key;
    const isRequired = required.has(key);
    if (p.type === "boolean") {
      fields.push({
        key,
        ...(title ? { title } : {}),
        kind: "boolean",
        required: isRequired,
        options: [
          { id: "o-0", value: "true", label: "Yes" },
          { id: "o-1", value: "false", label: "No" },
        ],
      });
      continue;
    }
    if (p.type === "array") {
      const items = p.items as Record<string, unknown> | undefined;
      const values = Array.isArray(items?.enum)
        ? items.enum.filter((v): v is string => typeof v === "string")
        : [];
      if (values.length === 0) return null;
      fields.push({
        key,
        ...(title ? { title } : {}),
        kind: "multi-enum",
        required: isRequired,
        options: values.map((value, i) => ({ id: `o-${i}`, value, label: value })),
      });
      continue;
    }
    const oneOf = Array.isArray(p.oneOf)
      ? p.oneOf
          .map((item) => {
            if (typeof item !== "object" || item === null) return null;
            const o = item as Record<string, unknown>;
            return typeof o.const === "string"
              ? { value: o.const, label: typeof o.title === "string" ? o.title : o.const }
              : null;
          })
          .filter((v): v is { value: string; label: string } => v !== null)
      : [];
    const enumValues = Array.isArray(p.enum)
      ? p.enum.filter((v): v is string => typeof v === "string")
      : [];
    const labels = Array.isArray(p.enumNames)
      ? p.enumNames.filter((v): v is string => typeof v === "string")
      : [];
    if (oneOf.length > 0 || enumValues.length > 0) {
      const options =
        oneOf.length > 0
          ? oneOf
          : enumValues.map((value, i) => ({ value, label: labels[i] ?? value }));
      fields.push({
        key,
        ...(title ? { title } : {}),
        kind: "enum",
        required: isRequired,
        options: options.map((o, i) => ({
          id: `o-${i}`,
          value: o.value,
          label: o.label || o.value,
        })),
      });
      continue;
    }
    if (p.type === "string") {
      fields.push({
        key,
        ...(title ? { title } : {}),
        kind: "text",
        required: isRequired,
      });
      continue;
    }
    if (p.type === "number" || p.type === "integer") {
      fields.push({
        key,
        ...(title ? { title } : {}),
        kind: "number",
        required: isRequired,
        ...(p.type === "integer" ? { integer: true } : {}),
      });
      continue;
    }
    return null;
  }
  return fields.length > 0 ? fields : null;
}

function fieldsToQuestions(fields: FieldSpec[], message: string): QuestionDef[] {
  const questions: QuestionDef[] = fields.map((field) => ({
    title: field.title || field.key,
    ...(field.options
      ? { options: field.options.map((o) => ({ title: o.label })) }
      : {}),
    ...(field.kind === "multi-enum" ? { multiSelect: true } : {}),
    ...(field.kind === "text" || field.kind === "number" ? { freeText: true } : {}),
    ...(field.required ? {} : { skippable: true }),
  }));
  const intro = message.trim();
  if (intro && questions[0]) {
    questions[0] = {
      ...questions[0],
      title: `${intro}\n${questions[0].title}`,
    };
  }
  return questions;
}

function parseAnswer(field: FieldSpec, index: number, answers: QuestionAnswerItem[]): unknown {
  const answer = answers.find((a) => a.questionId === `q-${index}`);
  if (!answer || answer.skipped) {
    if (field.required) throw new Error(`field "${field.key}" is required`);
    return undefined;
  }
  if (field.kind === "boolean") {
    const selected = field.options?.find((o) => answer.selectedIds.includes(o.id));
    if (!selected) {
      if (field.required) throw new Error(`field "${field.key}" is required`);
      return undefined;
    }
    return selected.value === "true";
  }
  if (field.kind === "enum") {
    const selected = field.options?.find((o) => answer.selectedIds.includes(o.id));
    if (!selected) {
      if (field.required) throw new Error(`field "${field.key}" is required`);
      return undefined;
    }
    return selected.value;
  }
  if (field.kind === "multi-enum") {
    const selected = (field.options ?? [])
      .filter((o) => answer.selectedIds.includes(o.id))
      .map((o) => o.value);
    if (selected.length === 0 && field.required) {
      throw new Error(`field "${field.key}" is required`);
    }
    return selected;
  }
  const text = answer.otherText?.trim() ?? "";
  if (!text) {
    if (field.required) throw new Error(`field "${field.key}" is required`);
    return undefined;
  }
  if (field.kind === "number") {
    const n = Number(text);
    if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n))) {
      throw new Error(`field "${field.key}" must be a ${field.integer ? "integer" : "number"}`);
    }
    return n;
  }
  return text;
}

/** 结算一次 elicitation；返回是否存在（不存在则交给普通 Question 路径） */
export function resolveMcpElicitation(
  questionId: string,
  answers: QuestionAnswerItem[],
): boolean {
  const entry = pending.get(questionId);
  if (!entry) return false;
  pending.delete(questionId);
  const content: Record<string, string | number | boolean | string[]> = {};
  try {
    entry.fields.forEach((field, index) => {
      const value = parseAnswer(field, index, answers);
      if (value !== undefined) {
        content[field.key] = value as string | number | boolean | string[];
      }
    });
    settleInteraction(questionId, "answered");
    entry.resolve({ action: "accept", content });
  } catch (err) {
    logErr(
      `mcp[${entry.server}] elicitation answer rejected (thread=${entry.threadId}):`,
      err instanceof Error ? err.message : String(err),
    );
    settleInteraction(questionId, "cancelled");
    entry.resolve({ action: "decline" });
  }
  return true;
}

/** 用户关闭卡片：cancel 比 decline 更贴近“没作答就关掉”的语义 */
export function cancelMcpElicitation(questionId: string): boolean {
  const entry = pending.get(questionId);
  if (!entry) return false;
  pending.delete(questionId);
  settleInteraction(questionId, "cancelled");
  entry.resolve({ action: "cancel" });
  return true;
}

/** Stop / 新 prompt 的兜底清理：按取消结算，防服务器请求永久挂起 */
export function cancelPendingMcpElicitations(threadId: string): void {
  for (const [id, entry] of [...pending]) {
    if (entry.threadId !== threadId) continue;
    pending.delete(id);
    settleInteraction(id, "cancelled");
    entry.resolve({ action: "cancel" });
  }
}

export function hasPendingMcpElicitation(questionId: string): boolean {
  return pending.has(questionId);
}

async function handleElicitation(
  server: string,
  request: ElicitRequest,
  ctx: McpCallContext | undefined,
): Promise<ElicitResult> {
  if (!ctx) return { action: "decline" };
  if (getAutomationPolicy(ctx.threadId)) return { action: "decline" };
  // URL 模式需要客户端拉起链接并等待 out-of-band 完成；M1 只声明 form。
  const params = request.params as {
    mode?: unknown;
    message?: unknown;
    requestedSchema?: unknown;
  };
  if (params.mode === "url") return { action: "decline" };
  const fields = buildFields(request);
  if (!fields) return { action: "decline" };

  const questionId = `mcp-elicit-${randomUUID()}`;
  const questions = fieldsToQuestions(fields, String(params.message ?? ""));
  const payload = {
    questionId,
    anchorToolCallId: questionId,
    questions,
    source: { kind: "mcp", server },
  };
  beginInteraction(ctx.threadId, {
    interactionId: questionId,
    kind: "question",
    anchorToolCallId: questionId,
    payload,
    createdAt: new Date().toISOString(),
  });
  sendEventChunk(
    ctx.threadId,
    { type: "data-question", data: payload },
    ctx.sessionId ?? sessionForThread(ctx.threadId),
  );
  return new Promise<ElicitResult>((resolve) => {
    pending.set(questionId, {
      threadId: ctx.threadId,
      server,
      fields,
      resolve,
    });
  });
}

/** 每个 Client 实例注册一次：连接级 handler 通过 manager 的活跃调用栈取上下文 */
export function registerElicitationHandler(
  client: Client,
  server: string,
  getContext: () => McpCallContext | undefined,
): void {
  client.setRequestHandler(ElicitRequestSchema, (request) =>
    handleElicitation(server, request as ElicitRequest, getContext()),
  );
}
