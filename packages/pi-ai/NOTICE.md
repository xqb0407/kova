# NOTICE — third-party derived code

This directory contains source code vendored from the upstream project **pi**
(earendil-works/pi), NOT authored by the Kova project.

- **Package**: `@earendil-works/pi-ai`
- **Upstream**: https://github.com/earendil-works/pi (`packages/ai`)
- **Vendored from tag**: `v1.5.2` (commit `c3cc91632d0a1950fb122605b190233f2aa0006e`)
- **License**: MIT — see `LICENSE` in this directory. Upstream copyright: Mario Zechner.

## What is vendored

- `src/` — the full upstream TypeScript source (imports are `.ts`-suffixed relative paths;
  consumed directly as a workspace package, no build step).
- `src/providers/data/*.json` — generated model-catalog data, extracted from the official
  npm tarball `@earendil-works/pi-ai@1.5.2` (`dist/providers/data/`). Upstream regenerates
  these from models.dev et al. via `catalog/` (not vendored); the JSONs are gitignored
  upstream, so they must be re-extracted from the matching npm tarball on every re-vendor.
- `package.json` — rewritten: `exports` point at `src/*.ts`; `@earendil-works/pi-ai`
  dependency of pi-agent-core is `workspace:*`; build/test scripts and devDependencies
  dropped.

## Kova modifications

See `UPSTREAM.md` in this directory for the list of local changes (search for `// KOVA:`
in the source) and the re-vendor procedure.
