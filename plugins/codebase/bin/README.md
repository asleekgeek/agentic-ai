# Codebase plugin binaries

Empty by default. Per-platform prebuilt binaries are downloaded from the
[GitHub Releases](https://github.com/cdeust/agentic-ai/releases) of this repo
on first plugin launch — see `scripts/launch.sh` Stage 2.

If you want to ship a binary directly with the plugin (e.g. for offline /
air-gapped installs), drop it here under one of these names:

  automatised-pipeline-darwin-arm64
  automatised-pipeline-darwin-x86_64
  automatised-pipeline-linux-x86_64
  automatised-pipeline-linux-aarch64
  automatised-pipeline                  (generic fallback)

`launch.sh` picks them up via Stage 1 / Stage 3 and skips the download.

Building locally:

  cd plugins/codebase/src-rust
  cargo build --release
  cp target/release/automatised-pipeline \
     ../bin/automatised-pipeline-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)
