/**
 * backfill-emotional-valence.mjs — one-shot script.
 *
 * Reads every memory from cortex_agentic where emotional_valence = 0,
 * recomputes valence via the VADER pipeline, and UPDATEs in batches.
 *
 * source: Hutto CJ & Gilbert E (2014) "VADER: A Parsimonious Rule-based Model
 *   for Sentiment Analysis of Social Media Text." ICWSM.
 * source: mcp_server/core/emotional_tagging.py:tag_memory_emotions
 *
 * Usage:
 *   node --input-type=module scripts/backfill-emotional-valence.mjs
 *
 * Env:
 *   PG_URL  (defaults to "postgresql://localhost/cortex_agentic")
 */

import pg from "pg";

// ── Inline VADER (mirrors packages/memory/src/shared/vader.ts) ──────────────
// source: Hutto & Gilbert (2014) ICWSM
// source: mcp_server/shared/vader.py

const ALPHA = 15;            // source: Hutto & Gilbert (2014) ICWSM — normalization constant
const N_SCALAR = -0.74;      // source: Hutto & Gilbert (2014) ICWSM Table 2 — negation scalar H4

// source: mcp_server/shared/vader.py:30-97
const LEXICON = {
  error: -2.0, exception: -2.0, traceback: -2.5, failed: -2.5, failure: -2.5,
  bug: -2.0, crash: -3.0, broken: -2.5, timeout: -1.5, denied: -1.5,
  rejected: -1.5, deprecated: -1.0, frustrating: -2.5, annoying: -2.0,
  painful: -2.0, struggle: -1.5, nightmare: -3.0, horrible: -3.0,
  terrible: -3.0, awful: -3.0, hate: -3.0, wtf: -3.0, damn: -2.0,
  ugh: -1.5, argh: -1.5, confusing: -1.5, unclear: -1.0, weird: -1.0,
  bizarre: -1.5, urgent: -1.5, critical: -1.5, blocking: -2.0, outage: -3.0,
  hotfix: -1.5, fixed: 2.0, resolved: 2.0, working: 1.5, success: 2.5,
  passed: 1.5, deployed: 2.0, completed: 2.0, shipped: 2.5, merged: 1.5,
  approved: 1.5, elegant: 2.5, beautiful: 2.5, clean: 1.5, perfect: 3.0,
  excellent: 3.0, awesome: 3.0, great: 2.5, finally: 1.0, breakthrough: 3.0,
  improvement: 1.5, better: 1.5, love: 2.5, happy: 2.0, proud: 2.0,
  satisfying: 2.0, insight: 2.0, discovered: 2.0, realized: 1.5, eureka: 3.0,
  interesting: 1.5,
};

// source: mcp_server/shared/vader.py:102-117
const BOOSTERS = {
  very: 0.293, extremely: 0.293, really: 0.293, absolutely: 0.293,
  incredibly: 0.293, totally: 0.293, completely: 0.293, so: 0.293,
  slightly: -0.293, somewhat: -0.293, barely: -0.293, hardly: -0.293,
};

// source: mcp_server/shared/vader.py:121-146
const NEGATIONS = new Set([
  "not", "no", "never", "neither", "nobody", "nothing", "nowhere", "nor",
  "cannot", "can't", "couldn't", "shouldn't", "wouldn't", "won't",
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "without",
]);

