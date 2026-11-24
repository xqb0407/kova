import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SubagentDefinition } from "../../src/subagent/subagent-definitions";
import type { SubagentActivityItem } from "../../src/types";
import { UhpSubagentRun } from "../../src/subagent/uhp-run";

let server: { port?: number; stop(force?: boolean): void } | null = null;

function startUhpServer(): string {
  const instance = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/uhp") {
        return Response.json({
          object: "uhp.discovery",
          protocol: "uhp",
          versions: ["2026-10-19"],
          default_version: "2026-10-19",
          conformance_class: "extended",
          capabilities: { streaming: true, sessions: true, cancellation: true },
        });
      }
      if (path === "/v1/harnesses") {
        return Response.json({
          object: "list",
          data: [
            {
              id: "chrn_test",
              object: "harness",
              name: "Test",
              base: "kova",
              defaultModel: "test/model",
              createdAt: 1,
            },
          ],
        });
      }
      if (path === "/v1/responses") {
        const response = {
          id: "resp_1",
          object: "response",
          created_at: 1,
          status: "completed",
          error: null,
          incomplete_details: null,
          previous_response_id: null,
          model: "test/model",
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "external report", annotations: [] }],
            },
          ],
          store: true,
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          metadata: { session_id: "hsess_1" },
        };
        const events = [
          { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [{ type: "output_text", text: "", annotations: [] }],
            },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 2,
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "external ",
          },
          {
            type: "response.output_text.delta",
            sequence_number: 3,
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "report",
          },
          {
            type: "response.output_text.done",
            sequence_number: 4,
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            text: "external report",
          },
          { type: "response.completed", sequence_number: 5, response },
        ];
        const body = events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  server = instance;
  if (instance.port === undefined) throw new Error("no port");
  return `http://127.0.0.1:${instance.port}`;
}

const definition: SubagentDefinition = {
  name: "external",
  description: "External UHP harness",
  backend: "uhp",
  uhp: { server: "test" },
  tools: [],
  prompt: "Review the change.",
  scope: "system",
  stateKey: "system:external",
};

beforeEach(() => {
  const base = startUhpServer();
  process.env.KOVA_UHP_BASE_URL = base;
  process.env.KOVA_UHP_TOKEN = "token";
  process.env.KOVA_UHP_SERVER_ID = "test";
  process.env.KOVA_UHP_SERVERS_FILE = "/nonexistent/uhp-servers.json";
});

afterEach(() => {
  server?.stop(true);
  server = null;
  delete process.env.KOVA_UHP_BASE_URL;
  delete process.env.KOVA_UHP_TOKEN;
  delete process.env.KOVA_UHP_SERVER_ID;
  delete process.env.KOVA_UHP_SERVERS_FILE;
});

describe("UhpSubagentRun", () => {
  test("maps external SSE to activity and returns a report", async () => {
    const activities: SubagentActivityItem[] = [];
    const controller = new AbortController();
    const run = new UhpSubagentRun({
      definition,
      cwd: "/tmp",
      task: "review",
      signal: controller.signal,
      onActivity: (item) => activities.push(item),
    });
    const result = await run.run();
    expect(result.status).toBe("completed");
    expect(result.report).toBe("external report");
    expect(result.toolCalls).toBe(0);
    expect(result.tokens).toBe(3);
    expect(activities.some((item) => item.kind === "text" && item.op === "delta")).toBe(true);
    expect(run.historySnapshot().map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("reports the external response id before streaming output", async () => {
    const order: string[] = [];
    const run = new UhpSubagentRun({
      definition,
      cwd: "/tmp",
      task: "review",
      signal: new AbortController().signal,
      onActivity: (item) => {
        if (item.kind === "text" && item.op === "delta") order.push("text");
      },
      onResponseId: (id) => order.push(`response:${id}`),
    });
    const result = await run.run();
    expect(result.status).toBe("completed");
    expect(order[0]).toBe("response:resp_1");
  });

  test("fails clearly when no server is configured", async () => {
    delete process.env.KOVA_UHP_BASE_URL;
    delete process.env.KOVA_UHP_TOKEN;
    const run = new UhpSubagentRun({
      definition: { ...definition, uhp: { server: "missing" } },
      cwd: "/tmp",
      task: "review",
      signal: new AbortController().signal,
      onActivity: () => {},
    });
    const result = await run.run();
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("missing");
  });
});
