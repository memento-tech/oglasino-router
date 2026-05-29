#!/usr/bin/env bash
# start-session.sh — launches a Claude Code agent session for this repo.
#
# Drop one copy of this script in the root of each agent repo:
#   oglasino-backend/start-session.sh
#   oglasino-web/start-session.sh
#   oglasino-expo/start-session.sh
#   oglasino-router/start-session.sh
#   oglasino-docs/start-session.sh
#
# Usage: ./start-session.sh

set -euo pipefail

BRIEF_PATH=".agent/brief.md"

# Detect brief state: missing / empty (after trim) / present.
brief_state="present"
if [[ ! -f "$BRIEF_PATH" ]]; then
  brief_state="missing"
elif [[ -z "$(tr -d '[:space:]' < "$BRIEF_PATH")" ]]; then
  brief_state="empty"
fi

# Compose the primer prompt.
if [[ "$brief_state" == "present" ]]; then
  PRIMER="Start of session. Workflow:

1. Read .agent/brief.md — your task for this session.
2. Read any files the brief references that you don't already have in context.
3. Follow your CLAUDE.md (already in your context). The hard rules there are non-negotiable: no commits, no pushes, no cross-repo edits, no writes to the four config files in oglasino-docs/, calibrated challenge on brief vs reality, session summary to both .agent/yyyy-mm-dd-<repo>-<slug>-<n>.md and .agent/last-session.md at the end.
4. If anything in the brief is unclear, contradicts the code, or contradicts conventions — stop and ask Igor. Do not guess.
5. If the brief tells you to do something a hard rule forbids — stop and tell Igor. Do not work around it.
6. Confirm the task in one sentence, then begin."
else
  PRIMER="Start of session. The brief at .agent/brief.md is currently ${brief_state} — Igor has not yet provided a task.

Wait for Igor to paste or write the brief. When the brief is in place, follow the standard workflow:

1. Read .agent/brief.md.
2. Read any files the brief references.
3. Follow your CLAUDE.md (already in your context). The hard rules there are non-negotiable.
4. Stop and ask Igor if anything is unclear, contradicts the code, or contradicts conventions.
5. Stop and tell Igor if the brief asks for something a hard rule forbids.
6. Confirm the task in one sentence, then begin.

For now: acknowledge that you're ready and waiting for the brief."
fi

# Launch Claude Code with the primer as the initial prompt.
exec claude "$PRIMER"