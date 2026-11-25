/**
 * Dependency-free multipart/form-data parser for UHP file uploads.
 * Only the subset needed by POST /v1/files: parts with headers + bytes.
 */
export type MultipartPart = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
  if (!boundary) throw new Error("missing multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) break;
    let contentStart = start + delimiter.length;
    if (body.subarray(contentStart, contentStart + 2).toString() === "--") break;
    if (body.subarray(contentStart, contentStart + 2).toString() === "\r\n") contentStart += 2;
    const next = body.indexOf(delimiter, contentStart);
    if (next === -1) break;
    let end = next;
    if (body.subarray(end - 2, end).toString() === "\r\n") end -= 2;
    const section = body.subarray(contentStart, end);
    const headerEnd = section.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) {
      cursor = next;
      continue;
    }
    const headerText = section.subarray(0, headerEnd).toString("utf8");
    const data = section.subarray(headerEnd + 4);
    const headers = new Map<string, string>();
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const disposition = headers.get("content-disposition") ?? "";
    const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? "";
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    parts.push({
      name,
      ...(filename !== undefined ? { filename } : {}),
      ...(headers.get("content-type") ? { contentType: headers.get("content-type") } : {}),
      data,
    });
    cursor = next;
  }
  return parts;
}
