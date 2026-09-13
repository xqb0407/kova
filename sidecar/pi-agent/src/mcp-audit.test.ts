import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MCP_AUDIT_MAX_LINES, mcpAuditPath, readMcpAudit, recordMcpAudit } from "./mcp-audit";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-audit-"));
const auditFile = path.join(tmp, "audit.jsonl");
const prevAuditPath = process.env.PI_MCP_AUDIT_PATH;

beforeAll(() => {
  process.env.PI_MCP_AUDIT_PATH = auditFile;
});

afterAll(() => {
  if (prevAuditPath === undefined) delete process.env.PI_MCP_AUDIT_PATH;
  else process.env.PI_MCP_AUDIT_PATH = prevAuditPath;
  rmSync(tmp, { recursive: true, force: true });
});

describe("mcp-audit", () => {
  test("路径跟随 PI_MCP_AUDIT_PATH", () => {
    expect(mcpAuditPath()).toBe(auditFile);
  });

  test("读写往返 + 服务器过滤 + limit + 坏行跳过 + 升序", () => {
    rmSync(auditFile, { force: true });
    recordMcpAudit({ at: 1, server: "a", kind: "connect", ok: true, ms: 5 });
    appendFileSync(auditFile, "not-json{{{\n"); // 模拟撕裂半行
    recordMcpAudit({ at: 2, server: "b", kind: "call", ok: false, detail: "boom" });
    recordMcpAudit({ at: 3, server: "a", kind: "disconnect", detail: "manual" });

    const all = readMcpAudit();
    expect(all.map((e) => e.at)).toEqual([1, 2, 3]); // 时间升序、坏行跳过
    const onlyA = readMcpAudit({ server: "a" });
    expect(onlyA.map((e) => e.kind)).toEqual(["connect", "disconnect"]);
    const lastTwo = readMcpAudit({ limit: 2 });
    expect(lastTwo.map((e) => e.at)).toEqual([2, 3]); // limit 取最近的，仍升序返回
  });

  test("文件不存在返回空", () => {
    rmSync(auditFile, { force: true });
    expect(readMcpAudit()).toEqual([]);
  });

  test("超上限截尾保留最近事件", () => {
    // 每条 detail 填充到 >300B，越过 recordMcpAudit 的文件大小粗判门槛
    const pad = "x".repeat(400);
    const total = MCP_AUDIT_MAX_LINES + 5;
    const lines: string[] = [];
    for (let i = 0; i < total; i++) {
      lines.push(JSON.stringify({ at: i, server: `s${i}`, kind: "connect", detail: pad }));
    }
    writeFileSync(auditFile, lines.join("\n") + "\n");
    recordMcpAudit({ at: total, server: "newest", kind: "connect", detail: pad });
    const kept = readFileSync(auditFile, "utf8").split("\n").filter(Boolean);
    expect(kept.length).toBe(MCP_AUDIT_MAX_LINES);
    // 丢的是最旧的 s0..s4，最新事件保留
    const events = readMcpAudit({ server: "newest" });
    expect(events).toHaveLength(1);
    const head = JSON.parse(kept[0]) as { server: string };
    expect(head.server === "s0").toBe(false);
  });
});
