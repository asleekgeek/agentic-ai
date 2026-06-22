#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-magic-numbers */
/**
 * parity-benchmark — CLI entry point.
 *
 * Usage:
 *   parity-benchmark cortex-locomo [--limit N] [--baseline path] [--dataset path]
 *   parity-benchmark cortex-longmemeval-pg [--limit N] [--variant s|oracle] ...
 *
 * Exit codes:
 *   0 — all measured metrics within ±tolerance_pp of baseline (PASS)
 *   1 — at least one metric regressed beyond tolerance (FAIL)
 *   2 — runtime error (dataset missing, invalid args, etc.)
 *
 * source: cortex main benchmarks/locomo/run_benchmark.py:298-330 — flag parity.
 * source: cortex main benchmarks/longmemeval/run_benchmark.py:440-493 — variant flag.
 */

import { resolve } from "node:path";
import { findLocomoDataset, loadLocomo } from "./locomo-loader.js";
import { runLocomo } from "./locomo-runner.js";
import { runLocomoPg } from "./pg-locomo-runner.js";
import {
  findLongMemEvalDataset,
  loadLongMemEval,
} from "./longmemeval-loader.js";
import { runLongMemEvalPg } from "./pg-longmemeval-runner.js";
import { findBeamDataset, loadBeam } from "./beam-loader.js";
import { runBeamPg, type AssemblerMode } from "./pg-beam-runner.js";
import { scoreResults } from "./scoring.js";
import { loadCortexBaseline } from "./baselines.js";
import {
  buildParityReport,
  renderReport,
  renderAbilityBreakdown,
} from "./report.js";

interface ParsedArgs {
  readonly command: string;
  readonly limit: number | null;
  readonly baseline: string | null;
  readonly dataset: string | null;
  readonly noEmbeddings: boolean;
  readonly variant: "s" | "oracle";
  /** BEAM split selector (default 100K) — cortex-beam-pg only. */
  readonly split: string;
  /**
   * BEAM retrieval mode (default "off" = flat WRRF) — cortex-beam-pg only.
   * "temporal" runs 3-phase assembleContext() with TemporalStageDetector
   * (day-bucket from created_at, gap_hours=24.0), targeting MRR 0.471.
   * "oracle" runs with ExplicitStageDetector (plan_id, targeting MRR 0.429).
   * source: Cortex docs/arxiv-context-assembly/main.tex Table 2
   */
  readonly assembler: AssemblerMode;
}

const DEFAULT_LOCOMO_BASELINE = "parity-oracle/cortex/baselines/locomo.json";
const DEFAULT_LONGMEMEVAL_BASELINE =
  "parity-oracle/cortex/baselines/longmemeval.json";
const DEFAULT_BEAM_BASELINE = "parity-oracle/cortex/baselines/beam.json";
// source: BEAM split identifier — 100K / 10M (Tavakoli et al., ICLR 2026)
const DEFAULT_BEAM_SPLIT = "100K";

function parseArgs(argv: readonly string[]): ParsedArgs {
  const cmd = argv[0] ?? "";
  let limit: number | null = null;
  let baseline: string | null = null;
  let dataset: string | null = null;
  let noEmbeddings = false;
  let variant: "s" | "oracle" = "s";
  let split = DEFAULT_BEAM_SPLIT;
  let assembler: AssemblerMode = "off";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v) limit = parseInt(v, 10);
    } else if (arg === "--baseline" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v) baseline = v;
    } else if (arg === "--dataset" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v) dataset = v;
    } else if (arg === "--variant" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v === "oracle" || v === "s") variant = v;
    } else if (arg === "--split" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v) split = v;
    } else if (arg === "--assembler" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v === "temporal" || v === "oracle" || v === "off") assembler = v;
    } else if (arg === "--no-embeddings") {
      noEmbeddings = true;
    }
  }
  return { command: cmd, limit, baseline, dataset, noEmbeddings, variant, split, assembler };
}

