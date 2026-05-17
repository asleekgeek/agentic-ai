#!/usr/bin/env node
/**
 * Classify each JSONL line on stdin via the TS port's classifyMemoryFull.
 * Emits JSONL on stdout with the input id + the full Classification (or
 * null when rejected).
 *
 * Usage:
 *   node classify-ts.mjs < sample.jsonl > ts-results.jsonl
 */

import readline from "node:readline";
import {
  classifyMemoryFull,
} from "../../packages/memory/dist/wiki/page-classifier.js";

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const tags = Array.isArray(row.tags) ? row.tags : [];
  let result = null;
  let error = null;
  try {
    result = classifyMemoryFull(String(row.content ?? ""), tags);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  process.stdout.write(
    JSON.stringify({
      id: row.id,
      classification: result,
      error,
    }) + "\n",
  );
}
