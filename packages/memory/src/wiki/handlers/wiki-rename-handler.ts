/**
 * Handler: wiki-rename — move a page and leave a redirect stub.
 *
 * Phase 3.2 of ADR-2244. The operation:
 *
 *   1. Read source page; require valid frontmatter ``id`` (Phase 3 invariant).
 *   2. Refuse if source is itself a redirect stub.
 *   3. Refuse if destination already exists (unless ``overwrite_dest`` true).
 *   4. Write source content at destination path.
 *   5. Replace source with a redirect stub pointing at destination
 *      (carrying the source's id as ``redirect_id``).
 *
 * source: mcp_server/handlers/wiki_rename.py
 */

import {
  buildRedirectStub,
  isRedirect,
  parseFrontmatter,
} from "../redirect.js";
import { extractPageId, isValidPageId } from "../identity.js";
import { WikiExists } from "../types.js";

export interface WikiRenameArgs {
  readonly from_path?: string;
  readonly to_path?: string;
  readonly reason?: string;
  readonly overwrite_dest?: boolean;
}

export interface WikiRenameSuccess {
  readonly from_path: string;
  readonly to_path: string;
  readonly page_id: string;
  readonly stub_created: boolean;
}

export type WikiRenameResponse =
  | WikiRenameSuccess
  | { readonly error: string; readonly from_path?: string; readonly to_path?: string; readonly page_id?: string; readonly stub_created?: boolean };

export interface WikiRenameDeps {
  readonly wikiRoot: string;
  readonly readPage: (root: string, relPath: string) => Promise<string | null>;
  readonly writePage: (
    root: string,
    relPath: string,
    content: string,
    mode: "create" | "replace",
  ) => Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function handler(
  args: WikiRenameArgs,
  deps: WikiRenameDeps,
): Promise<WikiRenameResponse> {
  const fromPath = (args.from_path ?? "").trim();
  const toPath = (args.to_path ?? "").trim();
  const reason = (args.reason ?? "").trim();
  const overwriteDest = Boolean(args.overwrite_dest ?? false);

  if (!fromPath) return { error: "from_path is required" };
  if (!toPath) return { error: "to_path is required" };
  if (fromPath === toPath) {
    return { error: "from_path and to_path must differ" };
  }

  // ── Read + validate source ────────────────────────────────────────
  let sourceContent: string | null;
  try {
    sourceContent = await deps.readPage(deps.wikiRoot, fromPath);
  } catch (err) {
    return { error: `source read failed: ${String(err)}` };
  }
  if (sourceContent === null) {
    return { error: `source page not found: ${fromPath}` };
  }

  const fm = parseFrontmatter(sourceContent);
  if (isRedirect(fm)) {
    return {
      error:
        `source is already a redirect stub: ${fromPath} — refusing to ` +
        `chain stubs (rename the terminal page instead)`,
    };
  }
  const pageId = extractPageId(fm);
  if (pageId === null) {
    return {
      error:
        `source page lacks a valid frontmatter id: ${fromPath}. ` +
        `Run a backfill to mint ids first.`,
    };
  }

  // ── Write destination ─────────────────────────────────────────────
  const writeMode: "create" | "replace" = overwriteDest ? "replace" : "create";
  try {
    await deps.writePage(deps.wikiRoot, toPath, sourceContent, writeMode);
  } catch (err) {
    if (err instanceof WikiExists) {
      return {
        error:
          `destination already exists: ${toPath} — pass overwrite_dest ` +
          `to replace it`,
      };
    }
    return { error: `destination write failed: ${String(err)}` };
  }

  // ── Write redirect stub at source ────────────────────────────────
  const stub = buildRedirectStub({
    target_path: toPath,
    target_id: isValidPageId(pageId) ? pageId : null,
    target_title: typeof fm.title === "string" ? fm.title.trim() : "",
    reason,
    created_at: nowIso(),
  });

  try {
    await deps.writePage(deps.wikiRoot, fromPath, stub, "replace");
  } catch (err) {
    return {
      error:
        `stub write failed: ${String(err)}; destination already written at ` +
        `${toPath} — manual cleanup may be needed at ${fromPath}`,
      from_path: fromPath,
      to_path: toPath,
      page_id: pageId,
      stub_created: false,
    };
  }

  return {
    from_path: fromPath,
    to_path: toPath,
    page_id: pageId,
    stub_created: true,
  };
}

export const schema = {
  title: "Wiki — rename page",
  description:
    "Move a wiki page from from_path to to_path and leave a redirect " +
    "stub at the old location pointing to the new one. The move " +
    "preserves inbound links because wiki_read follows redirect stubs " +
    "transparently. Refuses to operate on pages without a stable id " +
    "field, or on existing redirect stubs. Returns {from_path, " +
    "to_path, page_id, stub_created}.",
  inputSchema: {
    type: "object" as const,
    required: ["from_path", "to_path"] as const,
    properties: {
      from_path: {
        type: "string" as const,
        description: "Current wiki-relative path of the page.",
      },
      to_path: {
        type: "string" as const,
        description: "Destination wiki-relative path.",
      },
      reason: {
        type: "string" as const,
        description:
          "Optional free-form rationale recorded in the redirect stub.",
      },
      overwrite_dest: {
        type: "boolean" as const,
        default: false,
        description: "When true, overwrite an existing destination.",
      },
    },
  },
} as const;