async function runCortexLocomo(args: ParsedArgs): Promise<number> {
  const dsPath = args.dataset ?? findLocomoDataset();
  if (!dsPath) {
    process.stderr.write(
      "ERROR: locomo10.json not found.\n" +
        "  Set CORTEX_LOCOMO_PATH or pass --dataset <path>.\n" +
        "  Default search: ../cortex/benchmarks/locomo/locomo10.json\n",
    );
    return 2;
  }
  process.stderr.write(`Loading dataset: ${dsPath}\n`);
  const conversations = loadLocomo(dsPath);
  const limit = args.limit;
  const total = limit !== null && limit > 0 ? Math.min(limit, conversations.length) : conversations.length;
  process.stderr.write(`Running TS Cortex on ${total} conversation(s)...\n`);
  const start = Date.now();
  if (args.noEmbeddings) {
    process.stderr.write("Note: running in FTS-only mode (--no-embeddings). Vector recall disabled.\n");
  }
  const results = await runLocomo(conversations, {
    limit,
    useEmbeddings: !args.noEmbeddings,
    onProgress: (cur, n) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1); // source: 1000 = ms→s conversion factor (SI)
      process.stderr.write(`  [${cur}/${n}] ${elapsed}s elapsed\n`);
    },
  });
  const elapsedSec = (Date.now() - start) / 1000; // source: 1000 = ms→s conversion factor (SI)
  process.stderr.write(`Scored ${results.length} questions in ${elapsedSec.toFixed(1)}s.\n\n`);
  const scores = scoreResults(results);
  const baseline = loadCortexBaseline(
    resolve(args.baseline ?? DEFAULT_LOCOMO_BASELINE),
  );
  const report = buildParityReport(scores, baseline);
  process.stdout.write(`${renderReport(report)}\n`);
  return report.passed ? 0 : 1;
}

async function runCortexLocomoPg(args: ParsedArgs): Promise<number> {
  const dsPath = args.dataset ?? findLocomoDataset();
  if (!dsPath) {
    process.stderr.write(
      "ERROR: locomo10.json not found.\n" +
        "  Set CORTEX_LOCOMO_PATH or pass --dataset <path>.\n" +
        "  Default search: ../cortex/benchmarks/locomo/locomo10.json\n",
    );
    return 2;
  }
  process.stderr.write(`Loading dataset: ${dsPath}\n`);
  const conversations = loadLocomo(dsPath);
  const limit = args.limit;
  const total = limit !== null && limit > 0 ? Math.min(limit, conversations.length) : conversations.length;
  process.stderr.write(`Running TS Cortex (REAL PostgreSQL) on ${total} conversation(s)...\n`);
  const start = Date.now();
  if (args.noEmbeddings) {
    process.stderr.write("Note: running in FTS-only mode (--no-embeddings). pgvector signal disabled.\n");
  }
  const results = await runLocomoPg(conversations, {
    limit,
    useEmbeddings: !args.noEmbeddings,
    onProgress: (cur, n) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1); // source: 1000 = ms→s conversion factor (SI)
      process.stderr.write(`  [${cur}/${n}] ${elapsed}s elapsed\n`);
    },
  });
  const elapsedSec = (Date.now() - start) / 1000; // source: 1000 = ms→s conversion factor (SI)
  process.stderr.write(`Scored ${results.length} questions in ${elapsedSec.toFixed(1)}s.\n\n`);
  const scores = scoreResults(results);
  const baseline = loadCortexBaseline(
    resolve(args.baseline ?? DEFAULT_LOCOMO_BASELINE),
  );
  const report = buildParityReport(scores, baseline);
  process.stdout.write(`${renderReport(report)}\n`);
  return report.passed ? 0 : 1;
}

