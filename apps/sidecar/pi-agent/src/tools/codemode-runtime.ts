/**
 * Runtime plumbing for the PTC sandbox.
 *
 * In a `bun build --compile` binary neither pi-codemode's worker file nor the
 * QuickJS wasm sits on disk at their package paths. Bun embeds both when they
 * are reachable from the build graph:
 * - the worker is passed as an extra build entrypoint (scripts/build-sidecar.ts),
 *   and the compiled binary resolves it from the relative source specifier;
 * - the wasm import yields the embedded file path, which `loadQuickJSWasm`
 *   reads and compiles.
 *
 * Under `bun run` (dev) the same import yields the real node_modules path and
 * the worker URL points at the source entry.
 */
import { loadQuickJSWasm, type CodemodeWasmModule } from "@earendil-works/pi-codemode";
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";

/** True inside a `bun build --compile` executable. */
function isCompiledBinary(): boolean {
  return typeof Bun !== "undefined" && Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0;
}

/**
 * Worker entry for `CodemodeSandbox`.
 *
 * Compiled builds must pass the relative source path as a string: Bun cannot
 * map an absolute `B:\~BUN` URL back to an embedded entrypoint on Windows.
 * Dev runs can use a normal URL next to this module.
 */
export function codemodeWorkerUrl(): string | URL {
  return isCompiledBinary()
    ? "./src/tools/codemode-worker.ts"
    : new URL("./codemode-worker.ts", import.meta.url);
}

/** Compiled once per path by pi-codemode and shared across sandboxes. */
export function loadCodemodeWasm(): Promise<CodemodeWasmModule> {
  return loadQuickJSWasm(quickjsWasmPath);
}
