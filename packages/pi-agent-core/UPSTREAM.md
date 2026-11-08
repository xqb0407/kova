# UPSTREAM — Kova modifications over the vendored pi source

This package is vendored from earendil-works/pi `v1.5.0`
(`f9a26365568127461c47a07a37dcb42c140a3ac5`). This file tracks every local change so a
re-vendor can replay them, and so they can be turned into upstream PRs.

## How to re-vendor a newer upstream version

1. `git -C <pi-checkout> archive <tag-or-commit> -- packages/agent` | extract to a temp dir.
2. Copy `src/`, `README.md`, `CHANGELOG.md` over this directory (keep this `UPSTREAM.md`,
   `NOTICE.md`, `LICENSE`, and the Kova-written `package.json`).
3. Replay every change listed below. `git diff` against the fresh copy is the source of
   truth: local commits that touch this directory and are not pure re-vendor are Kova
   changes.
4. Update the tag/commit in `NOTICE.md`, run `bun install`, and run the sidecar test suite.

## Kova changes (1.5.0 base)

None yet.
