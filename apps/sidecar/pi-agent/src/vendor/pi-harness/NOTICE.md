# NOTICE — third-party derived code

This directory (`apps/sidecar/pi-agent/src/vendor/pi-harness/`) contains source code derived from:

- **@earendil-works/pi-agent-core** v0.99.2
  - Repository: https://github.com/earendil-works/pi
  - License: MIT
  - Copyright: the original authors of the pi monorepo

Files vendored (from the installed 0.99.2 package's `dist/harness/`):

- `compaction.ts` ← `dist/harness/compaction/compaction.js` + `dist/harness/messages.js`
- `skills.ts` ← `dist/harness/skills.js` + `dist/harness/system-prompt.js`
  + the five file methods `loadSkills` needs from `dist/harness/env/nodejs.js`

Reason: `@earendil-works/pi-agent-core` 1.0.0 removed its experimental harness
(`AgentHarness`, sessions, compaction, skills, harness tools, etc.). Kova only
needs these small pieces and deliberately keeps the 0.99.2 behavior instead of
depending on `@earendil-works/pi-coding-agent` (CLI/TUI package) or
`@earendil-works/pi-durable` (a different durable runtime).

Local modifications:

- Ported the compiled JavaScript to TypeScript with explicit types.
- `loadSkills` no longer takes a Chord `Context`; the local `ExecutionEnv`
  adapter ignores cancellation/telemetry.
- Kept Kova's malformed-content guards from the previous pi-agent-core patch
  (`typeof block.text === "string"`, etc.) so malformed blocks cannot crash
  compaction.
- `findCutPoint` is narrowed to the message-only entry shape Kova constructs.
- `formatSkillInvocation` and `loadSourcedSkills` were not vendored because Kova
  does not use them.
