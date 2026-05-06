# Codebase plugin binaries

Empty by default. Per-platform prebuilt binaries are downloaded from the
[GitHub Releases](https://github.com/cdeust/agentic-ai/releases) of this repo
on first plugin launch — see `scripts/launch.sh` Stage 2.

If you want to ship a binary directly with the plugin (e.g. for offline /
air-gapped installs), drop it here under one of these names:

  ai-architect-mcp-darwin-arm64
  ai-architect-mcp-darwin-x86_64
  ai-architect-mcp-linux-x86_64
  ai-architect-mcp-linux-aarch64
  ai-architect-mcp                  (generic fallback)

`launch.sh` picks them up via Stage 1 / Stage 3 and skips the download.

Building locally:

  cd plugins/codebase/src-rust
  cargo build --release
  cp target/release/ai-architect-mcp \
     ../bin/ai-architect-mcp-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)
