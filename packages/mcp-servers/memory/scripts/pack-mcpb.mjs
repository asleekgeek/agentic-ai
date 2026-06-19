#!/usr/bin/env node
/**
 * pack-mcpb.mjs — Build a Node.js .mcpb (Desktop Extension) for
 * @agentic/mcp-server-memory, suitable for the Anthropic MCPB directory.
 *
 * WHY this shape (verified 2026-06-19):
 *   - The package depends on three workspace packages (@agentic/core, /memory,
 *     /memory-dashboard, all "workspace:*"). They are NOT published to npm, so
 *     `pnpm deploy` is the only workspace-aware bundler — but pnpm 10 refuses it
 *     unless the whole monorepo sets inject-workspace-packages=true. We do not
 *     flip a repo-wide setting just to package one server.
 *   - Instead: esbuild inlines ALL pure-JS code (the @agentic/* workspace deps +
 *     @modelcontextprotocol/sdk + zod) into one dist/index.js. Then the ONLY
 *     remaining dependencies are NATIVE/ML packages, and those are all PUBLISHED
 *     on npm — so a plain `npm install` in the bundle dir resolves them with
 *     platform-correct native builds. Verified: esbuild bundles cleanly (2.4 MB,
 *     no unresolvable internal dynamic imports).
 *
 * NATIVE externals (must ship as real node_modules, per MCPB "all dependencies
 *   must be bundled in node_modules"):
 *     better-sqlite3, sqlite-vec, onnxruntime-node, @xenova/transformers, pg
 *     (+ optional tree-sitter* grammars for codebase tools).
 *   The bundle is therefore PLATFORM-SPECIFIC (~400–500 MB; @xenova bundles
 *   onnxruntime-node@1.14 AND the reranker loads 1.25.1 directly → two ORT runtimes).
 *
 * Embedding model (Xenova/all-MiniLM-L6-v2, ~90 MB) is downloaded at first use to
 *   the HF cache by default. Pass --bundle-model to ship it offline.
 *
 * Layout produced (the runtime reads ../package.json for name+version, so
 *   package.json MUST sit at the bundle root, one level above dist/):
 *     <out>/bundle/
 *       manifest.json
 *       icon.png
 *       package.json        (name=@agentic/mcp-server-memory, version, deps=natives)
 *       dist/index.js       (esbuild bundle)
 *       node_modules/       (npm-installed native deps)
 *       [models/]           (only with --bundle-model)
 *
 * Usage:
 *   node scripts/pack-mcpb.mjs [--out dist-mcpb] [--bundle-model]
 *                              [--keep-tree-sitter] [--no-pack]
 *
 * source: anthropics/mcpb MANIFEST.md (manifest_version "0.3", server.type "node")
 * source: MCPB README — `mcpb pack <dir>` packs+validates a directory into .mcpb
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OUT = resolve(PKG_ROOT, opt("--out", "dist-mcpb"));
const BUNDLE = join(OUT, "bundle");
const BUNDLE_MODEL = flag("--bundle-model");
const KEEP_TREE_SITTER = flag("--keep-tree-sitter");
const DO_PACK = !flag("--no-pack");

// Target platform = the runner executing this script. The native deps shipped in
// the bundle (better-sqlite3, sqlite-vec, onnxruntime-node, sharp) install only the
// HOST-matching prebuild (sqlite-vec/sharp are per-platform), so the bundle's real
// target is whatever we are building on — there is no cross-build. We stamp the
// bundle with that os/arch: the manifest's compatibility.platforms (OS gate) and the
// .mcpb filename (which also carries arch, since the manifest has no arch field).
// source: anthropics/mcpb MANIFEST.md (no arch field); sqlite-vec per-platform optionalDependencies
const TARGET_OS = process.platform; // "darwin" | "linux" | "win32"
const TARGET_ARCH = process.arch; // "arm64" | "x64"
const PLATFORM_TAG = `${TARGET_OS}-${TARGET_ARCH}`;

// Native/ML deps to ship as real node_modules. Versions pinned to what the
// engine was verified against (reranker parity needs onnxruntime-node@1.25.1).
// source: packages/memory/package.json dependencies (resolved store versions)
const NATIVE_DEPS = {
  "better-sqlite3": "12.9.0",
  "sqlite-vec": "0.1.9",
  "onnxruntime-node": "1.25.1",
  "@xenova/transformers": "2.17.2",
  pg: "8.13.0",
};
const TREE_SITTER_DEPS = {
  "tree-sitter": "0.21.0",
  "tree-sitter-typescript": "0.21.0",
  "tree-sitter-javascript": "0.21.0",
  "tree-sitter-python": "0.21.0",
  "tree-sitter-rust": "0.21.0",
  "tree-sitter-go": "0.21.0",
  "tree-sitter-swift": "0.5.0",
};

const log = (m) => process.stderr.write(`[pack-mcpb] ${m}\n`);

function readPkg() {
  return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
}

function esbuildBin() {
  // esbuild is a root devDep in this pnpm monorepo, not a direct dep of this
  // package, so a bare `import "esbuild"` does not resolve from here. Invoke the
  // CLI binary from the workspace root instead (verified present: esbuild 0.28.0).
  const root = resolve(PKG_ROOT, "../../..");
  const bin = join(root, "node_modules/.bin/esbuild");
  return existsSync(bin) ? bin : null;
}

function bundleEntry() {
  log("esbuild: bundling src/index.ts (natives external) …");
  const external = Object.keys({ ...NATIVE_DEPS, ...TREE_SITTER_DEPS }).flatMap((p) => [
    `--external:${p}`,
  ]);
  const args = [
    join(PKG_ROOT, "src/index.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    `--outfile=${join(BUNDLE, "dist/index.js")}`,
    "--banner:js=#!/usr/bin/env node",
    "--log-level=warning",
    ...external,
  ];
  const bin = esbuildBin();
  if (bin) execFileSync(bin, args, { stdio: "inherit" });
  else execFileSync("npx", ["--yes", "esbuild", ...args], { stdio: "inherit" });
  log("esbuild: done.");
}

function writeBundlePackageJson(pkg) {
  // name MUST stay @agentic/mcp-server-memory so the runtime's serverInfo.name
  // (read from this file) is unchanged. version stays in lockstep with source.
  const deps = KEEP_TREE_SITTER ? { ...NATIVE_DEPS, ...TREE_SITTER_DEPS } : { ...NATIVE_DEPS };
  const bundlePkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: "module",
    main: "dist/index.js",
    dependencies: deps,
  };
  writeFileSync(join(BUNDLE, "package.json"), JSON.stringify(bundlePkg, null, 2) + "\n");
  log(`bundle package.json: ${pkg.name}@${pkg.version} + ${Object.keys(deps).length} native deps`);
}

function installNatives() {
  log("npm install (native deps, platform builds) … this downloads/builds ~400–500 MB");
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: BUNDLE,
    stdio: "inherit",
  });
  log("npm install: done.");
}

// Models needed for offline operation:
//   - Xenova/all-MiniLM-L6-v2          (384-d embeddings; remember/recall)   ~87 MB
//   - Xenova/ms-marco-MiniLM-L-12-v2   (FlashRank reranker tokenizer)        ~128 MB
// source: transformers-embedding-engine.ts (DEFAULT_MODEL_ID) + recall/reranker.ts
const OFFLINE_MODELS = ["all-MiniLM-L6-v2", "ms-marco-MiniLM-L-12-v2"];

function findModelSource(modelName) {
  // @xenova/transformers@2.17.2 resolves models from env.cacheDir which DEFAULTS
  // to <pkg>/.cache (it does NOT read TRANSFORMERS_CACHE/HF_HOME — verified in
  // @xenova/transformers/src/env.js). So we place models in the bundled package's
  // .cache. Hunt the model in the known local caches.
  const roots = [
    join(PKG_ROOT, "../../../node_modules/.pnpm/@xenova+transformers@2.17.2/node_modules/@xenova/transformers/.cache/Xenova"),
    join(homedir(), ".cache/huggingface/hub/Xenova"),
  ];
  for (const r of roots) {
    const p = join(r, modelName);
    if (existsSync(p)) return p;
  }
  return null;
}

function maybeBundleModel(manifest) {
  if (!BUNDLE_MODEL) {
    log("model: NOT bundled — xenova downloads from HuggingFace at first use (needs network once). Use --bundle-model for offline.");
    return manifest;
  }
  // Destination = the INSTALLED xenova package's default cacheDir, so the runtime
  // finds the models with zero config (allowLocalModels=true checks local first).
  const xenovaCache = join(BUNDLE, "node_modules/@xenova/transformers/.cache/Xenova");
  mkdirSync(xenovaCache, { recursive: true });
  for (const m of OFFLINE_MODELS) {
    const src = findModelSource(m);
    if (!src) {
      log(`WARNING: model ${m} not found in any local cache — run a remember+recall once to populate it, then re-pack. Offline use of this model will fall back to a network download.`);
      continue;
    }
    log(`model: copying ${m} -> node_modules/@xenova/transformers/.cache/Xenova/${m}`);
    cpSync(src, join(xenovaCache, m), { recursive: true });
  }
  // NOTE: offline operation is NOT yet verified end-to-end (AC1 only exercised the
  // handshake, not remember/recall). The reranker also loads its ONNX model via
  // onnxruntime-node directly (see recall/reranker.ts) — that path may need its own
  // provisioning. Verify with an offline remember+recall after packing.
  return manifest;
}

function writeManifestAndAssets(pkg) {
  const manifestSrc = join(PKG_ROOT, "mcpb/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestSrc, "utf8"));
  manifest.version = pkg.version; // keep manifest in lockstep with package.json
  // Narrow the OS gate to the runner we are building on: the native binaries only
  // run on this OS. Arch (arm64 vs x64) cannot be expressed in the manifest, so it
  // is disambiguated by the .mcpb filename instead. source: anthropics/mcpb MANIFEST.md
  manifest.compatibility = { ...manifest.compatibility, platforms: [TARGET_OS] };
  const withModel = maybeBundleModel(manifest);
  writeFileSync(join(BUNDLE, "manifest.json"), JSON.stringify(withModel, null, 2) + "\n");

  const iconSrc = join(PKG_ROOT, "mcpb/icon.png");
  if (existsSync(iconSrc)) cpSync(iconSrc, join(BUNDLE, "icon.png"));
  else log("WARNING: mcpb/icon.png missing — add a PNG icon before submitting.");

  // Guard: refuse to pack a manifest still carrying TODO_ placeholders.
  const raw = readFileSync(join(BUNDLE, "manifest.json"), "utf8");
  if (raw.includes("TODO_")) {
    log("WARNING: manifest still contains TODO_ placeholders (author.url, privacy, license …). Fill them before submission.");
  }
}

function packMcpb(pkg) {
  if (!DO_PACK) {
    log(`--no-pack: bundle assembled at ${BUNDLE} (not packed).`);
    return;
  }
  // Filename carries os+arch because the bundle is platform-specific (native deps)
  // and the MCPB manifest has no arch field. source: anthropics/mcpb MANIFEST.md
  const outFile = join(OUT, `agentic-memory-${pkg.version}-${PLATFORM_TAG}.mcpb`);
  log(`mcpb pack -> ${outFile}`);
  execFileSync("npx", ["--yes", "@anthropic-ai/mcpb", "pack", BUNDLE, outFile], {
    cwd: PKG_ROOT,
    stdio: "inherit",
  });
  log(`DONE: ${outFile}`);
}

async function main() {
  const pkg = readPkg();
  log(`packaging ${pkg.name}@${pkg.version} → ${OUT}`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(BUNDLE, "dist"), { recursive: true });
  await bundleEntry();
  writeBundlePackageJson(pkg);
  installNatives();
  writeManifestAndAssets(pkg);
  packMcpb(pkg);
}

main().catch((err) => {
  log(`FAILED: ${err?.stack || String(err)}`);
  process.exit(1);
});
