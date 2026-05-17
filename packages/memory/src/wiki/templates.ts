/**
 * Wiki page templates + naming conventions.
 *
 * Each page kind has:
 *   * A canonical front-matter schema (required fields + types)
 *   * A template body with labelled sections
 *   * A naming convention (slug pattern + path discipline)
 *
 * All templates are pure strings with {{var}} placeholders.
 *
 * source: mcp_server/core/wiki_templates.py
 */

// ── Required front-matter fields per page kind ───────────────────────────

export const REQUIRED_FRONTMATTER: Record<string, readonly string[]> = {
  // Modern (ADR-2244 §4.1) — each lists ``kind, lifecycle, audience,
  // provenance, title`` as the minimum; extras are kind-specific.
  adr: ["id", "title", "status", "date", "context", "decision", "consequences"],
  tutorial: ["title", "audience", "updated"],
  "how-to": ["title", "audience", "updated"],
  reference: ["title", "scope", "updated"],
  explanation: ["title", "updated"],
  runbook: ["title", "audience", "updated"],
  rfc: ["title", "status", "owner", "created", "updated"],
  journal: ["title", "date"],
  // Legacy — readable for backward-compat.
  specs: ["title", "status", "owner", "created", "updated"],
  guides: ["title", "audience", "prerequisites", "updated"],
  conventions: ["title", "applies_to", "updated"],
  lessons: ["title", "date", "triggering_event", "updated"],
  notes: ["title", "updated"],
  files: ["file_path", "language", "updated"],
} as const;

export const STATUS_VALUES: Record<string, readonly string[]> = {
  adr: ["proposed", "accepted", "rejected", "deprecated", "superseded"],
  specs: ["draft", "review", "accepted", "implemented", "deprecated"],
} as const;

// ── Templates ─────────────────────────────────────────────────────────────

export const ADR_TEMPLATE = `---
id: {{id}}
title: {{title}}
status: {{status}}
date: {{date}}
supersedes: {{supersedes}}
---

# ADR-{{id}}: {{title}}

## Status

{{status}}

## Context

{{context}}

## Decision

{{decision}}

## Consequences

### Positive
{{consequences_positive}}

### Negative
{{consequences_negative}}

### Neutral
{{consequences_neutral}}

## Alternatives considered

{{alternatives}}

## References

{{references}}
`;

export const SPEC_TEMPLATE = `---
title: {{title}}
status: {{status}}
owner: {{owner}}
created: {{created}}
updated: {{updated}}
---

# {{title}}

## Problem

{{problem}}

## Goals

{{goals}}

## Non-goals

{{non_goals}}

## Design

{{design}}

## Invariants

{{invariants}}

## Open questions

{{open_questions}}

## References

{{references}}
`;

export const GUIDE_TEMPLATE = `---
title: {{title}}
audience: {{audience}}
prerequisites: {{prerequisites}}
updated: {{updated}}
---

# {{title}}

## When to use

{{when_to_use}}

## Prerequisites

{{prerequisites_detail}}

## Steps

{{steps}}

## Verification

{{verification}}

## Troubleshooting

{{troubleshooting}}
`;

export const REFERENCE_TEMPLATE = `---
title: {{title}}
scope: {{scope}}
updated: {{updated}}
---

# {{title}}

## Scope

{{scope_detail}}

## API / Interface

{{api}}

## Examples

{{examples}}

## See also

{{see_also}}
`;

export const CONVENTION_TEMPLATE = `---
title: {{title}}
applies_to: {{applies_to}}
updated: {{updated}}
---

# {{title}}

## Rule

{{rule}}

## Rationale

{{rationale}}

## Examples

### Correct
{{correct_examples}}

### Incorrect
{{incorrect_examples}}

## Enforcement

{{enforcement}}
`;

export const LESSON_TEMPLATE = `---
title: {{title}}
date: {{date}}
triggering_event: {{triggering_event}}
updated: {{updated}}
---

# {{title}}

## What happened

{{what_happened}}

## Why it went wrong

{{root_cause}}

## What we learned

{{lesson}}

## Rule going forward

{{rule}}

## References

{{references}}
`;

export const NOTE_TEMPLATE = `---
title: {{title}}
updated: {{updated}}
---

# {{title}}

{{body}}
`;

export const JOURNAL_TEMPLATE = `---
title: {{title}}
date: {{date}}
---

# {{title}}

## Summary

{{summary}}

## Details

{{details}}
`;

