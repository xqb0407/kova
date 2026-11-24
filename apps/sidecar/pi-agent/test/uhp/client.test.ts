import { afterEach, describe, expect, test } from "bun:test";
import { UhpClient, UhpClientError } from "../../src/uhp/client";
import type { UhpResponse } from "uhp-protocol";

const finalResponse: UhpResponse = {
  id: "resp_test",
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
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    },
  ],
  store: true,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  metadata: { session_id: "hsess_test" },
};

let server: { port?: number; stop(force?: boolean): void } | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

function startServer(handler: (req: Request) => Response | Promise<Response>): string {
  const instance = Bun.serve({ port: 0, fetch: handler });
  server = instance;
  if (instance.port === undefined) throw new Error("server did not bind a port");
  return `http://127.0.0.1:${instance.port}`;
}

describe("UHP client", () => {
  test("parses discovery and harness lists", async () => {
    const base = startServer((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/uhp") {
        return Response.json({
          object: "uhp.discovery",
          protocol: "uhp",
          versions: ["2026-10-19"],
          default_version: "2026-10-19",
          conformance_class: "extended",
          capabilities: { streaming: true },
        });
      }
      if (path === "/v1/harnesses") {
        return Response.json({
          object: "list",
          data: [{ id: "chrn_1", object: "harness", name: "H", base: "kova", createdAt: 1 }],
        });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new UhpClient({ baseUrl: base, token: "t" });
    const discovery = await client.discovery();
    expect(discovery.default_version).toBe("2026-10-19");
    const harnesses = await client.listHarnesses();
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0].id).toBe("chrn_1");
  });

  test("consumes SSE and returns the terminal response", async () => {
    const base = startServer((req) => {
      if (new URL(req.url).pathname !== "/v1/responses") {
        return new Response("not found", { status: 404 });
      }
      const created = {
        type: "response.created",
        sequence_number: 0,
        response: { ...finalResponse, status: "in_progress", output: [] },
      };
      const delta = {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "hello",
      };
      const done = {
        type: "response.completed",
        sequence_number: 2,
        response: finalResponse,
      };
      const body = [created, delta, done]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const client = new UhpClient({ baseUrl: base, token: "t" });
    const events: string[] = [];
    const result = await client.createResponse(
      { input: "hi" },
      { onEvent: (event) => events.push(event.type) },
    );
    expect(events).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(1);
  });

  test("rejects a server that does not advertise the supported version", async () => {
    const base = startServer(() =>
      Response.json({
        object: "uhp.discovery",
        protocol: "uhp",
        versions: ["2026-10-04"],
        default_version: "2026-10-04",
        conformance_class: "core",
        capabilities: { streaming: true },
      }),
    );
    const client = new UhpClient({ baseUrl: base, token: "t" });
    try {
      await client.discovery();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(UhpClientError);
      expect((error as UhpClientError).message).toContain("2026-10-19");
    }
  });

  test("maps error envelopes to UhpClientError", async () => {
    const base = startServer(() =>
      Response.json(
        {
          error: {
            type: "authentication_error",
            code: "authentication_error",
            message: "bad token",
            param: null,
            detail: null,
          },
        },
        { status: 401 },
      ),
    );
    const client = new UhpClient({ baseUrl: base, token: "t" });
    try {
      await client.listHarnesses();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(UhpClientError);
      expect((error as UhpClientError).status).toBe(401);
      expect((error as UhpClientError).code).toBe("authentication_error");
    }
  });
});
