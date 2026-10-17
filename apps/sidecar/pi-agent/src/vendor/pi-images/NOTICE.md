# NOTICE — third-party derived code

This directory (`apps/sidecar/pi-agent/src/vendor/pi-images/`) contains source code derived from:

- **@earendil-works/pi-durable** v1.3.0
  - Repository: https://github.com/earendil-works/pi
  - License: MIT
  - Copyright: the original authors of the pi monorepo

Files vendored (from the published 1.3.0 package):

- `index.ts` ← `dist/images/index.js` (Photon-backed `ImageProcessor.prepare`)
- `exif.ts` ← `dist/images/exif.js` (EXIF orientation reader)
- `processor.ts` ← `dist/tools/image-processor.d.ts` (types plus `toBase64` / `base64Length` / `INLINE_IMAGE_TYPES`)

Reason: Kova deliberately does not depend on `@earendil-works/pi-durable` (a
different durable runtime), but the sidecar needs pi's exact image policy —
decode, apply EXIF orientation, resize to the model's profile, re-encode at
falling quality until the base64 fits, and convert non-inline formats such as
BMP to PNG. Only this small module is vendored; the Photon runtime itself is
the ordinary `@silvia-odwyer/photon` dependency.

Local modifications:

- Ported the compiled JavaScript to TypeScript with explicit types.
- Added `PROCESSABLE_IMAGE_TYPES` (inline formats plus BMP) so the caller can
  distinguish "providers take this inline" from "we know how to convert it".
- The WASM is embedded by the caller (`src/tools/image-normalize.ts`) through
  `import ... with { type: "file" }`, so the single-file sidecar binary does
  not depend on resolving the Photon package at runtime.
