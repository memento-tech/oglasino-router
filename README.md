# Oglasino Router

A single Cloudflare Worker that is the edge front door for `oglasino.com` (and its stage
equivalent). It matches the incoming host/path, composes the per-client maintenance decision
from KV flags, and forwards traffic to the right origin — Vercel for the site, the Spring Boot
droplet for the API.

Part of the **Oglasino** platform. Cross-repo specs, conventions, and architecture live in
[`../oglasino-docs`](../oglasino-docs). The whole product is one file — `src/index.ts`
(~200 lines) — but every line carries production traffic.

---

## What it does

On every request the worker:

1. **Routes by host.**
   - Apex / `www` → Vercel frontend (`FRONTEND_ORIGIN`).
   - API host (`api.oglasino.com` / `api-stage.oglasino.com`) → Spring Boot droplet (`BACKEND_ORIGIN`, gray-cloud origin).
   - When maintenance is engaged → maintenance page (`MAINTENANCE_ORIGIN`), HTTP 503, without touching the backend.
2. **Composes maintenance per client** from the `CONFIG` KV namespace (see the matrix below). There is no single combined maintenance key.
3. **Gates mobile API traffic** (`/api/mobile/*`) on backend availability via an edge-cached liveness probe, then strips the `/mobile` segment and forwards.
4. **Forces `X-Robots-Tag: noindex`** on every stage response so staging never gets indexed.
5. **Fails open** — if a KV read throws, both flags are treated as `false` and traffic is served.

## Tech stack

- **Runtime:** Cloudflare Workers (bare `fetch` handler, **zero runtime dependencies**)
- **Language:** TypeScript
- **Tooling:** Wrangler 4, Vitest, `tsc --noEmit` for lint
- **State:** Cloudflare KV namespace `CONFIG` (maintenance + runtime config flags)

## The maintenance matrix

Maintenance is composed per request from KV flags. Each flag is `"true"` | `"false"`;
absent/null = `false` = up.

| Flag | Effect |
|---|---|
| `maintenance.web.active` | Web's own maintenance state |
| `maintenance.backend.active` | Backend maintenance state |
| `admin.bypass.disabled` | When `true`, admins are blocked too (full lockdown); web/admin path only |
| `use.backend.check` | When `true`, enables the backend liveness probe (mobile path only) |

**Web / apex / API-host request** (everything except `/api/mobile/*`):

- `webDown = maintenance.web.active OR maintenance.backend.active` — web cannot function without the backend, so a backend-down also takes web down. The probe does **not** gate web.
- `webDown` + `admin.bypass.disabled=false` → allow admin + API only (non-admin blocked).
- `webDown` + `admin.bypass.disabled=true` → full lockdown, everyone blocked.

**Mobile request** (`/api/mobile/*`):

- `backendDown = maintenance.backend.active OR probeFailed`.
- Mobile depends only on the backend: `maintenance.web.active` and `admin.bypass.disabled` do not apply.
- `backendDown` → 503 maintenance JSON (clients key off the `X-Oglasino-Maintenance` header).
- Otherwise strip `/mobile` (`/api/mobile/<rest>` → `/api/<rest>`) and forward to the backend.

The probe (gated by `use.backend.check`, mobile only) GETs
`BACKEND_ORIGIN/api/public/health/check` with a 30s edge cache; a non-2xx or thrown probe
sets `probeFailed`. The target must be a path the origin actually serves to outside callers —
it is a shallow liveness check (app up, dependencies unknown). See
[`docs/operations.md`](docs/operations.md) for the 2026-07-23 outage this caused when it was
not.

> **Care areas** (deliberate, easy to break): the maintenance matrix, fail-open on KV errors,
> the locale-prefixed admin-request regex `/^\/[a-z]{2}-[a-z]{2}\/admin(\/|$)/i`, the forced
> stage `noindex` header, and `redirect: "manual"` in `forwardToOrigin` (so upstream 3xx pass
> through unchanged). See [`CLAUDE.md`](CLAUDE.md) before changing any of them.

## Environments

| Branch | Worker | Domain |
|---|---|---|
| `stage` | `oglasino-router-stage` | `stage.oglasino.com` |
| `main` (default) | `oglasino-router-prod` | `oglasino.com` |

Origins (`FRONTEND_ORIGIN`, `BACKEND_ORIGIN`, `MAINTENANCE_ORIGIN`) and hosts are set per env
in [`wrangler.toml`](wrangler.toml). **Routes / custom domains are configured in the
Cloudflare dashboard** (Workers & Pages → worker → Triggers → Custom Domains), not in
`wrangler.toml`. `wrangler deploy` with no `--env` deploys to **stage** — production requires
explicit `--env production`.

## Project structure

```text
oglasino-router/
├── src/index.ts     # the entire worker: routing + maintenance + forwarding
├── tests/           # Vitest suites (CONFIG KV is mocked, never live)
├── docs/
│   ├── architecture.md
│   └── operations.md   # maintenance toggling, KV management, debugging
├── wrangler.toml    # env bindings (stage default + production)
└── package.json
```

## Local development

```bash
npm install
npm run dev:stage        # local dev server against stage config
npm run dev:production    # local dev server against production config
npm run lint             # tsc --noEmit
npm test                 # vitest (CONFIG KV is mocked)
```

Toggle maintenance against a real KV namespace (requires `CLOUDFLARE_API_TOKEN`). Setting
`maintenance.web.active` takes web down; `maintenance.backend.active` takes web **and** mobile
down:

```bash
npx wrangler kv key put    --env stage --binding CONFIG maintenance.web.active true
npx wrangler kv key delete --env stage --binding CONFIG maintenance.web.active
```

## Deploy

Push to `stage` or `main` and GitHub Actions deploys. Manual deploy (requires
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`):

```bash
npm run deploy:stage
npm run deploy:production
```

Operational procedures (maintenance windows, KV management, debugging) are in
[`docs/operations.md`](docs/operations.md); the design rationale is in
[`docs/architecture.md`](docs/architecture.md).

## Related repos

| Repo | Role |
|---|---|
| [`oglasino-web`](../oglasino-web) | Vercel frontend the apex routes to |
| [`oglasino-backend`](../oglasino-backend) | API origin the worker forwards to |
| [`oglasino-image-worker`](../oglasino-image-worker) | Sibling Worker — image PUT/GET against R2 |
| [`oglasino-maintenance`](../oglasino-maintenance) | Static maintenance page served during downtime |
| [`oglasino-docs`](../oglasino-docs) | Specs, conventions, architecture, decisions |

---

> `CLAUDE.md` governs the AI engineer agent that works in this repo. Igor commits; the agent
> never deploys.
</content>
