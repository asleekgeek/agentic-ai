#!/usr/bin/env node
/**
 * Compare two JSONL classification dumps and report:
 *   - distribution of (kind, lifecycle, audience, provenance) per side
 *   - per-axis disagreement counts
 *   - sample of N disagreements per axis (first observed)
 *   - rejection rate per side (classification: null)
 *
 * Usage:
 *   node compare.mjs <ts-results.jsonl> <py-results.jsonl> [N]
 *
 *   N (default 10) caps the per-axis examples surfaced.
 */

import fs from "node:fs";
import readline from "node:readline";

const [, , tsPath, pyPath, nRaw] = process.argv;
if (!tsPath || !pyPath) {
  console.error("usage: compare.mjs <ts-results.jsonl> <py-results.jsonl> [N]");
  process.exit(2);
}
const sampleCap = Number.parseInt(nRaw ?? "10", 10);

async function loadJsonl(path) {
  const map = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    map.set(row.id, row);
  }
  return map;
}

function emptyDist() {
  return new Map();
}

function bump(dist, key) {
  dist.set(key, (dist.get(key) ?? 0) + 1);
}

function sortDist(dist) {
  return [...dist.entries()].sort((a, b) => b[1] - a[1]);
}

const ts = await loadJsonl(tsPath);
const py = await loadJsonl(pyPath);

const ids = [...ts.keys()].filter((id) => py.has(id));
console.error(`# loaded ts=${ts.size} py=${py.size} intersect=${ids.length}`);

const tsKind = emptyDist();
const pyKind = emptyDist();
const tsLifecycle = emptyDist();
const pyLifecycle = emptyDist();
const tsProvenance = emptyDist();
const pyProvenance = emptyDist();
let tsRejected = 0;
let pyRejected = 0;

const disagreements = {
  admission: [],
  kind: [],
  lifecycle: [],
  provenance: [],
};

for (const id of ids) {
  const t = ts.get(id);
  const p = py.get(id);
  const tc = t?.classification ?? null;
  const pc = p?.classification ?? null;

  if (tc === null) tsRejected += 1;
  if (pc === null) pyRejected += 1;

  if ((tc === null) !== (pc === null)) {
    if (disagreements.admission.length < sampleCap) {
      disagreements.admission.push({
        id,
        ts: tc === null ? "rejected" : "admitted",
        py: pc === null ? "rejected" : "admitted",
      });
    }
    continue;
  }
  if (tc === null && pc === null) continue;

  bump(tsKind, tc.kind);
  bump(pyKind, pc.kind);
  bump(tsLifecycle, tc.lifecycle);
  bump(pyLifecycle, pc.lifecycle);
  bump(tsProvenance, tc.provenance);
  bump(pyProvenance, pc.provenance);

  if (tc.kind !== pc.kind && disagreements.kind.length < sampleCap) {
    disagreements.kind.push({ id, ts: tc.kind, py: pc.kind });
  }
  if (tc.lifecycle !== pc.lifecycle && disagreements.lifecycle.length < sampleCap) {
    disagreements.lifecycle.push({ id, ts: tc.lifecycle, py: pc.lifecycle });
  }
  if (tc.provenance !== pc.provenance && disagreements.provenance.length < sampleCap) {
    disagreements.provenance.push({ id, ts: tc.provenance, py: pc.provenance });
  }
}

function counts(label, ts, py) {
  const allKeys = new Set([...ts.keys(), ...py.keys()]);
  const rows = [...allKeys].map((k) => {
    const t = ts.get(k) ?? 0;
    const p = py.get(k) ?? 0;
    return { key: k, ts: t, py: p, delta: t - p };
  });
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  console.log(`\n## ${label}`);
  console.log(`| value | ts | py | Δ (ts−py) |`);
  console.log(`|-------|----|----|-----------|`);
  for (const r of rows) {
    console.log(`| ${r.key} | ${r.ts} | ${r.py} | ${r.delta >= 0 ? "+" : ""}${r.delta} |`);
  }
}

console.log("# Wiki classification eval — TS port vs Cortex Python");
console.log(`Sample size (intersect): **${ids.length}**`);
console.log(`Rejected (kind=null): ts=${tsRejected} py=${pyRejected}`);

counts("kind distribution", tsKind, pyKind);
counts("lifecycle distribution", tsLifecycle, pyLifecycle);
counts("provenance distribution", tsProvenance, pyProvenance);

let kindMatch = 0;
let lifecycleMatch = 0;
let provenanceMatch = 0;
let bothAdmitted = 0;
let bothRejected = 0;
let admissionMismatch = 0;
for (const id of ids) {
  const tc = ts.get(id).classification ?? null;
  const pc = py.get(id).classification ?? null;
  if (tc === null && pc === null) bothRejected += 1;
  else if (tc === null || pc === null) admissionMismatch += 1;
  else {
    bothAdmitted += 1;
    if (tc.kind === pc.kind) kindMatch += 1;
    if (tc.lifecycle === pc.lifecycle) lifecycleMatch += 1;
    if (tc.provenance === pc.provenance) provenanceMatch += 1;
  }
}

const pct = (n, d) => (d === 0 ? "0" : ((n / d) * 100).toFixed(2));
console.log("\n## Agreement summary");
console.log(`| metric | count | rate |`);
console.log(`|--------|-------|------|`);
console.log(`| both admitted | ${bothAdmitted} | ${pct(bothAdmitted, ids.length)}% |`);
console.log(`| both rejected | ${bothRejected} | ${pct(bothRejected, ids.length)}% |`);
console.log(`| admission mismatch | ${admissionMismatch} | ${pct(admissionMismatch, ids.length)}% |`);
console.log(`| kind agreement (of both-admitted) | ${kindMatch} | ${pct(kindMatch, bothAdmitted)}% |`);
console.log(`| lifecycle agreement | ${lifecycleMatch} | ${pct(lifecycleMatch, bothAdmitted)}% |`);
console.log(`| provenance agreement | ${provenanceMatch} | ${pct(provenanceMatch, bothAdmitted)}% |`);

console.log("\n## Sample disagreements");
for (const [axis, items] of Object.entries(disagreements)) {
  console.log(`\n### ${axis} (showing first ${items.length})`);
  for (const it of items) {
    console.log(`- id=${it.id}: ts=${JSON.stringify(it.ts)} py=${JSON.stringify(it.py)}`);
  }
}
