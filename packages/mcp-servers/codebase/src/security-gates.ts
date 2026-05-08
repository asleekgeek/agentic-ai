/**
 * security-gates.ts — Stage 8: graph-aware security gates.
 *
 * TypeScript port of security_gates.rs.
 * Five gates: S1 auth-critical community, S2 unsafe symbol, S3 public API,
 * S4 unresolved imports, S5 test coverage gap.
 *
 * source: automatised-pipeline/0.0.9/src/security_gates.rs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GraphStore } from "./graph-store.js";
import { getContext } from "./search.js";

// source: security_gates.rs:29-33 — AUTH_CRITICAL_PATTERNS
const AUTH_CRITICAL_PATTERNS = [
  "auth", "password", "token", "permission", "role",
  "crypto", "encrypt", "decrypt", "verify", "jwt", "oauth", "session",
];

export interface SecurityFlag {
  gate: string;
  severity: string;
  symbol: string;
  message: string;
  details: unknown;
}

export interface SecurityReport {
  gates_passed: boolean;
  flags: SecurityFlag[];
  summary: {
    changed_symbols: number;
    critical_count: number;
    warning_count: number;
    info_count: number;
  };
}

// source: security_gates.rs:66-100 check_gates()
export async function checkSecurityGates(
  store: GraphStore,
  changedSymbols: string[]
): Promise<SecurityReport> {
  const flags: SecurityFlag[] = [];
  const authCommunities = await findAuthCommunities(store);

  for (const sym of changedSymbols) {
    let ctx;
    try {
      ctx = await getContext(store, sym);
    } catch { continue; }

    // S1: auth-critical community touch — source: security_gates.rs:78 run_s1()
    if (ctx.community) {
      const commName = (ctx.community.name + ctx.community.id).toLowerCase();
      if (authCommunities.has(ctx.community.id) ||
          AUTH_CRITICAL_PATTERNS.some(p => commName.includes(p))) {
        flags.push({
          gate: "S1",
          severity: "critical",
          symbol: sym,
          message: "Changed symbol shares a community with auth-critical code",
          details: { community_id: ctx.community.id },
        });
      }
    }

    // S2: unsafe symbol detection — source: security_gates.rs:79 run_s2()
    // Parser does not currently record is_unsafe — info-skip
    flags.push({
      gate: "S2",
      severity: "info",
      symbol: sym,
      message: "Unsafe symbol check skipped: parser does not record is_unsafe",
      details: {},
    });

    // S3: public API change — source: security_gates.rs:80 run_s3()
    if (ctx.visibility === "pub" || ctx.visibility === "export") {
      const parts = ctx.qualified_name.split("::");
      if (parts.length === 2) {
        flags.push({
          gate: "S3",
          severity: "warning",
          symbol: sym,
          message: "Public-API symbol changed",
          details: { qualified_name: ctx.qualified_name },
        });
      }
    }

    // S4: unresolved imports — source: security_gates.rs:81 run_s4()
    const unresolvedImports = ctx.imports.filter(i => i.label === "Import");
    if (unresolvedImports.length > 0) {
      flags.push({
        gate: "S4",
        severity: "warning",
        symbol: sym,
        message: `Symbol has ${unresolvedImports.length} unresolved import(s)`,
        details: { unresolved: unresolvedImports.map(i => i.qualified_name) },
      });
    }

    // S5: test coverage gap — source: security_gates.rs:82 run_s5()
    const testProcesses = ctx.processes.filter(p =>
      p.name.includes("::test") || p.name.startsWith("test")
    );
    if (testProcesses.length === 0) {
      flags.push({
        gate: "S5",
        severity: "warning",
        symbol: sym,
        message: "Changed symbol has no reachable test process",
        details: { processes: ctx.processes.map(p => p.name) },
      });
    }
  }

  const criticalCount = flags.filter(f => f.severity === "critical").length;
  const warningCount = flags.filter(f => f.severity === "warning").length;
  const infoCount = flags.filter(f => f.severity === "info").length;

  return {
    gates_passed: criticalCount === 0,
    flags,
    summary: {
      changed_symbols: changedSymbols.length,
      critical_count: criticalCount,
      warning_count: warningCount,
      info_count: infoCount,
    },
  };
}

async function findAuthCommunities(store: GraphStore): Promise<Set<string>> {
  const communities = await store.nodesOfLabel("Community");
  const authCommunityIds = new Set<string>();
  for (const c of communities) {
    const name = (String(c["name"] ?? "") + String(c["id"] ?? "")).toLowerCase();
    if (AUTH_CRITICAL_PATTERNS.some(p => name.includes(p))) {
      authCommunityIds.add(String(c["id"] ?? ""));
    }
  }
  return authCommunityIds;
}

// Write stage-8.security.json — source: security_gates.rs:SECURITY_FILE
export function writeSecurityReport(
  outputDir: string,
  runId: string,
  findingId: string,
  report: SecurityReport
): string {
  const dir = path.join(outputDir, "runs", runId, "findings", findingId);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "stage-8.security.json");
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  return p;
}
