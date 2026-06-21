/**
 * Content-addressed filesystem store for full raw tool-output artifacts.
 *
 * When an auto-captured tool output exceeds GIST_BUDGET, the full raw output is
 * written here and the memory body keeps only a gist + a pointer to the artifact
 * path (see core/gist-extraction.ts and docs/provenance/bounded-io-phase2-design.md F3).
 * The artifact is a plain Markdown file loadable by the Read tool — zero new MCP
 * surface, nothing dropped from the corpus.
 *
 * Content addressing (sha256 of the content) makes repeated identical outputs
 * dedup to a single file, and monthly sharding (<yyyy-mm>/) keeps directory
 * fan-out bounded over time.
 *
 * source: cortex main mcp_server/infrastructure/artifact_store.py
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { METHODOLOGY_DIR } from "./config.js";

// source: cortex main mcp_server/infrastructure/artifact_store.py — ARTIFACTS_DIR = METHODOLOGY_DIR / "artifacts"
const ARTIFACTS_DIR = path.join(METHODOLOGY_DIR, "artifacts");

// sha256 hex is 64 chars; the first 16 (64 bits) give a collision-free key for
// the artifact corpus (millions of files → negligible birthday-collision risk)
// while keeping filenames short. Mirrors backfill_helpers.file_hash([:16]).
// source: cortex main mcp_server/infrastructure/artifact_store.py — _ADDRESS_LEN
const ADDRESS_LEN = 16;

/**
 * Write `content` to a content-addressed Markdown artifact, return path.
 *
 * Pre: content is a string. createdAt, if given, dates the monthly shard;
 * defaults to now (UTC).
 * Post: the file `ARTIFACTS_DIR/<yyyy-mm>/<sha256(content)[:16]>.md` exists
 * and holds `content` as UTF-8. Content-addressed: if the file already
 * exists it is NOT rewritten (dedup — identical content maps to one path).
 * Parent directories are created as needed. Returns the artifact path.
 *
 * source: cortex main mcp_server/infrastructure/artifact_store.py:store_artifact
 */
export function storeArtifact(content: string, createdAt?: Date): string {
  const when = createdAt ?? new Date();
  const year = when.getUTCFullYear();
  const month = when.getUTCMonth() + 1;
  const shard = path.join(
    ARTIFACTS_DIR,
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
  );
  const address = crypto
    .createHash("sha256")
    .update(content, "utf-8")
    .digest("hex")
    .slice(0, ADDRESS_LEN);
  const artifactPath = path.join(shard, `${address}.md`);
  if (fs.existsSync(artifactPath)) {
    return artifactPath;
  }
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(artifactPath, content, { encoding: "utf-8" });
  return artifactPath;
}
