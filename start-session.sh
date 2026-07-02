#!/usr/bin/env bash
# start-session.sh — launches a Claude Code agent session for this repo.
#
# Drop one copy in the root of each agent repo:
#   oglasino-backend/   oglasino-web/   oglasino-expo/
#   oglasino-router/    oglasino-firestore-rules/   oglasino-image-worker/
#   oglasino-docs/
#
# It loads the shared standards (conventions / state / decisions / issues) into
# the session at launch — UNCONDITIONALLY, brief or no brief — so the agent is
# fully prepared the moment a brief arrives. Those four files live in the sibling
# oglasino-docs repo and are NOT auto-loaded by Claude Code (only this repo's
# CLAUDE.md is). This script is what guarantees they are in context.
#
# `set -euo pipefail` means a missing standards file ABORTS the launch instead of
# starting an under-prepared agent.
#
# Usage: ./start-session.sh   (run from the repo root)
set -euo pipefail

DOCS_DIR="../oglasino-docs"   # resolves to itself when run from oglasino-docs
BRIEF_PATH=".agent/brief.md"

CONVENTIONS_PATH="$DOCS_DIR/meta/conventions.md"
STATE_PATH="$DOCS_DIR/state.md"
DECISIONS_PATH="$DOCS_DIR/decisions.md"
ISSUES_PATH="$DOCS_DIR/issues.md"

# --- Load the shared standards; fail loudly if any is missing ---
for f in "$CONVENTIONS_PATH" "$STATE_PATH" "$DECISIONS_PATH" "$ISSUES_PATH"; do
  if [[ ! -f "$f" ]]; then
    echo "start-session.sh: required standards file not found: $f" >&2
    echo "Refusing to start an under-prepared session. Is ../oglasino-docs checked out?" >&2
    exit 1
  fi
done

CONVENTIONS_CONTENT="$(cat "$CONVENTIONS_PATH")"
STATE_CONTENT="$(cat "$STATE_PATH")"
DECISIONS_CONTENT="$(cat "$DECISIONS_PATH")"
ISSUES_CONTENT="$(cat "$ISSUES_PATH")"

# --- Detect brief state: missing / empty (after trim) / present ---
brief_state="present"
if [[ ! -f "$BRIEF_PATH" ]]; then
  brief_state="missing"
elif [[ -z "$(tr -d '[:space:]' < "$BRIEF_PATH")" ]]; then
  brief_state="empty"
fi

# --- Standards block: loaded in full, every session, before any task ---
STANDARDS_BLOCK="Start of session. The shared project standards are loaded below, in full, so you are fully prepared before any task arrives. They are the source of truth for how this project works and how code is written here; they live in the sibling oglasino-docs repo and are not auto-loaded, so this is your in-context copy for the session. Read them now.

What is loaded:
- conventions.md — the rulebook. Your engineering standards live here: doc style (Part 1), agent roles (Part 3), the hard rules (Part 3), cleanliness (Part 4), simplicity (Part 4a), session summary (Part 5), translations (Part 6), the error contract (Part 7), architectural defaults (Part 8), the stack reference (Part 9), the feature lifecycle (Part 10), trust boundaries (Part 11), schema patterns (Part 12), Spring self-call patterns (Part 13), and your working method incl. the startup order, the Read-output verification rule, and the brief-challenge protocol (Part 14).
- state.md — where the project is now.
- decisions.md — the decision log (newest first; historical entries are in archive/).
- issues.md — the open bug / follow-up backlog.

Your CLAUDE.md is already in context and is canonical for this repo's specifics; conventions Part 3 is canonical for the hard rules if the two ever differ.

===== BEGIN conventions.md =====
${CONVENTIONS_CONTENT}
===== END conventions.md =====

===== BEGIN state.md =====
${STATE_CONTENT}
===== END state.md =====

===== BEGIN decisions.md =====
${DECISIONS_CONTENT}
===== END decisions.md =====

===== BEGIN issues.md =====
${ISSUES_CONTENT}
===== END issues.md ====="

# --- Hard-rules reminder (entry-point copy; conventions Part 3 is canonical) ---
HARD_RULES="Non-negotiable hard rules — full set in your CLAUDE.md and conventions Part 3; Part 3 wins on any difference: no git commit / push / merge / rebase / checkout to another branch (Igor commits); no deploys; no destructive DB ops; no cross-repo edits; no new files in this repo's docs/; no writes to the four config files (conventions / state / decisions / issues) or to any CLAUDE.md — surface needed changes in the session summary instead. Challenge the brief before writing code when the code contradicts it in a way that matters (Part 14). Stop and ask Igor when something is unclear or contradicts conventions. Stop and tell Igor if the brief asks for something a hard rule forbids — never work around it."

# --- Per-brief-state workflow ---
if [[ "$brief_state" == "present" ]]; then
  WORKFLOW="A brief is present at ${BRIEF_PATH}. Workflow:
1. Read ${BRIEF_PATH} — your task for this session.
2. Read any files the brief references that you don't already have (e.g. features/<slug>.md, the repo audit .agent/audit-<slug>.md). The four standards files above are already loaded — do not re-read them.
3. ${HARD_RULES}
4. At session end, write the session summary to BOTH .agent/yyyy-mm-dd-<repo>-<slug>-<n>.md and .agent/last-session.md, per conventions Part 5.
5. Confirm the task in one sentence, then begin."
else
  WORKFLOW="The brief at ${BRIEF_PATH} is currently ${brief_state} — Igor has not yet provided a task. You are nonetheless fully prepared: the standards above are loaded. Wait for Igor to paste or write the brief. When it is in place:
1. Read ${BRIEF_PATH}.
2. Read any files the brief references (feature spec, repo audit). The four standards files above are already loaded — do not re-read them.
3. ${HARD_RULES}
4. At session end, write the session summary to BOTH .agent/yyyy-mm-dd-<repo>-<slug>-<n>.md and .agent/last-session.md, per conventions Part 5.
5. Confirm the task in one sentence, then begin.
For now: confirm in one line that you have read the loaded standards (conventions / state / decisions / issues), then say you are ready and waiting for the brief."
fi

PRIMER="${STANDARDS_BLOCK}

--------------------------------------------------------------------------------

${WORKFLOW}"

# --- Launch Claude Code with the primer as the initial prompt ---
exec claude "$PRIMER"