function tokenize(text) {
  return Array.from(text.matchAll(/[a-z]+(?:'t)?/gi), m => m[0].toLowerCase());
}

// source: mcp_server/shared/vader.py:156-201 — vader_compound
function vaderCompound(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return 0.0;
  const sentiments = [];
  for (let i = 0; i < tokens.length; i++) {
    let valence = LEXICON[tokens[i]] ?? 0.0;
    if (valence === 0.0) continue;
    for (let j = Math.max(0, i - 3); j < i; j++) {
      const boost = BOOSTERS[tokens[j]];
      if (boost !== undefined) valence += valence * boost / (i - j);
    }
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (NEGATIONS.has(tokens[j])) { valence *= N_SCALAR; break; }
    }
    sentiments.push(valence);
  }
  if (!sentiments.length) return 0.0;
  const total = sentiments.reduce((a, b) => a + b, 0.0);
  const compound = total / Math.sqrt(total * total + ALPHA);
  return Math.max(-1.0, Math.min(1.0, Math.round(compound * 10000) / 10000));
}

// ── Inline emotion detection (mirrors packages/memory/src/remember/emotional-tagging.ts) ──
// source: mcp_server/core/emotional_tagging.py:detect_emotions

const ERROR_DOMAIN_RE = /\b(error|exception|traceback|failed|failure|bug|crash|broken|timeout|denied|rejected|deprecated|hours? debugging|still broken|keeps? failing|won'?t work)\b/gi;
const SUCCESS_DOMAIN_RE = /\b(fixed|resolved|working|success|passed|deployed|completed|shipped|merged|approved|nailed|breakthrough|elegant|beautiful|clean|perfect|excellent|awesome|improvement)\b/gi;
const QUESTION_MARKERS_RE = /\?|\b(confus|unclear|don'?t understand|makes no sense|weird|bizarre|unexpected|strange|mysterious|puzzling|why does|how come|what the)\b/gi;
const URGENCY_DOMAIN_RE = /\b(urgent|critical|blocking|deadline|asap|immediately|production|outage|down|hotfix|p0|sev[- ]?1)\b/gi;
const INSIGHT_DOMAIN_RE = /\b(realized|discovered|found out|turns out|TIL|interesting|insight|key finding|important lesson|aha|eureka|lightbulb)\b/gi;

function countMatches(re, content) {
  re.lastIndex = 0;
  const m = content.match(re);
  return m ? Math.min(m.length, 3) : 0;
}

function detectEmotions(content) {
  const compound = vaderCompound(content);
  const abs = Math.abs(compound);
  const errorHits = countMatches(ERROR_DOMAIN_RE, content);
  const successHits = countMatches(SUCCESS_DOMAIN_RE, content);
  const questionHits = countMatches(QUESTION_MARKERS_RE, content);
  const urgencyHits = countMatches(URGENCY_DOMAIN_RE, content);
  const insightHits = countMatches(INSIGHT_DOMAIN_RE, content);

  let frustration = 0.0;
  if (compound < 0 && errorHits > 0) frustration = abs * (errorHits / 3.0);
  else if (errorHits >= 1) frustration = 0.2 * (errorHits / 3.0);

  let satisfaction = 0.0;
  if (compound > 0 && successHits > 0) satisfaction = abs * (successHits / 3.0);
  else if (successHits >= 1) satisfaction = 0.2 * (successHits / 3.0);

  let confusion = 0.0;
  if (questionHits > 0) {
    const cf = Math.max(0.0, 1.0 - abs * 2);
    confusion = cf * (questionHits / 3.0);
  }

  let urgency = 0.0;
  if (urgencyHits > 0) {
    const nw = compound <= 0 ? Math.max(0.3, abs) : 0.3;
    urgency = nw * (urgencyHits / 3.0);
  }

  let discovery = 0.0;
  if (insightHits > 0) {
    const pw = compound >= 0 ? Math.max(0.3, abs) : 0.3;
    discovery = pw * (insightHits / 3.0);
  }

  return { frustration, satisfaction, confusion, urgency, discovery };
}

// source: mcp_server/core/emotional_tagging.py:compute_emotional_valence
function computeEmotionalValence(emotions) {
  const positive = emotions.satisfaction + emotions.discovery;
  const negative = emotions.frustration + emotions.urgency;
  const total = positive + negative + emotions.confusion;
  if (total === 0) return 0.0;
  return Math.max(-1.0, Math.min(1.0, Math.round(((positive - negative) / Math.max(total, 1.0)) * 10000) / 10000));
}

// ── Backfill ─────────────────────────────────────────────────────────────────

const PG_URL = process.env["PG_URL"] ?? "postgresql://localhost/cortex_agentic";
const BATCH_SIZE = 200;

const client = new pg.Client({ connectionString: PG_URL });
await client.connect();

const { rows } = await client.query("SELECT id, content FROM memories ORDER BY id");
console.log(`Fetched ${rows.length} memories for backfill`);

let updated = 0;
let skipped = 0;
let i = 0;

while (i < rows.length) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  // Build UPDATE ... FROM (VALUES ...) style for efficiency
  const values = [];
  const params = [];
  let pi = 1;
  for (const row of batch) {
    const v = computeEmotionalValence(detectEmotions(row.content ?? ""));
    values.push(`($${pi++}::int, $${pi++}::real)`);
    params.push(row.id, v);
    if (v !== 0.0) updated++;
    else skipped++;
  }
  if (values.length > 0) {
    await client.query(
      `UPDATE memories SET emotional_valence = v.val
       FROM (VALUES ${values.join(",")}) AS v(id, val)
       WHERE memories.id = v.id`,
      params,
    );
  }
  i += BATCH_SIZE;
  process.stdout.write(`  processed ${Math.min(i, rows.length)}/${rows.length}\r`);
}

console.log(`\nBackfill complete: ${updated} non-zero, ${skipped} remain 0`);

// Post-backfill stats
const stats = await client.query(`
  SELECT
    COUNT(DISTINCT emotional_valence) AS distinct_vals,
    COUNT(*) FILTER (WHERE emotional_valence > 0) AS pos,
    COUNT(*) FILTER (WHERE emotional_valence < 0) AS neg,
    MIN(emotional_valence) AS min_val,
    MAX(emotional_valence) AS max_val
  FROM memories
`);
console.log("Post-backfill stats:", stats.rows[0]);

await client.end();
