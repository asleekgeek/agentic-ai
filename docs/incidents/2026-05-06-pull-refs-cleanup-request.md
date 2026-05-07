# GitHub Support request — purge `refs/pull/*/head` for `cdeust/agentic-ai`

**Date**: 2026-05-06
**Repo**: https://github.com/cdeust/agentic-ai
**Owner**: cdeust (Clement Deust, AI Architect Tools)
**Visibility**: public
**Issue category**: history-rewrite cleanup — residual PR refs after force-push

## Submission instructions

Open https://support.github.com/contact (or use `gh support` if available),
select category **"Account"** → subcategory **"Repository / Other"**, paste
the body below.

---

## Subject

Please purge `refs/pull/*/head` for cdeust/agentic-ai — residual after history rewrite

## Body

Hello GitHub Support,

I performed a complete history rewrite + force-push on the default branch
of my repo `cdeust/agentic-ai` on 2026-05-06 to remove identity-spoofing
commits authored under `t <t@t.t>` which GitHub's email-attribution had
auto-linked to a 15-year-old dormant account, `petros-double-test1`. The
rewrite scrubbed every commit reachable from `main`, force-pushed, deleted
all source branches, and the contributors panel + commit list now correctly
show only `Clement (cdeust)` and `Claude` co-author trailers.

The residual problem: every PR I had opened during the contamination window
created a `refs/pull/N/head` ref that still points at the original (pre-
rewrite) source-branch commit, with the `t@t.t` author and the
`petros-double-test1` GitHub-side avatar attribution. These refs:

- are read-only via the public API (`git push origin --delete refs/pull/N/head`
  is rejected with `deny updating a hidden ref`),
- can be discovered only via `git ls-remote origin` (not the branches UI),
- aren't gated by branch protection or repo settings I can adjust,
- still surface the spoofed `petros-double-test1` attribution on the
  GitHub commit-detail pages for those SHAs (visible to anyone who
  clicks through from old PR pages).

I would like these refs purged so the contamination stops being recoverable
via `refs/pull/`. The repo had no stars and was not yet announced when the
contamination occurred — there are no third-party clones or external
references to invalidate.

Affected refs (please purge all `refs/pull/N/head` for the listed PR
numbers — these are the closed PRs from the contamination window that
contain at least one `t <t@t.t>`-authored commit):

PR #83 (security audit) — first commit in the contamination window
PR #84 — fix(lint): repair eslint config
PR #85 — docs(readme): unified banner-style README
PR #86 — fix(plugins): make claude plugin install <name> self-contained
PR #87 — docs(readme): align with self-contained plugin layout
PR #88 — fix(plugins): expose slash commands + skills + agents
PR #89 — fix(codebase): drop PATH fallback in launch.sh
PR #90 — perf(dashboard): unblock browser on graph render
PR #91 — fix: unblock 4 failed MCP servers
PR #92 — chore(plugins): drop project .mcp.json + reset versions to 0.0.1
PR #93 — fix(memory-plugin): ship dashboard server.js + static/

If wholesale purge of `refs/pull/*/head` for those PR numbers is the
simplest path on your side, that's fine. Equivalently, if the policy is
"close-and-archive" or "force-rewrite the ref to current main", either
also resolves the issue from my perspective — what I need is for the
spoofed attribution to stop being reachable.

For verification: the underlying commits I want unreferenced are the
pre-rewrite SHAs visible on those PR pages — every commit there with
author `t <t@t.t>` is a candidate. The post-rewrite `main` is at
`4583cf1` (verified clean: zero `t@t.t` references reachable from any
ref I can list; full Cortex-frontend port and dashboard schema fixes
have since landed on top of the rewritten history).

Thanks,
Clement Deust
admin@ai-architect.tools

---

## Background context (for the support agent — optional)

Root cause was a buggy unit test (`packages/memory-dashboard/__tests__/
file-diff-security.test.ts` in commit `5c4b307`, since rewritten away)
that called `process.chdir()` into a fixture temp git repo configured
with `user.email=t@t.t` and a `git commit -m init` of a single-byte file.
Vitest's worker reuse leaked the chdir into peer tests, causing their
git commits to be authored as `t <t@t.t>`. The 2011 dormant account
`petros-double-test1` had registered `t@t.t` years ago, so GitHub
auto-attributed every leaked commit to that account.

The fix is now in main (`scripts/check-payload-strings.sh` enforces a
permanent firewall in pre-commit + pre-push), the test rewritten to
not produce payload-shaped fixtures, and the scrubbed history is the
new ground truth.

The only thing left that I cannot self-resolve is the `refs/pull/*/head`
residual.
