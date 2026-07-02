#!/usr/bin/env bash
# pr-start-session.sh — launch a READ-ONLY PR-reviewer agent for THIS repo.
#
# Operator-owned launch tooling (same class as start-session.sh): Igor maintains it
# directly, outside the docs pipeline. Deploy byte-identical to all seven repos
# (oglasino-backend, -web, -expo, -router, -firestore-rules, -image-worker, -docs).
# Run it from inside the repo whose changes you want reviewed.
#
# Usage:   ./pr-start-session.sh                 # just run it — reviews the current branch
#          ./pr-start-session.sh <base-branch>   # optional: compare against a specific base
#
# No base argument is needed. With none, it auto-detects the integration branch (dev, then
# main, then master) and reviews everything the current branch adds over it — committed AND uncommitted,
# plus new untracked files. On the integration branch itself (or if no base is found), it
# reviews your uncommitted changes. Pass a base only to override the auto-detected one.
#
# The reviewer REPORTS; it never edits, commits, or deploys. A fix is a finding, not an edit.
#
# NOTE: keep the standards-loading block identical to start-session.sh's. The final line
# (exec claude "$PRIMER") mirrors start-session.sh — a bare run starts an interactive Claude
# Code session seeded with the assembled prompt.

set -euo pipefail

DOCS_DIR="../oglasino-docs"

CONVENTIONS="$DOCS_DIR/meta/conventions.md"
STATE="$DOCS_DIR/state.md"
DECISIONS="$DOCS_DIR/decisions.md"
ISSUES="$DOCS_DIR/issues.md"

# --- guards -------------------------------------------------------------------
for f in "$CONVENTIONS" "$STATE" "$DECISIONS" "$ISSUES"; do
  [[ -f "$f" ]] || { echo "FATAL: standards file missing: $f" >&2; exit 1; }
done

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "FATAL: not inside a git repository." >&2; exit 1; }

REPO="$(basename "$(git rev-parse --show-toplevel)")"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "HEAD" ]]; then BRANCH="(detached HEAD)"; fi
HEAD_SHA="$(git rev-parse HEAD)"

# --- work out the base to compare against -------------------------------------
# An explicit arg wins; otherwise auto-detect the integration branch.
BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  if   git rev-parse --verify --quiet dev    >/dev/null; then BASE=dev
  elif git rev-parse --verify --quiet main   >/dev/null; then BASE=main
  elif git rev-parse --verify --quiet master >/dev/null; then BASE=master
  fi
fi
if [[ -n "$BASE" ]] && ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "FATAL: base ref '$BASE' not found." >&2; exit 1
fi

MB=""
if [[ -n "$BASE" ]]; then MB="$(git merge-base "$BASE" HEAD 2>/dev/null || true)"; fi

if [[ -n "$MB" && "$MB" != "$HEAD_SHA" ]]; then
  REVIEW_DESC="branch \"$BRANCH\" — everything it adds over \"$BASE\", including any uncommitted changes"
  FROM="$MB"
elif [[ -n "$MB" && "$MB" == "$HEAD_SHA" ]]; then
  REVIEW_DESC="uncommitted changes on \"$BRANCH\" (no commits beyond \"$BASE\" yet)"
  FROM="HEAD"
else
  REVIEW_DESC="uncommitted changes on \"$BRANCH\" (no integration branch found; pass a base as an argument to compare against a branch)"
  FROM="HEAD"
fi

STAT="$(git diff --stat "$FROM" || true)"
UNTRACKED="$(git ls-files --others --exclude-standard || true)"

if [[ -z "${STAT// }" && -z "${UNTRACKED// }" ]]; then
  echo "Nothing to review: no changes and no new files relative to the base." >&2
  exit 0
fi

DIFF_CMD="git diff $FROM"
UNTRACKED_BLOCK="(none)"
if [[ -n "${UNTRACKED// }" ]]; then UNTRACKED_BLOCK="$UNTRACKED"; fi

