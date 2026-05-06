#!/usr/bin/env bash
# Launch the ai-architect-mcp Rust binary that powers the codebase plugin.
#
# Args:
#   $1 — CLAUDE_PLUGIN_ROOT. Required.
#
# Resolution order (first existing wins; never falls through silently):
#   1. ${PLUGIN_ROOT}/bin/ai-architect-mcp-<os>-<arch>
#        Per-platform pre-built artifact shipped with the plugin. <os>-<arch>
#        is computed from `uname -sm` (e.g. darwin-arm64, darwin-x86_64,
#        linux-x86_64, linux-aarch64). This is the zero-build steady state:
#        Claude Code's MCP host gets `initialize` reply within milliseconds,
#        no cargo dependency on the host machine.
#   2. ${PLUGIN_ROOT}/bin/ai-architect-mcp
#        Generic fallback for hosts where the per-platform binary is missing
#        but a manually-placed binary exists (CI / power users / Docker).
#   3. ${PLUGIN_ROOT}/src-rust/target/release/ai-architect-mcp
#        Already built from this plugin's vendored Cargo source. This is the
#        steady-state path after the first-run cargo build below.
#   4. cargo build --release in ${PLUGIN_ROOT}/src-rust/ then exec.
#        Last-resort path for unsupported platforms or when the prebuilt
#        binaries were stripped (e.g. partial release tarball). Requires
#        Rust toolchain. Compilation typically takes 2–5 minutes — this
#        WILL exceed Claude Code's MCP connect timeout (30 s) on first run;
#        the user must restart Claude Code after the build completes.
#
# Notes
# -----
# - We deliberately do NOT fall back to `command -v ai-architect-mcp` on PATH.
#   The plugin name collides with at least one third-party Python wrapper of
#   the same name (e.g. /opt/homebrew/bin/ai-architect-mcp from the upstream
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
platform_bin="${PLUGIN_ROOT}/bin/ai-architect-mcp-${os}-${arch}"
if [ -x "${platform_bin}" ]; then
  exec "${platform_bin}"
fi

# ── Stage 2: generic prebuilt fallback ─────────────────────────────────────
shipped_bin="${PLUGIN_ROOT}/bin/ai-architect-mcp"
if [ -x "${shipped_bin}" ]; then
  exec "${shipped_bin}"
fi

# ── Stage 3: previously-cargo-built binary in src-rust/ ────────────────────
src_dir="${PLUGIN_ROOT}/src-rust"
prebuilt_in_src="${src_dir}/target/release/ai-architect-mcp"
if [ -x "${prebuilt_in_src}" ]; then
  exec "${prebuilt_in_src}"
fi

# ── Stage 4: last-resort cargo build ───────────────────────────────────────
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
