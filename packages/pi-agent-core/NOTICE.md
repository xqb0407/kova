# NOTICE — third-party derived code

This directory contains source code vendored from the upstream project **pi**
(earendil-works/pi), NOT authored by the Kova project.

- **Package**: `@earendil-works/pi-agent-core`
- **Upstream**: https://github.com/earendil-works/pi (`packages/agent`)
- **Vendored from tag**: `v1.5.0` (commit `f9a26365568127461c47a07a37dcb42c140a3ac5`)
- **License**: MIT — see `LICENSE` in this directory. Upstream copyright: Mario Zechner.

## What is vendored

- `src/` — the full upstream TypeScript source (6 files; imports are `.ts`-suffixed
  relative paths; consumed directly as a workspace package, no build step).
- `package.json` — rewritten: `exports` point at `src/index.ts`; `@earendil-works/pi-ai`
  is `workspace:*` (resolved to the vendored sibling); build/test scripts and
  devDependencies dropped.

## Kova modifications

See `UPSTREAM.md` in this directory for the list of local changes (search for `// KOVA:`
in the source) and the re-vendor procedure.