async function runCortexLongMemEvalPg(args: ParsedArgs): Promise<number> {
  const dsPath = args.dataset ?? findLongMemEvalDataset(args.variant);
  if (!dsPath) {
    process.stderr.write(
      `ERROR: longmemeval_${args.variant}.json not found.\n` +
        "  Set CORTEX_LONGMEMEVAL_PATH or pass --dataset <path>.\n" +
        "  Default search: ../cortex/benchmarks/longmemeval/longmemeval_<variant>.json\n",
    );
    return 2;
  }
  process.stderr.write(`Loading dataset: ${dsPath}\n`);
  const questions = loadLongMemEval(dsPath);
  const limit = args.limit;
  const total =
    limit !== null && limit > 0
      ? Math.min(limit, questions.length)
      : questions.length;
  process.stderr.write(
    `Running TS Cortex (REAL PostgreSQL) on ${total} question(s)...\n`,
  );
  const start = Date.now();
  if (args.noEmbeddings) {
    process.stderr.write(
      "Note: running in FTS-only mode (--no-embeddings). pgvector signal disabled.\n",
    );
  }
  const results = await runLongMemEvalPg(questions, {
    limit,
    useEmbeddings: !args.noEmbeddings,
    onProgress: (cur, n) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1); // source: 1000 = ms→s conversion factor (SI)
      process.stderr.write(`  [${cur}/${n}] ${elapsed}s elapsed\n`);
    },
  });
  const elapsedSec = (Date.now() - start) / 1000; // source: 1000 = ms→s conversion factor (SI)
  process.stderr.write(
    `Scored ${results.length} questions in ${elapsedSec.toFixed(1)}s.\n\n`,
  );
  const scores = scoreResults(results);
  const baseline = loadCortexBaseline(
    resolve(args.baseline ?? DEFAULT_LONGMEMEVAL_BASELINE),
  );
  const report = buildParityReport(scores, baseline);
  process.stdout.write(`${renderReport(report)}\n`);
  return report.passed ? 0 : 1;
}

async function runCortexBeamPg(args: ParsedArgs): Promise<number> {
  const dsPath = args.dataset ?? findBeamDataset(args.split);
  if (!dsPath) {
    process.stderr.write(
      `ERROR: beam_${args.split}.json not found.\n` +
        "  This split is exported from the HuggingFace Mohammadta/BEAM dataset by\n" +
        // source: cortex main benchmarks/beam/export_100k_json.py (HF dataset -> JSON dump)
        "  cortex/benchmarks/beam/export_100k_json.py (a faithful dump). Run that\n" +
        "  script once, then set CORTEX_BEAM_PATH or pass --dataset <path>.\n" +
        "  Default search: ../cortex/benchmarks/beam/beam_<split>.json\n",
    );
    return 2;
  }
  process.stderr.write(`Loading dataset: ${dsPath}\n`);
  const conversations = loadBeam(dsPath);
  const limit = args.limit;
  const total =
    limit !== null && limit > 0
      ? Math.min(limit, conversations.length)
      : conversations.length;
  process.stderr.write(
    `Running TS Cortex (REAL PostgreSQL) on ${total} BEAM conversation(s)...\n` +
      `Assembler: ${args.assembler} — ` +
      (args.assembler === "temporal"
        ? "3-phase TemporalStageDetector (day-bucket from created_at, gap_hours=24)\n"
        : args.assembler === "oracle"
          ? "3-phase ExplicitStageDetector (plan_id/agent_context)\n"
          : "flat WRRF recall() (no assembler)\n") +
      "Metric: retrieval-proxy MRR (rank of first gold-matching memory) — NOT\n" +
      "the BEAM end-to-end LLM-as-judge score; within-system comparison only.\n",
  );
  const start = Date.now();
  if (args.noEmbeddings) {
    process.stderr.write(
      "Note: running in FTS-only mode (--no-embeddings). pgvector signal disabled.\n",
    );
  }
  const scores = await runBeamPg(conversations, {
    limit,
    useEmbeddings: !args.noEmbeddings,
    assemblerMode: args.assembler,
    onProgress: (cur, n) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1); // source: 1000 = ms→s conversion factor (SI)
      process.stderr.write(`  [${cur}/${n}] ${elapsed}s elapsed\n`);
    },
  });
  const elapsedSec = (Date.now() - start) / 1000; // source: 1000 = ms→s conversion factor (SI)
  process.stderr.write(
    `Scored ${scores.overall.questions} questions in ${elapsedSec.toFixed(1)}s.\n\n`,
  );
  const baseline = loadCortexBaseline(
    resolve(args.baseline ?? DEFAULT_BEAM_BASELINE),
  );
  // Per-ability diagnostic table FIRST — BEAM's overall is the macro mean of
  // these, so this exposes any single ability (e.g. abstention) dragging it.
  process.stdout.write(`${renderAbilityBreakdown(scores)}\n\n`);
  const report = buildParityReport(scores, baseline);
  process.stdout.write(`${renderReport(report)}\n`);
  return report.passed ? 0 : 1;
}

