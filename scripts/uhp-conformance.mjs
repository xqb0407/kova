#!/usr/bin/env node
/**
 * Run the official UHP conformance suite against a live Kova UHP server.
 *
 * Prerequisites:
 *   pip install "git+https://github.com/HarnessRouter/harnessrouter.git#subdirectory=protocol/conformance"
 *   Kova running with UHP enabled (Settings -> UHP), a configured model, and
 *   a harness id (Settings -> UHP -> Available harnesses).
 *
 * Usage:
 *   UHP_API_KEY=... UHP_HARNESS_ID=chrn_... UHP_MODEL=provider/model \
 *     bun run uhp:conformance -- --class core
 *
 * Extra arguments are forwarded to uhp-conformance.
 */
import { spawn } from "node:child_process";

const baseUrl = process.env.UHP_BASE_URL ?? "http://127.0.0.1:8788";
const apiKey = process.env.UHP_API_KEY ?? "";
const harnessId = process.env.UHP_HARNESS_ID ?? "";
const model = process.env.UHP_MODEL ?? "";

if (!apiKey) {
  console.error("UHP_API_KEY is required (Settings -> UHP -> API Key).");
  process.exit(2);
}
if (!harnessId) {
  console.error("UHP_HARNESS_ID is required (Settings -> UHP -> Available harnesses).");
  process.exit(2);
}

const forwarded = process.argv.slice(2);
const args = [
  "--base-url",
  baseUrl,
  "--api-key",
  apiKey,
  "--harness-id",
  harnessId,
  ...(model ? ["--model", model] : []),
  ...(forwarded.length > 0 ? forwarded : ["--class", "extended"]),
];

const child = spawn("uhp-conformance", args, { stdio: "inherit" });
child.on("error", (error) => {
  console.error(
    `Failed to start uhp-conformance: ${error.message}\n` +
      "Install it with: pip install \"git+https://github.com/HarnessRouter/harnessrouter.git#subdirectory=protocol/conformance\"",
  );
  process.exit(2);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`uhp-conformance terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
