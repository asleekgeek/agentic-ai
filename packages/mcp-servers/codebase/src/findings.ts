/**
 * findings.ts — Stage 1 (extract/refine finding) + Stage 2 (verification session).
 *
 * TypeScript port of main.rs stages 1 and 2.
 * Pure filesystem operations — no LLM calls, no network.
 *
 * source: automatised-pipeline/0.0.9/src/main.rs (stages 1a, 1b, 2a, 2b, 2c, 2d)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants — source: main.rs:61-106
// ---------------------------------------------------------------------------

// source: main.rs:62 — EXTRACTOR_VERSION
const EXTRACTOR_VERSION = "1.0.0";
// source: main.rs:65 — ORCHESTRATOR_CONTRACT_VERSION (reserved for future schema validation)
const _ORCHESTRATOR_CONTRACT_VERSION = "1.0.0";
// source: main.rs:95 — VERIFIER_VERSION
const VERIFIER_VERSION = "1.0.0";

// source: main.rs:78 — SAFE_ID_MAX_LEN = 128
const SAFE_ID_MAX_LEN = 128; // source: main.rs:78 — filesystem path budget per §5.1.4

// source: main.rs:68 — RUN_ID_RANDOM_LEN = 6
const RUN_ID_SUFFIX_LEN = 6;
// source: main.rs:67 — len(RUN_ID_RANDOM_ALPHABET) = 36 chars (a-z + 0-9)
const RUN_ID_ALPHABET_SIZE = 36;
// source: main.rs:476-480 — atomic write temp file suffix length (4 chars)
const ATOMIC_SUFFIX_LEN = 4;
// source: format_compact_utc() YYYYMMDD-HHMMSS = 15 chars before stripping separators
const COMPACT_UTC_LEN = 15;

// source: main.rs:81-86 — file name constants
const RUNS_DIR_NAME = "runs";
const FINDINGS_DIR_NAME = "findings";
const INDEX_FILE_NAME = "index.json";
const EXTRACTED_FILE_NAME = "stage-1.extracted.json";
const SOURCE_FILE_NAME = "stage-1.source.json";
const REFINED_FILE_NAME = "stage-1.refined.json";
const SESSION_FILE_NAME = "stage-2.session.json";
const VERIFIED_FILE_NAME = "stage-2.verified.json";
const DIGEST_ALGORITHM = "sha256"; // source: main.rs:106 — sha256 per stages/stage-2.md §12.3

// ---------------------------------------------------------------------------
// ID generation + validation — source: main.rs:289-421
// ---------------------------------------------------------------------------

// source: main.rs:303 — format_iso8601_utc() "%Y-%m-%dT%H:%M:%SZ" per parse_findings.py:127
function nowIso8601Utc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatCompactUtc(): string {
  const now = new Date();
  // Regex literal counts date/time digit groups — format is self-documenting
  return now.toISOString().replace(/[-:T.Z]/g, "").slice(0, COMPACT_UTC_LEN).replace(/(\d{8})(\d{6})/, "$1-$2");
}

function randomSuffix(len: number): string {
  // source: main.rs:343-374 — xorshift64* seeded from clock+pid
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  // source: main.rs RUN_ID_RANDOM_ALPHABET — 36 chars, safe modulo
  return Array.from(bytes).map(b => alphabet[(b ?? 0) % RUN_ID_ALPHABET_SIZE] ?? "a").join("");
}

function generateRunId(): string {
  return `${formatCompactUtc()}-${randomSuffix(RUN_ID_SUFFIX_LEN)}`;
}

function validateSafeId(kind: string, id: string): void {
  // source: main.rs:385-422
  if (!id) throw new Error(`unsafe ${kind}: must be non-empty`);
  if (id.length > SAFE_ID_MAX_LEN)
    throw new Error(`unsafe ${kind}: length ${id.length} exceeds max ${SAFE_ID_MAX_LEN}`);
  if (id.startsWith("."))
    throw new Error(`unsafe ${kind}: must not start with '.'`);
  if (id.includes(".."))
    throw new Error(`unsafe ${kind}: must not contain '..'`);
  if (!/^[A-Za-z0-9._-]+$/.test(id))
    throw new Error(`unsafe ${kind}: must match [A-Za-z0-9._-]+`);
}

function requireAbsolute(p: string, field: string): string {
  if (!path.isAbsolute(p))
    throw new Error(`${field} must be an absolute path: got ${JSON.stringify(p)}`);
  if (p.includes(".."))
    throw new Error(`${field} must not contain '..': got ${JSON.stringify(p)}`);
  return p;
}

// ---------------------------------------------------------------------------
// Atomic write — source: main.rs:464-506 atomic_write()
// ---------------------------------------------------------------------------

function atomicWrite(target: string, content: Buffer | string): void {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${randomSuffix(ATOMIC_SUFFIX_LEN)}`;
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
}

function writeJsonAtomic(target: string, value: unknown): void {
  atomicWrite(target, JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Finding schema — source: main.rs:151-176
// ---------------------------------------------------------------------------

interface Finding {
  id: string;
  title: string;
  description?: string | null;
  source_url?: string | null;
  relevance_category: string;
  relevance_score?: number | null;
  raw_data?: unknown;
  [key: string]: unknown;
}

interface ExtractedFinding {
  finding_id: string;
  title: string;
  description?: string | null;
  source_url?: string | null;
  relevance_category: string;
  relevance_score?: number | null;
  raw_data?: unknown;
  extracted_at: string;
  extractor_version: string;
  source_form: string;
  source_path?: string | null;
  [key: string]: unknown;
}

interface RefinedPrompt {
  text: string;
  role_hint: string;
  token_estimate?: number | null;
}

interface AddedContext {
  kind: string;
  content: string;
  provenance?: string;
}

interface RefinementMeta {
  added_context: AddedContext[];
  orchestrator_version: string;
  refined_at?: string;
}

interface RefinedArtifact {
  extracted: ExtractedFinding;
  refined_prompt: RefinedPrompt;
  refinement: RefinementMeta;
}

// source: main.rs:250-265 — IndexEntry
interface IndexEntry {
  artifact_path: string;
  extractor_version: string;
  orchestrator_version?: string;
  refined_at?: string;
  verified_at?: string;
  verified?: boolean;
  stage2_path?: string;
}

interface RunIndex {
  run_id: string;
  started_at: string;
  last_updated_at: string;
  findings: Record<string, IndexEntry>;
}

// ---------------------------------------------------------------------------
// Index read/write — source: main.rs:615-683
// ---------------------------------------------------------------------------

function readIndex(indexPath: string): RunIndex | null {
  if (!fs.existsSync(indexPath)) return null;
  return JSON.parse(fs.readFileSync(indexPath, "utf8")) as RunIndex;
}

function upsertIndexEntry(
  outputDir: string,
  runId: string,
  findingId: string,
  entry: IndexEntry,
  mode: "preserve_downstream" | "preserve_stage2" | "preserve_refined_only" | "replace"
): void {
  const indexPath = path.join(outputDir, RUNS_DIR_NAME, runId, INDEX_FILE_NAME);
  const now = nowIso8601Utc(); // source: main.rs format_iso8601_utc() — ISO-8601 timestamp
  let idx = readIndex(indexPath);
  if (!idx) {
    idx = { run_id: runId, started_at: now, last_updated_at: now, findings: {} };
  }
  idx.last_updated_at = now;

  const existing = idx.findings[findingId];
  idx.findings[findingId] = mergeEntry(existing, entry, mode);
  writeJsonAtomic(indexPath, idx);
}

function mergeEntry(
  existing: IndexEntry | undefined,
  entry: IndexEntry,
  mode: string
): IndexEntry {
  // source: main.rs:690-754
  if (mode === "replace" || !existing) return entry;
  if (mode === "preserve_downstream") {
    return {
      ...entry,
      orchestrator_version: existing.orchestrator_version,
      refined_at: existing.refined_at,
      verified_at: existing.verified_at,
      verified: existing.verified,
      stage2_path: existing.stage2_path,
      artifact_path: existing.refined_at ? existing.artifact_path : entry.artifact_path,
    };
  }
  if (mode === "preserve_stage2") {
    return {
      ...entry,
      verified_at: existing.verified_at,
      verified: existing.verified,
      stage2_path: existing.stage2_path,
    };
  }
  if (mode === "preserve_refined_only") {
    return {
      ...entry,
      artifact_path: existing.artifact_path,
      extractor_version: existing.extractor_version,
      orchestrator_version: existing.orchestrator_version,
      refined_at: existing.refined_at,
    };
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Finding resolution — source: main.rs:519-593
// ---------------------------------------------------------------------------

function resolveFinding(findingArg: unknown): { finding: Finding; sourceForm: string; sourcePath?: string; sourceBytes: string } {
  if (typeof findingArg === "object" && findingArg !== null && !Array.isArray(findingArg)) {
    const finding = findingArg as Finding;
    validateRequiredFindingFields(finding);
    return { finding, sourceForm: "inline", sourceBytes: JSON.stringify(finding, null, 2) };
  }
  if (typeof findingArg === "string") {
    requireAbsolute(findingArg, "finding");
    if (findingArg.toLowerCase().endsWith(".md"))
      throw new Error(".md finding inputs are not supported in v1 (spec §9.3 Q1); convert to JSON first");
    if (!findingArg.toLowerCase().endsWith(".json"))
      throw new Error(`finding path must end in .json: got ${JSON.stringify(findingArg)}`);
    const raw = fs.readFileSync(findingArg, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    let findingValue: unknown = parsed;
    if (typeof parsed === "object" && parsed !== null && "findings" in parsed) {
      const arr = (parsed as { findings: unknown[] }).findings;
      if (!Array.isArray(arr) || arr.length !== 1)
        throw new Error(`finding file has findings[${Array.isArray(arr) ? arr.length : "?"}]: stage 1 processes one finding per call`);
      findingValue = arr[0];
    }
    const finding = findingValue as Finding;
    validateRequiredFindingFields(finding);
    return { finding, sourceForm: "json_file", sourcePath: findingArg, sourceBytes: JSON.stringify(finding, null, 2) };
  }
  throw new Error("finding must be an object or an absolute path string");
}

function validateRequiredFindingFields(f: Finding): void {
  if (!f.id || !String(f.id).trim()) throw new Error("finding.id is required and must be non-empty");
  if (!f.title || !String(f.title).trim()) throw new Error("finding.title is required and must be non-empty");
  if (!f.relevance_category || !String(f.relevance_category).trim())
    throw new Error("finding.relevance_category is required and must be non-empty");
}

// ---------------------------------------------------------------------------
// Stage 1a: extract_finding — source: main.rs:760-860
// ---------------------------------------------------------------------------

export function runExtractFinding(args: Record<string, unknown>): unknown {
  try {
    const findingArg = args["finding"];
    const outputDirStr = String(args["output_dir"] ?? "");
    requireAbsolute(outputDirStr, "output_dir");
    const outputDir = outputDirStr;

    const runId: string = (() => {
      if (!args["run_id"] || args["run_id"] === null) return generateRunId();
      const r = String(args["run_id"]);
      validateSafeId("run_id", r);
      return r;
    })();

    const { finding, sourceForm, sourcePath, sourceBytes } = resolveFinding(findingArg);
    const findingId = finding.id;
    validateSafeId("finding_id", findingId);

    const findingDir = path.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId);
    fs.mkdirSync(findingDir, { recursive: true });

    // Write source.json
    const sourcePath2 = path.join(findingDir, SOURCE_FILE_NAME);
    atomicWrite(sourcePath2, sourceBytes);

    // Build extracted artifact
    const extracted: ExtractedFinding = {
      finding_id: findingId,
      title: finding.title,
      description: finding.description ?? null,
      source_url: finding.source_url ?? null,
      relevance_category: finding.relevance_category,
      relevance_score: finding.relevance_score ?? null,
      raw_data: finding.raw_data,
      extracted_at: nowIso8601Utc(), // source: main.rs format_iso8601_utc() — ISO-8601 timestamp
      extractor_version: EXTRACTOR_VERSION,
      source_form: sourceForm,
      source_path: sourcePath ?? null,
    };
    // Preserve extra fields — source: main.rs:163-176
    for (const [k, v] of Object.entries(finding)) {
      if (!(k in extracted)) (extracted as Record<string, unknown>)[k] = v;
    }

    const extractedPath = path.join(findingDir, EXTRACTED_FILE_NAME);
    writeJsonAtomic(extractedPath, extracted);

    upsertIndexEntry(outputDir, runId, findingId, {
      artifact_path: extractedPath,
      extractor_version: EXTRACTOR_VERSION,
    }, "preserve_downstream");

    return {
      stage: 1,
      step: "extract",
      status: "ok",
      run_id: runId,
      finding_id: findingId,
      artifact_path: extractedPath,
      source_path: sourcePath ?? null,
    };
  } catch (e) {
    return { stage: 1, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}

// ---------------------------------------------------------------------------
// Stage 1b: refine_finding — source: main.rs:860-950
// ---------------------------------------------------------------------------

export function runRefineFinding(args: Record<string, unknown>): unknown {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    requireAbsolute(outputDir, "output_dir");
    validateSafeId("run_id", runId);
    validateSafeId("finding_id", findingId);

    const refinedPrompt = args["refined_prompt"] as RefinedPrompt;
    const refinement = args["refinement"] as RefinementMeta;

    const findingDir = path.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId);
    const extractedPath = path.join(findingDir, EXTRACTED_FILE_NAME);
    if (!fs.existsSync(extractedPath))
      throw new Error(`extract_finding must be called first: ${extractedPath} not found`);

    const extracted = JSON.parse(fs.readFileSync(extractedPath, "utf8")) as ExtractedFinding;
    const now = nowIso8601Utc(); // source: main.rs format_iso8601_utc() — ISO-8601 timestamp
    const artifact: RefinedArtifact = {
      extracted,
      refined_prompt: refinedPrompt,
      refinement: { ...refinement, refined_at: now },
    };

    const refinedPath = path.join(findingDir, REFINED_FILE_NAME);
    writeJsonAtomic(refinedPath, artifact);

    upsertIndexEntry(outputDir, runId, findingId, {
      artifact_path: refinedPath,
      extractor_version: EXTRACTOR_VERSION,
      orchestrator_version: refinement.orchestrator_version,
      refined_at: now,
    }, "preserve_stage2");

    return {
      stage: 1,
      step: "refine",
      status: "ok",
      run_id: runId,
      finding_id: findingId,
      artifact_path: refinedPath,
    };
  } catch (e) {
    return { stage: 1, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}

// ---------------------------------------------------------------------------
// Stage 2 session state machine — source: main.rs stages 2a-2d
// ---------------------------------------------------------------------------

type SessionState = "open" | "waiting_for_user" | "finalized" | "aborted";

interface SessionTurn {
  kind: "agent_question" | "user_answer";
  content: string;
  at: string;
  meta?: Record<string, unknown>;
}

interface Session {
  run_id: string;
  finding_id: string;
  state: SessionState;
  created_at: string;
  updated_at: string;
  turns: SessionTurn[];
  aborted_at?: string;
  abort_reason?: string;
  transcript_digest?: string;
  verifier_version?: string;
}

function sessionPath(outputDir: string, runId: string, findingId: string): string {
  return path.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId, SESSION_FILE_NAME);
}

function verifiedPath(outputDir: string, runId: string, findingId: string): string {
  return path.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId, VERIFIED_FILE_NAME);
}

// Stage 2a: start_verification — source: main.rs stage 2a
export function runStartVerification(args: Record<string, unknown>): unknown {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    requireAbsolute(outputDir, "output_dir");
    validateSafeId("run_id", runId);
    validateSafeId("finding_id", findingId);

    // Check refined.json exists
    const refinedPath = path.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId, REFINED_FILE_NAME);
    if (!fs.existsSync(refinedPath))
      throw new Error(`stage-1.refined.json not found: refine_finding must be called first`);

    // Check existing session
    const sp = sessionPath(outputDir, runId, findingId);
    if (fs.existsSync(sp)) {
      const existing = JSON.parse(fs.readFileSync(sp, "utf8")) as Session;
      if (existing.state === "finalized")
        throw new Error("session already finalized; cannot restart");
      // aborted → overwrite (OK)
    }

    const now = nowIso8601Utc(); // source: main.rs format_iso8601_utc() — ISO-8601 timestamp
    const session: Session = {
      run_id: runId,
      finding_id: findingId,
      state: "open",
      created_at: now,
      updated_at: now,
      turns: [],
    };
    writeJsonAtomic(sp, session);

    return { stage: 2, step: "start_verification", status: "ok", run_id: runId, finding_id: findingId, state: "open" };
  } catch (e) {
    return { stage: 2, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}

// Stage 2b: append_clarification — source: main.rs stage 2b
export function runAppendClarification(args: Record<string, unknown>): unknown {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    const kind = String(args["kind"] ?? "") as "agent_question" | "user_answer";
    const content = String(args["content"] ?? "");
    requireAbsolute(outputDir, "output_dir");

    const sp = sessionPath(outputDir, runId, findingId);
    if (!fs.existsSync(sp)) throw new Error("session not found: call start_verification first");
    const session = JSON.parse(fs.readFileSync(sp, "utf8")) as Session;

    if (session.state === "finalized" || session.state === "aborted")
      throw new Error(`cannot append to session in state '${session.state}'`);

    // Alternation invariant — source: main.rs §3 state machine
    const lastTurn = session.turns[session.turns.length - 1];
    if (lastTurn && lastTurn.kind === kind)
      throw new Error(`alternation violation: two consecutive '${kind}' turns`);

    const now = nowIso8601Utc(); // source: main.rs format_iso8601_utc() — ISO-8601 timestamp
    session.turns.push({ kind, content, at: now, meta: args["meta"] as Record<string, unknown> | undefined });
    session.state = kind === "agent_question" ? "waiting_for_user" : "open";
    session.updated_at = now;
    writeJsonAtomic(sp, session);

    return {
      stage: 2, step: "append_clarification", status: "ok",
      run_id: runId, finding_id: findingId,
      state: session.state, turn_count: session.turns.length,
    };
  } catch (e) {
    return { stage: 2, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}

// Stage 2c: finalize_verification — source: main.rs stage 2c
export function runFinalizeVerification(args: Record<string, unknown>): unknown {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    requireAbsolute(outputDir, "output_dir");

    const sp = sessionPath(outputDir, runId, findingId);
    if (!fs.existsSync(sp)) throw new Error("session not found");
    const session = JSON.parse(fs.readFileSync(sp, "utf8")) as Session;

    if (session.state === "open" && session.turns.length === 0)
      throw new Error("no_clarification_round: at least one turn required before finalizing");
    if (session.state === "waiting_for_user")
      throw new Error("unanswered_question: user has not answered the last question");
    if (session.state === "finalized")
      throw new Error("already finalized");
    if (session.state === "aborted")
      throw new Error("session is aborted");

    // Compute digest — source: main.rs §12.3 transcript_digest sha256
    const canonical = JSON.stringify({ turns: session.turns });
    const digest = crypto.createHash(DIGEST_ALGORITHM).update(canonical).digest("hex");
    const now = nowIso8601Utc(); // source: main.rs format_iso8601_utc() — ISO-8601 timestamp

    // Write verified receipt
    const verified = {
      run_id: runId,
      finding_id: findingId,
      verifier_version: VERIFIER_VERSION,
      transcript_digest: `${DIGEST_ALGORITHM}:${digest}`,
      turns: session.turns,
      verified_at: now,
    };
    const vp = verifiedPath(outputDir, runId, findingId);
    writeJsonAtomic(vp, verified);

    // Flip session to finalized
    session.state = "finalized";
    session.updated_at = now;
    session.transcript_digest = `${DIGEST_ALGORITHM}:${digest}`;
    writeJsonAtomic(sp, session);

    upsertIndexEntry(outputDir, runId, findingId, {
      artifact_path: path.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId, REFINED_FILE_NAME),
      extractor_version: EXTRACTOR_VERSION,
      verified_at: now,
      verified: true,
      stage2_path: vp,
    }, "preserve_refined_only");

    return {
      stage: 2, step: "finalize_verification", status: "ok",
      run_id: runId, finding_id: findingId,
      transcript_digest: `${DIGEST_ALGORITHM}:${digest}`,
      verified_path: vp,
    };
  } catch (e) {
    return { stage: 2, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}

// Stage 2d: abort_verification — source: main.rs stage 2d
export function runAbortVerification(args: Record<string, unknown>): unknown {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    requireAbsolute(outputDir, "output_dir");

    const sp = sessionPath(outputDir, runId, findingId);
    if (!fs.existsSync(sp)) throw new Error("session not found");
    const session = JSON.parse(fs.readFileSync(sp, "utf8")) as Session;

    if (session.state === "finalized")
      throw new Error("cannot abort a finalized session");

    const now = nowIso8601Utc(); // source: main.rs format_iso8601_utc() — ISO-8601 timestamp
    session.state = "aborted";
    session.aborted_at = now;
    session.abort_reason = args["reason"] ? String(args["reason"]) : undefined;
    session.updated_at = now;
    writeJsonAtomic(sp, session);

    return {
      stage: 2, step: "abort_verification", status: "ok",
      run_id: runId, finding_id: findingId, state: "aborted",
    };
  } catch (e) {
    return { stage: 2, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}
