/**
 * Server-Sent Events framing and incremental parsing.
 *
 * The server writes one JSON object per event in `data:`; the client parser
 * also accepts multi-line data and optional `event:`, `id:` and `retry:`
 * fields so it can consume any conforming SSE producer.
 */

export type SseMessage = {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
};

/** Encode one SSE message. A blank line terminates the event. */
export function encodeSseMessage(message: {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}): string {
  const lines: string[] = [];
  if (message.event !== undefined) lines.push(`event: ${message.event}`);
  if (message.id !== undefined) lines.push(`id: ${message.id}`);
  if (message.retry !== undefined) lines.push(`retry: ${message.retry}`);
  // Split data on newlines so a payload containing \n still round-trips.
  for (const line of message.data.split(/\r?\n/)) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** Encode a JSON value as one SSE event. */
export function encodeSseJson(
  value: unknown,
  options: { event?: string; id?: string } = {},
): string {
  return encodeSseMessage({ ...options, data: JSON.stringify(value) });
}

/**
 * Incremental SSE parser. Feed arbitrary text chunks; it returns complete
 * messages whenever a blank-line boundary is reached.
 */
export class SseParser {
  private buffer = "";
  private event: string | undefined;
  private dataLines: string[] = [];
  private id: string | undefined;
  private retry: number | undefined;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.consumeLine(line, out);
      index = this.buffer.indexOf("\n");
    }
    return out;
  }

  /** Flush a final unterminated event (some servers omit the last blank line). */
  end(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.consumeLine(line, out);
    }
    this.flush(out);
    return out;
  }

  private consumeLine(line: string, out: SseMessage[]): void {
    if (line === "") {
      this.flush(out);
      return;
    }
    if (line.startsWith(":")) return; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        this.id = value;
        break;
      case "retry": {
        const retry = Number(value);
        if (Number.isFinite(retry)) this.retry = retry;
        break;
      }
      default:
        // Unknown field: ignore per SSE spec.
        break;
    }
  }

  private flush(out: SseMessage[]): void {
    if (this.dataLines.length === 0) {
      // Preserve id/event only when there is data; otherwise drop.
      this.event = undefined;
      this.id = undefined;
      this.retry = undefined;
      return;
    }
    out.push({
      data: this.dataLines.join("\n"),
      ...(this.event !== undefined ? { event: this.event } : {}),
      ...(this.id !== undefined ? { id: this.id } : {}),
      ...(this.retry !== undefined ? { retry: this.retry } : {}),
    });
    this.event = undefined;
    this.dataLines = [];
    this.id = undefined;
    this.retry = undefined;
  }
}

/** Parse a complete SSE document. Useful for tests and non-streaming fixtures. */
export function parseSseDocument(text: string): SseMessage[] {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}
