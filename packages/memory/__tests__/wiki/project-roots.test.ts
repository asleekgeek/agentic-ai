/**
 * Tests for project-roots.ts — auto-resolved project_root per domain.
 *
 * source: packages/memory/src/wiki/project-roots.ts
 */

import { describe, expect, it } from "vitest";
import { resolveProjectRoot } from "../../src/wiki/project-roots.js";

function fixedDirSet(present: readonly string[]): (p: string) => boolean {
  const set = new Set(present);
  return (p) => set.has(p);
}

describe("resolveProjectRoot", () => {
  it("returns the first matching base/domain path", () => {
    const bases = ["/home/user/Documents/Developments", "/home/user/projects"];
    const exists = fixedDirSet(["/home/user/projects/agentic-ai"]);
    expect(resolveProjectRoot("agentic-ai", bases, exists))
      .toBe("/home/user/projects/agentic-ai");
  });

  it("prefers the earlier base when multiple match", () => {
    const bases = ["/home/user/Documents/Developments", "/home/user/projects"];
    const exists = fixedDirSet([
      "/home/user/Documents/Developments/agentic-ai",
      "/home/user/projects/agentic-ai",
    ]);
    expect(resolveProjectRoot("agentic-ai", bases, exists))
      .toBe("/home/user/Documents/Developments/agentic-ai");
  });

  it("returns null when no candidate exists", () => {
    const bases = ["/home/user/Documents/Developments", "/home/user/projects"];
    const exists = fixedDirSet([]);
    expect(resolveProjectRoot("ghost", bases, exists)).toBeNull();
  });

  it("returns null for an empty domain", () => {
    const exists = fixedDirSet(["/whatever"]);
    expect(resolveProjectRoot("", ["/whatever"], exists)).toBeNull();
  });

  it("returns null for an empty base list", () => {
    expect(resolveProjectRoot("agentic-ai", [], () => true)).toBeNull();
  });
});
