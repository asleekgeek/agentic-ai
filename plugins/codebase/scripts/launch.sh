#!/usr/bin/env bash
# Launch the automatised-pipeline Rust binary that powers the codebase plugin.
#
# Args:
#   $1 — CLAUDE_PLUGIN_ROOT. Required.
#
# Resolution order (first existing wins; never falls through silently):
#   1. ${PLUGIN_ROOT}/bin/automatised-pipeline
#        Cached prebuilt binary, populated by Stage 2 on first launch (or
#        manually placed by power users / CI / Docker). Zero-overhead exec.
#   2. Download from GitHub Releases on first launch.
#        If bin/automatised-pipeline is not present, derive the platform tag
#        from `uname -sm` (Darwin → macos; arm64/aarch64 normalized; etc.),
#        fetch automatised-pipeline-<platform>.tar.gz + .sha256 from the
#        latest tagged release, verify, extract, cache under bin/, then exec.
#        Source of truth: .github/workflows/release-codebase-binaries.yml
#        which uploads one tarball per supported platform on every
#        codebase-v* tag push.
#        Total first-launch cost: ~3-10 s (download + extract) + start-up.
#        Within MCP's 30 s connect timeout. After this runs once, stage 1
#        wins thereafter.
#   3. ${PLUGIN_ROOT}/src-rust/target/release/automatised-pipeline
#        Already built from this plugin's vendored Cargo source. This is the
#        steady-state path after the first-run cargo build below.
#   4. cargo build --release in ${PLUGIN_ROOT}/src-rust/ then exec.
#        Last-resort path for unsupported platforms with no network. Requires
#        Rust toolchain. Compilation typically takes 2–5 minutes — this
#        WILL exceed Claude Code's MCP connect timeout (30 s) on first run;
#        the user must restart Claude Code after the build completes.
#
# Asset naming (matches release-codebase-binaries.yml):
#   automatised-pipeline-{macos,linux}-{aarch64,x86_64}.tar.gz
#   automatised-pipeline-{macos,linux}-{aarch64,x86_64}.tar.gz.sha256
# (Tar archive contains a single file: `automatised-pipeline`.)
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

shipped_bin="${PLUGIN_ROOT}/bin/automatised-pipeline"

# ── Stage 1: cached prebuilt binary ─────────────────────────────────────────
if [ -x "${shipped_bin}" ]; then
  exec "${shipped_bin}"
fi

# ── Stage 2: download from GitHub Releases ──────────────────────────────────
# Derive {os}-{arch} for the asset name. Asset format mirrors upstream
# automatised-pipeline 0.0.9: {macos,linux}-{aarch64,x86_64}.
os_uname=$(uname -s)
arch_uname=$(uname -m)
case "$os_uname" in
  Darwin) target_os=macos ;;
  Linux)  target_os=linux ;;
  *)      target_os="" ;;
esac
case "$arch_uname" in
  arm64|aarch64) target_arch=aarch64 ;;
  x86_64|amd64)  target_arch=x86_64 ;;
  *)             target_arch="" ;;
esac

if [ -n "$target_os" ] && [ -n "$target_arch" ] && command -v curl >/dev/null 2>&1; then
  RELEASE_REPO="cdeust/agentic-ai"
  RELEASE_TAG="${AGENTIC_AI_CODEBASE_RELEASE_TAG:-latest}"
  asset="automatised-pipeline-${target_os}-${target_arch}.tar.gz"
  if [ "${RELEASE_TAG}" = "latest" ]; then
    base_url="https://github.com/${RELEASE_REPO}/releases/latest/download"
  else
    base_url="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}"
  fi
  echo "codebase plugin: fetching prebuilt ${asset} from ${base_url}/ ..." >&2
  mkdir -p "${PLUGIN_ROOT}/bin"
  tmp_dir=$(mktemp -d)
  if curl --fail --location --silent --show-error --max-time 60 \
        --output "${tmp_dir}/${asset}" "${base_url}/${asset}" \
     && curl --fail --location --silent --show-error --max-time 30 \
        --output "${tmp_dir}/${asset}.sha256" "${base_url}/${asset}.sha256"; then
    # Verify sha256 — the .sha256 file is "<hash>  <filename>" (shasum format).
    expected=$(awk '{print $1}' "${tmp_dir}/${asset}.sha256")
    actual=$(shasum -a 256 "${tmp_dir}/${asset}" | awk '{print $1}')
    if [ "$expected" = "$actual" ] && [ -n "$expected" ]; then
      ( cd "${tmp_dir}" && tar -xzf "${asset}" )
      if [ -x "${tmp_dir}/automatised-pipeline" ]; then
        chmod +x "${tmp_dir}/automatised-pipeline"
        mv "${tmp_dir}/automatised-pipeline" "${shipped_bin}"
        rm -rf "${tmp_dir}"
        echo "codebase plugin: cached ${shipped_bin} (sha256 verified)" >&2
        exec "${shipped_bin}"
      fi
      echo "codebase plugin: tarball extracted but binary not found — falling through." >&2
    else
      echo "codebase plugin: sha256 mismatch (expected ${expected}, got ${actual}) — falling through." >&2
    fi
    rm -rf "${tmp_dir}"
  else
    rm -rf "${tmp_dir}"
    echo "codebase plugin: release download failed — falling through to local build paths." >&2
  fi
fi

# ── Stage 3: previously-cargo-built binary in src-rust/ ─────────────────────
src_dir="${PLUGIN_ROOT}/src-rust"
prebuilt_in_src="${src_dir}/target/release/automatised-pipeline"
if [ -x "${prebuilt_in_src}" ]; then
  exec "${prebuilt_in_src}"
fi

# ── Stage 4: last-resort cargo build ────────────────────────────────────────
if ! command -v cargo >/dev/null 2>&1; then
  echo "codebase plugin: no prebuilt binary for ${target_os:-?}-${target_arch:-?} and cargo is not installed." >&2
  echo "  Either install Rust:   https://rustup.rs" >&2
  echo "  Or place a binary at:  ${shipped_bin}" >&2
  exit 1
fi

if [ ! -f "${src_dir}/Cargo.toml" ]; then
  echo "codebase plugin: src-rust/Cargo.toml missing — corrupt install?" >&2
  exit 1
fi

echo "codebase plugin: building from source (~2-5 min)..." >&2
echo "  This first launch will likely exceed Claude Code's 30s MCP connect timeout." >&2
echo "  Restart Claude Code after the build completes." >&2
( cd "${src_dir}" && cargo build --release --quiet >&2 )
exec "${prebuilt_in_src}"
