import { describe, expect, test } from "bun:test";
import { SseParser, encodeSseJson, encodeSseMessage, parseSseDocument } from "../src/sse";

describe("SSE parser", () => {
  test("parses a single event", () => {
    const messages = parseSseDocument('event: response.created\ndata: {"type":"response.created"}\n\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      event: "response.created",
      data: '{"type":"response.created"}',
    });
  });

  test("handles CRLF, comments, multi-line data and retry", () => {
    const text =
      ': heartbeat\r\nretry: 1500\r\nid: 7\r\nevent: error\r\ndata: line-1\r\ndata: line-2\r\n\r\n';
    expect(parseSseDocument(text)).toEqual([
      { retry: 1500, id: "7", event: "error", data: "line-1\nline-2" },
    ]);
  });

  test("splits events across arbitrary chunk boundaries", () => {
    const parser = new SseParser();
    const input =
      'data: {"a":1}\n\n' + 'data: {"b":2}\n\n' + 'data: {"c":3}\n\n';
    const out: unknown[] = [];
    for (const chunk of input.match(/.{1,5}/gs) ?? []) {
      out.push(...parser.push(chunk));
    }
    out.push(...parser.end());
    expect(out).toEqual([
      { data: '{"a":1}' },
      { data: '{"b":2}' },
      { data: '{"c":3}' },
    ]);
  });

  test("flushes a final event without a trailing blank line", () => {
    const parser = new SseParser();
    expect(parser.push("data: tail")).toEqual([]);
    expect(parser.end()).toEqual([{ data: "tail" }]);
  });

  test("ignores unknown fields and empty data-only blocks", () => {
    expect(parseSseDocument("foo: bar\n\n")).toEqual([]);
  });
});

describe("SSE writer", () => {
  test("encodes event/id/data and preserves newlines", () => {
    const text = encodeSseMessage({ event: "x", id: "0", data: "a\nb" });
    expect(text).toBe("event: x\nid: 0\ndata: a\ndata: b\n\n");
  });

  test("JSON round-trips through the parser", () => {
    const text = encodeSseJson({ type: "response.created", sequence_number: 0 }, {
      event: "response.created",
      id: "0",
    });
    const messages = parseSseDocument(text);
    expect(JSON.parse(messages[0].data)).toEqual({
      type: "response.created",
      sequence_number: 0,
    });
  });
});
