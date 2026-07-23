# Changelog

Bare incrementing integer markers (v1, v2, v3, …), not SemVer. The marker
lives in `package.json` `"version"`.

## Unreleased — marker number pending (2026-07-23)

- **Fix:** the backend liveness probe (`use.backend.check`) targeted
  `${BACKEND_ORIGIN}/actuator/health/readiness`, a path the origin does not serve
  to outside callers — every probe failed, so every `/api/mobile/*` request got a
  503 while web stayed healthy. The probe now targets
  `${BACKEND_ORIGIN}/api/public/health/check`. Trade-off: the new target is a
  shallow liveness check (app up, dependencies unknown), where the actuator
  readiness group was dependency-aware; restoring dependency-awareness needs a
  Caddy allowlist + a backend decision (cross-repo).
- Tests pin the probe URL literally, per env.

> Marker number not assigned in this session. `package.json` already reads `"2"`
> (bumped 2026-07-22 with the `x-oglasino-edge` header change, never recorded
> here), so this is a `v3` candidate — see the session summary's "For Mastermind".

## v1 — first production marker (2026-06-09)

- Baseline at first production launch.
