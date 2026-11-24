/**
 * Sync the pinned UHP machine-readable schema.
 *
 * The official artifacts are large; keep them out of day-to-day edits and
 * refresh explicitly:
 *   bun run uhp:sync-schema
 *
 * Network access is required. The conformance suite also bundles its own
 * schema, so unit tests do not depend on these files.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "packages", "uhp-protocol", "schema");
const version = "2026-10-19";
const artifacts = [
  {
    name: `uhp-${version}.openapi.yaml`,
    url: `https://unifiedharnessprotocol.org/schema/uhp-${version}.openapi.yaml`,
  },
  {
    name: `uhp-${version}.schema.json`,
    url: `https://unifiedharnessprotocol.org/schema/uhp-${version}.schema.json`,
  },
];

mkdirSync(outDir, { recursive: true });

for (const artifact of artifacts) {
  process.stdout.write(`fetching ${artifact.url}\n`);
  const response = await fetch(artifact.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${artifact.url} -> HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const target = join(outDir, artifact.name);
  writeFileSync(target, bytes);
  writeFileSync(`${target}.sha256`, `${sha256}  ${artifact.name}\n`);
  process.stdout.write(`wrote ${target} (${bytes.byteLength} bytes, sha256 ${sha256})\n`);
}
