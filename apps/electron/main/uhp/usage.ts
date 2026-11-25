/**
 * Per-response usage from the session transcript.
 *
 * Kova already persists provider usage on each assistant row. We sum rows whose
 * timestamp falls inside the task window; this avoids fabricated zero values
 * and keeps UHP `usage` meaningful without a second accounting store.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UhpUsage } from "uhp-protocol";
import { sessionsDir } from "../paths";

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null;

export function usageFromTranscript(sessionId: string, sinceMs: number): UhpUsage | null {
  const file = join(sessionsDir(), `${sessionId}.jsonl`);
  if (!existsSync(file)) return null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"type":"message"')) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const agent = (row as { agent?: unknown }).agent;
      if (!agent || typeof agent !== "object") continue;
      const message = agent as {
        role?: string;
        stopReason?: string;
        timestamp?: number;
        usage?: UsageLike;
      };
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      // Without a timestamp we cannot attribute the row to this task; skipping
      // is safer than overcounting previous turns in a continued session.
      if (typeof message.timestamp !== "number") continue;
      if (message.timestamp < sinceMs - 1_000) continue;
      const usage = message.usage;
      if (!usage) continue;
      input += usage.input ?? 0;
      output += usage.output ?? 0;
      cacheRead += usage.cacheRead ?? 0;
      cacheWrite += usage.cacheWrite ?? 0;
    }
  } catch {
    return null;
  }
  const totalInput = input + cacheRead + cacheWrite;
  const total = totalInput + output;
  if (total <= 0) return null;
  return {
    input_tokens: totalInput,
    output_tokens: output,
    total_tokens: total,
  };
}
