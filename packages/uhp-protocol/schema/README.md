# UHP machine-readable schema

Pinned protocol version: **2026-10-19**.

Official artifacts:

- <https://unifiedharnessprotocol.org/schema/uhp-2026-10-19.openapi.yaml>
- <https://unifiedharnessprotocol.org/schema/uhp-2026-10-19.schema.json>

They are not committed by default because they are large and versioned by the
upstream project. Refresh them with:

```bash
bun run uhp:sync-schema
```

The script writes each artifact plus a `.sha256` sidecar. CI can verify the
sidecars when the files are present.

The runtime server/client in this repository uses the TypeScript contract in
`src/` as the source of truth; the official schema is for drift detection and
for generating external clients. The official conformance suite bundles the
schema it tests against, so the test path does not depend on these downloads.