export const FILE_TEMPLATE = `---
file_path: {{file_path}}
language: {{language}}
updated: {{updated}}
---

# {{file_path}}

## Purpose

{{purpose}}

## Public API

{{public_api}}

## Dependencies

{{dependencies}}

## Notes

{{notes}}
`;

// ── Modern ADR-2244 templates (Phase 1) ──────────────────────────────────
// Re-use the closest legacy template as the body for the modern kinds
// that did not exist before ADR-2244. The frontmatter is shaped by the
// classification 4-tuple at write time; these provide a sensible body
// outline.

export const TUTORIAL_TEMPLATE = `---
kind: tutorial
title: {{title}}
audience: {{audience}}
lifecycle: seedling
provenance: human
updated: {{updated}}
---

# {{title}}

## What you'll learn

{{learning_outcome}}

## Prerequisites

{{prerequisites}}

## Steps

{{steps}}

## Next steps

{{next_steps}}
`;

export const HOW_TO_TEMPLATE = `---
kind: how-to
title: {{title}}
audience: {{audience}}
lifecycle: seedling
provenance: human
updated: {{updated}}
---

# How to {{title}}

## Goal

{{goal}}

## Procedure

{{procedure}}

## Verification

{{verification}}
`;

export const EXPLANATION_TEMPLATE = `---
kind: explanation
title: {{title}}
lifecycle: seedling
provenance: human
updated: {{updated}}
---

# {{title}}

{{body}}
`;

export const RUNBOOK_TEMPLATE = `---
kind: runbook
title: {{title}}
audience: ops
lifecycle: seedling
provenance: human
updated: {{updated}}
---

# Runbook — {{title}}

## When this fires

{{trigger}}

## Diagnose

{{diagnose}}

## Mitigate

{{mitigate}}

## Verify recovery

{{verify}}
`;

export const RFC_TEMPLATE = `---
kind: rfc
title: {{title}}
status: {{status}}
owner: {{owner}}
created: {{created}}
updated: {{updated}}
---

# RFC: {{title}}

## Summary

{{summary}}

## Motivation

{{motivation}}

## Proposed design

{{design}}

## Alternatives considered

{{alternatives}}

## Open questions

{{questions}}
`;

export const TEMPLATES: Readonly<Record<string, string>> = {
  // Modern (ADR-2244)
  adr: ADR_TEMPLATE,
  tutorial: TUTORIAL_TEMPLATE,
  "how-to": HOW_TO_TEMPLATE,
  reference: REFERENCE_TEMPLATE,
  explanation: EXPLANATION_TEMPLATE,
  runbook: RUNBOOK_TEMPLATE,
  rfc: RFC_TEMPLATE,
  journal: JOURNAL_TEMPLATE,
  // Legacy
  specs: SPEC_TEMPLATE,
  guides: GUIDE_TEMPLATE,
  conventions: CONVENTION_TEMPLATE,
  lessons: LESSON_TEMPLATE,
  notes: NOTE_TEMPLATE,
  files: FILE_TEMPLATE,
} as const;

/**
 * Return the template for a page kind, or null if unknown.
 */
export function templateFor(kind: string): string | null {
  return TEMPLATES[kind] ?? null;
}

/**
 * Return the required front-matter keys for a page kind.
 */
export function requiredFields(kind: string): readonly string[] {
  return REQUIRED_FRONTMATTER[kind] ?? ["title", "updated"];
}

/**
 * Return the valid ``status`` values for a page kind, or [].
 */
export function validStatusValues(kind: string): readonly string[] {
  return STATUS_VALUES[kind] ?? [];
}

// ── Naming conventions ────────────────────────────────────────────────────

export interface NamingConvention {
  readonly pattern: string;
  readonly description: string;
}

const ADR_CONVENTION: NamingConvention = {
  pattern: String.raw`^\d{4}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`,
  description: "ADR: <4-digit>-<kebab-slug>.md (e.g., 0042-prefer-plan-over-list.md)",
};

const SPEC_CONVENTION: NamingConvention = {
  pattern: String.raw`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`,
  description: "Spec: <kebab-slug>.md (e.g., phase-5-pool-admission-design.md)",
};

const DEFAULT_CONVENTION: NamingConvention = {
  pattern: String.raw`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`,
  description:
    "Page: <kebab-slug>.md — lowercase alphanum + hyphens, no underscores, no leading/trailing hyphens.",
};

/**
 * Return the naming convention for a page kind.
 */
export function namingConvention(kind: string): NamingConvention {
  if (kind === "adr") return ADR_CONVENTION;
  if (kind === "specs") return SPEC_CONVENTION;
  return DEFAULT_CONVENTION;
}
