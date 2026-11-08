# UPSTREAM — Kova modifications over the vendored pi source

This package is vendored from earendil-works/pi `v1.5.0`
(`f9a26365568127461c47a07a37dcb42c140a3ac5`). This file tracks every local change so a
re-vendor can replay them, and so they can be turned into upstream PRs.

## How to re-vendor a newer upstream version

1. `git -C <pi-checkout> archive <tag-or-commit> -- packages/ai` | extract to a temp dir.
2. Copy `src/`, `README.md`, `CHANGELOG.md` over this directory (keep this `UPSTREAM.md`,
   `NOTICE.md`, `LICENSE`, and the Kova-written `package.json`).
3. Re-extract `src/providers/data/*.json` from the **matching-version npm tarball**
   (`dist/providers/data/`) — these JSONs are gitignored upstream and not in git.
4. Replay every change listed below. `git diff` against the fresh copy is the source of
   truth: local commits that touch this directory and are not pure re-vendor are Kova
   changes.
5. Update the tag/commit in `NOTICE.md`, run `bun install`, and run the sidecar test
   suite.

## Kova changes (1.5.0 base)

### packages/pi-ai

1. **`src/utils/estimate.ts`** — `estimateTokens()` / `estimateMessageTokens()`: guard
   `block.text` / `block.thinking` / `block.name` with `typeof … === "string"` before
   reading `.length`. Rationale: a `{type:"text"}` block whose `text` was `undefined`
   serializes to JSON without the field (see `apps/sidecar/pi-agent/src/sessions/transcript.ts`
   "内容块形状归一" comment); the unguarded `.length` threw a TypeError on every subsequent
   request and permanently poisoned the session. Marked `// KOVA:`.
   *(Candidate for upstream PR — upstream issue likely nonexistent yet.)*

2. **`src/api/anthropic-messages.ts`** — skip text blocks whose `text` is not a string
   (`typeof block.text !== "string" || block.text.trim().length === 0`) instead of calling
   `.trim()` unguarded. Same root cause as above. Marked `// KOVA:`.

3. **`src/api/openai-completions.ts`** — same guard in the assistant text-part filter
   (`typeof block.text === "string" && block.text.trim().length > 0`). Marked `// KOVA:`.

### packages/pi-agent-core

None yet.

## Upstream fixes Kova depends on (already in v1.5.0, for reference)

- Streaming tool-call arguments parsed incrementally (O(n²) CPU/memory fix, #9265)
- Anthropic tool schemas keep root `$defs` (#9557)
- OpenRouter output-limit margin (no more spurious context-overflow compaction, #10497)
- Zhipu usage-limit 1308 no longer retried as transient 429 (#11537)
- HTTP 413 treated as context overflow (#11016)
- Retry recognition widened (upstream_error / stream_read_error / HTTP2 stream failed)
