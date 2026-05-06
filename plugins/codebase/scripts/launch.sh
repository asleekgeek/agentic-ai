#!/usr/bin/env bash
# Launch the automatised-pipeline Rust binary that powers the codebase plugin.
#
# Args:
#   $1 — CLAUDE_PLUGIN_ROOT. Required.
#
# Resolution order (first existing wins; never falls through silently):
#   1. ${PLUGIN_ROOT}/bin/automatised-pipeline-<os>-<arch>
#        Per-platform pre-built artifact shipped with the plugin. <os>-<arch>
#        is computed from `uname -sm` (e.g. darwin-arm64, darwin-x86_64,
#        linux-x86_64, linux-aarch64). This is the zero-build steady state:
#        Claude Code's MCP host gets `initialize` reply within milliseconds,
#        no cargo dependency on the host machine.
#   2. Download from GitHub Releases on first launch.
#        If the platform binary is not in bin/ but the host has curl + network,
#        fetch automatised-pipeline-<os>-<arch> from the latest release and cache
#        it under bin/ for future launches. Source of truth is the workflow
#        .github/workflows/release-codebase-binaries.yml which uploads one
#        binary per host platform on every codebase-v* tag push.
#        Total first-launch cost: ~3-10 s (download) + start-up. Within MCP's
#        30 s connect timeout. After this runs once, stage 1 wins thereafter.
#   3. ${PLUGIN_ROOT}/bin/automatised-pipeline
#        Generic fallback for hosts where the per-platform binary is missing
#        but a manually-placed binary exists (CI / power users / Docker).
#   4. ${PLUGIN_ROOT}/src-rust/target/release/automatised-pipeline
#        Already built from this plugin's vendored Cargo source. This is the
#        steady-state path after the first-run cargo build below.
#   5. cargo build --release in ${PLUGIN_ROOT}/src-rust/ then exec.
#        Last-resort path for unsupported platforms with no network. Requires
#        Rust toolchain. Compilation typically takes 2–5 minutes — this
#        WILL exceed Claude Code's MCP connect timeout (30 s) on first run;
#        the user must restart Claude Code after the build completes.
#
# Notes
# -----
# - We deliberately do NOT fall back to `command -v automatised-pipeline` on PATH.
#   The plugin name collides with at least one third-party Python wrapper of
#   the same name (e.g. /opt/homebrew/bin/automatised-pipeline from the upstream
#   ai-architect Python package), which crashes with ModuleNotFoundError when
#   Claude Code tries to use it as our MCP server. The vendored Rust source
#   under src-rust/ is the only authoritative server for THIS plugin.
# - Stdout is reserved for MCP JSON-RPC framing. All shell diagnostics go to
#   stderr.
#   source: modelcontextprotocol.io/quickstart/server §"Logging in MCP Servers"
set -euo pipefail
PLUGIN_ROOT="${1:?usage: launch.sh <plugin-root>}"

# ── Stage 1: per-platform prebuilt ────────────────────────────────────────
# `uname -s` → Darwin/Linux. `uname -m` → arm64/aarch64/x86_64.
# Normalize to the lowercase-hyphen form we use for binary naming.
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
platform_bin="${PLUGIN_ROOT}/bin/automatised-pipeline-${os}-${arch}"
if [ -x "${platform_bin}" ]; then
  exec "${platform_bin}"
fi

# ── Stage 2: download from GitHub Releases ─────────────────────────────────
# First launch on a host where the binary wasn't shipped in bin/. Fetch from
# the latest tagged release and cache under bin/ for the rest of this plugin's
# lifetime. Bypassed if curl is unavailable or the host has no network.
RELEASE_REPO="cdeust/agentic-ai"
RELEASE_TAG="${AGENTIC_AI_CODEBASE_RELEASE_TAG:-latest}"
asset_name="automatised-pipeline-${os}-${arch}"
if command -v curl >/dev/null 2>&1; then
  url=""
  if [ "${RELEASE_TAG}" = "latest" ]; then
    url="https://github.com/${RELEASE_REPO}/releases/latest/download/${asset_name}"
  else
    url="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/${asset_name}"
  fi
  echo "codebase plugin: fetching prebuilt ${asset_name} from ${url} ..." >&2
  mkdir -p "${PLUGIN_ROOT}/bin"
  tmp="${PLUGIN_ROOT}/bin/.${asset_name}.tmp.$$"
  if curl --fail --location --silent --show-error --max-time 30 \
        --output "${tmp}" "${url}" 2>/dev/null; then
    chmod +x "${tmp}"
    mv "${tmp}" "${platform_bin}"
    echo "codebase plugin: cached ${platform_bin}" >&2
    exec "${platform_bin}"
  else
    rm -f "${tmp}"
    echo "codebase plugin: release download failed — falling through to local build paths." >&2
  fi
fi

# ── Stage 3: generic prebuilt fallback ─────────────────────────────────────
shipped_bin="${PLUGIN_ROOT}/bin/automatised-pipeline"
if [ -x "${shipped_bin}" ]; then
  exec "${shipped_bin}"
fi

# ── Stage 4: previously-cargo-built binary in src-rust/ ────────────────────
src_dir="${PLUGIN_ROOT}/src-rust"
prebuilt_in_src="${src_dir}/target/release/automatised-pipeline"
if [ -x "${prebuilt_in_src}" ]; then
  exec "${prebuilt_in_src}"
fi

# ── Stage 5: last-resort cargo build ───────────────────────────────────────
if ! command -v cargo >/dev/null 2>&1; then
  echo "codebase plugin: no prebuilt binary for ${os}-${arch} and cargo is not installed." >&2
  echo "  Either install Rust:   https://rustup.rs" >&2
  echo "  Or place a binary at:  ${shipped_bin}" >&2
  exit 1
fi

if [ ! -f "${src_dir}/Cargo.toml" ]; then
  echo "codebase plugin: src-rust/Cargo.toml missing — corrupt install?" >&2
  exit 1
fi

echo "codebase plugin: no prebuilt binary for ${os}-${arch}; building from source (~2-5 min)..." >&2
echo "  This first launch will likely exceed Claude Code's 30s MCP connect timeout." >&2
echo "  Restart Claude Code after the build completes." >&2
( cd "${src_dir}" && cargo build --release --quiet >&2 )
exec "${prebuilt_in_src}"
