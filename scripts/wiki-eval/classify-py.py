#!/usr/bin/env python3
"""Classify each JSONL line on stdin via Cortex Python's classify_memory.

Emits JSONL on stdout with the input id + the dataclass-rendered
Classification (or null when rejected, or the error message).

Usage:
    python3 classify-py.py < sample.jsonl > py-results.jsonl

The Cortex repo is added to sys.path explicitly; this script must be run
from the host that has the Cortex sources cloned. Environment variable
CORTEX_ROOT overrides the default ~/Developments/Cortex.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

cortex_root = Path(os.environ.get("CORTEX_ROOT", "~/Developments/Cortex")).expanduser()
if not cortex_root.is_dir():
    print(f"Cortex root not found: {cortex_root}", file=sys.stderr)
    sys.exit(2)
sys.path.insert(0, str(cortex_root))

from mcp_server.core.wiki_classifier import classify_memory  # noqa: E402


def render(c) -> dict | None:
    if c is None:
        return None
    out = {
        "kind": c.kind,
        "lifecycle": c.lifecycle,
        "audience": list(c.audience),
        "provenance": c.provenance,
        "tags": list(c.tags),
    }
    if c.generator is not None:
        out["generator"] = {
            "model": c.generator.model,
            "version": c.generator.version,
            "prompt_template": c.generator.prompt_template,
            "generated_at": c.generator.generated_at,
        }
    return out


for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        row = json.loads(raw)
    except json.JSONDecodeError:
        continue
    tags = row.get("tags") or []
    content = row.get("content") or ""
    result = None
    error = None
    try:
        c = classify_memory(content, tags)
        result = render(c)
    except Exception as exc:  # noqa: BLE001
        error = repr(exc)
    sys.stdout.write(
        json.dumps({"id": row.get("id"), "classification": result, "error": error}) + "\n",
    )
