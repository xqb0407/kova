/**
 * Worker entry for the PTC sandbox in bundled builds. The sidecar binary is a
 * single `bun build --compile` artifact, so pi-codemode's own worker file is not
 * on disk there; this entry is embedded as an extra build entrypoint and
 * resolved by `codemode-runtime.ts`.
 */
import "@earendil-works/pi-codemode/worker";