function printUsage(): void {
  process.stderr.write(
    "Usage: parity-benchmark <command> [options]\n" +
      "\n" +
      "Commands:\n" +
      "  cortex-locomo         Run LoCoMo against the TS Cortex (SQLite); compare to baseline.\n" +
      "  cortex-locomo-pg      Run LoCoMo against the TS Cortex (REAL PostgreSQL recall_memories());\n" +
      "                        apples-to-apples vs. the PG-captured baseline. Uses CORTEX_PG_URL.\n" +
      "  cortex-longmemeval-pg Run LongMemEval against the TS Cortex (REAL PostgreSQL); compare to the\n" +
      // source: docs/arxiv-thermodynamic/main.pdf Table tab:benchmarks (published Cortex LongMemEval)
      "                        published baseline (R@10 98.4%, MRR 0.9124). Uses CORTEX_PG_URL.\n" +
      "  cortex-beam-pg        Run BEAM (retrieval-proxy MRR) against the TS Cortex (REAL PostgreSQL);\n" +
      // source: docs/arxiv-thermodynamic/main.pdf — published BEAM-100K retrieval-proxy MRR (paper snapshot)
      "                        compare to the published BEAM-100K proxy MRR 0.591. Uses CORTEX_PG_URL.\n" +
      "                        NOTE: this is a retrieval proxy, NOT BEAM's end-to-end LLM-as-judge score.\n" +
      "\n" +
      "Options:\n" +
      "  --limit N                  Stop after N conversations/questions (default: all)\n" +
      "  --variant s|oracle         LongMemEval dataset variant (default: s) — longmemeval-pg only\n" +
      // source: BEAM split identifier — 100K / 10M (Tavakoli et al., ICLR 2026)
      "  --split SPLIT              BEAM split (default: 100K) — beam-pg only\n" +
      "  --assembler temporal|oracle|off  BEAM retrieval mode (default: off = flat WRRF).\n" +
      "                             temporal: 3-phase + TemporalStageDetector (day-bucket, gap=24h)\n" +
      "                             oracle:   3-phase + ExplicitStageDetector (plan_id)\n" +
      "                             off:      flat recall() WRRF baseline\n" +
      "  --baseline PATH            Override baseline JSON path\n" +
      "  --dataset PATH             Override dataset path (else CORTEX_LOCOMO_PATH / CORTEX_LONGMEMEVAL_PATH / CORTEX_BEAM_PATH or sibling repo)\n" +
      "  --no-embeddings            FTS-only mode (no model download, faster, lower precision)\n",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "cortex-locomo") {
    process.exit(await runCortexLocomo(args));
  }
  if (args.command === "cortex-locomo-pg") {
    process.exit(await runCortexLocomoPg(args));
  }
  if (args.command === "cortex-longmemeval-pg") {
    process.exit(await runCortexLongMemEvalPg(args));
  }
  if (args.command === "cortex-beam-pg") {
    process.exit(await runCortexBeamPg(args));
  }
  printUsage();
  process.exit(args.command ? 2 : 0);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