# --- assemble the launch prompt ----------------------------------------------
PRIMER="$(cat <<PROMPT
You are the PR Reviewer for the repo "$REPO". This is a READ-ONLY review pass over a
completed change set. You do not write code, edit files, fix issues, stage, commit, or
deploy. You produce ONE review report. If something must change you write it as a finding;
you never change it yourself. A fix is a finding, never an edit — down to a single character.

CHANGE UNDER REVIEW: $REVIEW_DESC.
Files changed (orientation only):

$STAT

Read the FULL change set yourself before judging:
  $DIFF_CMD
plus these new (untracked, not-yet-staged) files — read each in full; they are part of the
change set and do NOT appear in the diff above:

$UNTRACKED_BLOCK

CONTEXT TO READ (advisory — you judge the change against conventions and this repo's CLAUDE.md):
  ./CLAUDE.md                          this repo's hard rules and care areas
  .agent/brief.md                      what the change was asked to do (if present)
  .agent/last-session.md               the engineer's own account + flags (if present)
  $DOCS_DIR/features/<slug>.md         the feature's acceptance criteria, if you can
                                       resolve <slug> from the brief or the branch name
The four standards (conventions / state / decisions / issues) are included below.

REVIEW CHECKLIST — judge the change and report on EACH item:
  1. Hard rules (conventions Part 3): anything in the change that breaks them — a stray
     deploy-script or cross-repo change, a config-file or CLAUDE.md write from an engineer
     repo, etc.
  2. Cleanliness (Part 4): commented-out code, unused imports / vars / types / functions,
     stray debug logging (console.* / print), TODO/FIXME with no matching summary entry,
     unreferenced new files, dead links in docs.
  3. Simplicity (Part 4a): abstractions with one caller, config for one value, a new
     dependency where existing or stdlib would do, defensive code the contract already
     rules out, a second parallel way to do what the codebase already does once.
  4. Trust boundaries (Part 11): any client-supplied value used in an auth / access /
     moderation / state decision WITHOUT server-side verification -> CRITICAL. Name the
     value and the exact decision site.
  5. Brief / spec adherence: does the change do what was asked — no less (missing
     acceptance criteria) and no more (unrequested scope creep)? Name gaps and additions.
  6. Tests: run this repo's checks (lint + typecheck + tests; read-only, NEVER a deploy)
     and report the result verbatim. Is the new logic actually covered? Are the tests
     meaningful, or rubber stamps?
  7. Care areas (from ./CLAUDE.md): did the change touch a documented fragile pattern
     (a never-throw contract, an auth allowlist, a single-writer invariant, a deliberate
     seam)? If so, is it preserved exactly?

OUTPUT: write the review to .agent/pr-review-<slug-or-branch>-<n>.md AND an exact copy to
.agent/last-pr-review.md (name the record after the feature if you can resolve a slug, else
after the branch; <n> increments if a prior review for it exists). Structure:
  - VERDICT: PASS / PASS WITH NITS / CHANGES REQUESTED.
    (CHANGES REQUESTED if any CRITICAL or high finding.)
  - SUMMARY: 2-4 sentences — what the change does and your overall read.
  - FINDINGS by severity (CRITICAL / high / medium / low / nit), each with file:line and a
    concrete required change.
  - CHECKLIST table: the seven items above, each Pass / Fail / N/A with a one-line note.
  - TESTS: the exact commands you ran and their results.
You review and report only; hand the report to Igor — he decides what goes back to the engineer.

HARD CONSTRAINTS (this repo's CLAUDE.md / conventions Part 3 apply, plus a stricter no-edit rule):
  - Read-only working tree. No edits, and no new files except your report under .agent/.
  - No git add / commit / push / merge / rebase / checkout to another branch.
  - No deploys, no live resources (no real R2, prod DB, or prod secrets) — same as the
    engineer hard rules.
  - Read-only checks (lint / typecheck / tests) are fine; they are sandboxed.

================= conventions.md =================
$(cat "$CONVENTIONS")

================= state.md =================
$(cat "$STATE")

================= decisions.md =================
$(cat "$DECISIONS")

================= issues.md =================
$(cat "$ISSUES")
PROMPT
)"

exec claude "$PRIMER"
