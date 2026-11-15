# UPSTREAM — Kova modifications over the vendored pi source

This package is vendored from earendil-works/pi `v1.5.2` plus the post-release fixes up
to `c3cc91632d0a1950fb122605b190233f2aa0006e` (2026-11-15). This file tracks every local
change so a re-vendor can replay them, and so they can be turned into upstream PRs.

## How to re-vendor a newer upstream version

1. `git -C <pi-checkout> archive <tag-or-commit> -- packages/ai` | extract to a temp dir.
2. Copy `src/`, `README.md`, `CHANGELOG.md` over this directory (keep this `UPSTREAM.md`,
   `NOTICE.md`, `LICENSE`, and the Kova-written `package.json`).
3. Re-extract `src/providers/data/*.json` from the **matching-version npm tarball**
   (`dist/providers/data/`) — these JSONs are gitignored upstream and not in git.
   Code is pinned to a commit, but the data can only come from a published tarball: after
   vendoring HEAD `c3cc9163` the shipped data is `1.5.2` (2026-11-10), so models added
   upstream after that release do not appear until a newer tarball exists.
4. Replay every change listed below. `git diff` against the fresh copy is the source of
   truth: local commits that touch this directory and are not pure re-vendor are Kova
   changes.
5. Update the tag/commit in `NOTICE.md`, run `bun install`, and run the sidecar test
   suite.

## Kova changes (1.5.2 base)

### packages/pi-ai

1. **`src/utils/retry.ts`** — `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`: added
   Zhipu/Z.ai error code **1310** (weekly/monthly usage limit, sent as HTTP 429 with a
   reset timestamp) next to the existing 1308 entry, plus the Chinese reset-timing
   sentence (`使用上限`) as a message-shape fallback. Without it, Kova's provider-retry
   loop burns its full retry budget on a terminal quota error. Marked `// KOVA:`.
   *(Candidate for upstream PR — extends #11537 which only covered 1308.)*

2. **`src/utils/estimate.ts`** — `estimateTokens()` / `estimateMessageTokens()`: guard
   `block.text` / `block.thinking` / `block.name` with `typeof … === "string"` before
   reading `.length`. Rationale: a `{type:"text"}` block whose `text` was `undefined`
   serializes to JSON without the field (see `apps/sidecar/pi-agent/src/sessions/transcript.ts`
   "内容块形状归一" comment); the unguarded `.length` threw a TypeError on every subsequent
   request and permanently poisoned the session. Marked `// KOVA:`.
   *(Candidate for upstream PR — upstream issue likely nonexistent yet.)*

3. **`src/api/anthropic-messages.ts`** — skip text blocks whose `text` is not a string
   (`typeof block.text !== "string" || block.text.trim().length === 0`) instead of calling
   `.trim()` unguarded. Same root cause as above. Marked `// KOVA:`.

4. **`src/api/openai-completions.ts`** — same guard in the assistant text-part filter
   (`typeof block.text === "string" && block.text.trim().length > 0`). Marked `// KOVA:`.

> Re-vendor gotcha: `src/utils/estimate.ts` is **unchanged upstream** through 1.5.2, so a
> wholesale `src/` copy silently reverts patch 2. Copy the tree, then restore that one
> file (`git checkout -- packages/pi-ai/src/utils/estimate.ts`).

### packages/pi-agent-core

None yet.

## Upstream fixes Kova depends on (already in 1.5.2, for reference)

- Streaming tool-call arguments parsed incrementally (O(n²) CPU/memory fix, #9265)
- Anthropic tool schemas keep root `$defs` (#9557) and non-strict root `additionalProperties`
- OpenRouter output-limit margin (no more spurious context-overflow compaction, #10497)
- Zhipu usage-limit 1308 no longer retried as transient 429 (#11537)
- HTTP 413 treated as context overflow (#11016)
- Retry recognition widened (upstream_error / stream_read_error / HTTP2 stream failed);
  1.5.1+ also covers Node socket codes (`ECONNRESET`/`EPIPE`/`ETIMEDOUT`), "Connection
  closed.", and streams cut short after the reply began
- `StreamOptions.disableContinuation` and `cleanupSessionResources()`, required because
  1.5.1 turns Anthropic message threads on by default when `sessionId` is present
- Strict tool-limit rejections remembered per session; `strict: "prefer"` falls back
  instead of paying one 400 per turn
- `openai-completions` omits `tools: []` when the history has tool calls (vLLM ≥0.20 /
  LiteLLM 400); older LiteLLM-in-front-of-Anthropic needs
  `compat.requiresToolsWithToolHistory: true`
