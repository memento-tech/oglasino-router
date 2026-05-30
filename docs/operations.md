# Operations

## Cloudflare account ID

Cloudflare dashboard → right sidebar → Account ID. Paste into
`wrangler.toml` under top-level `account_id` AND set the
`CLOUDFLARE_ACCOUNT_ID` GH Actions secret.

## KV namespaces

This Worker uses a `CONFIG` KV namespace per environment.

### Production KV namespace

Already exists on Cloudflare — used by the current dashboard-edited
`oglasino-prod-router` Worker. Find its ID:

1. Cloudflare dashboard → Workers & Pages → KV
2. Find the namespace bound to `oglasino-prod-router` (likely named
   `CONFIG` or similar)
3. Copy the namespace ID

Paste into `wrangler.toml` under `[[env.production.kv_namespaces]]`.

### Stage KV namespace

Must be created. From the repo root:

```bash
npx wrangler kv namespace create CONFIG --env stage
```

Wrangler outputs an ID. Paste into `wrangler.toml` under both:
- `[[kv_namespaces]]` (top-level — same as stage default)
- `[[env.stage.kv_namespaces]]`

## Toggle maintenance mode

The Worker reads **two** dependency flags and composes the maintenance
decision per client. There is no single combined maintenance key — the
worker reads only the two flags below, so writing any other key has no
effect.

- `maintenance.web.active` — takes the **web** surface down (apex + admin +
  API host). Does NOT affect mobile.
- `maintenance.backend.active` — takes the **backend** down, which takes
  **both** web and mobile (`/api/mobile/*`) down (web cannot function without
  the backend).

`admin.bypass.disabled` shapes who is blocked on the web surface during
maintenance (see [architecture.md](architecture.md)); it does not apply to
mobile.

```bash
# Web maintenance window (web down, mobile unaffected)
npx wrangler kv key put --env stage --binding CONFIG maintenance.web.active true
npx wrangler kv key put --env production --binding CONFIG maintenance.web.active true
npx wrangler kv key delete --env stage --binding CONFIG maintenance.web.active
npx wrangler kv key delete --env production --binding CONFIG maintenance.web.active

# Backend maintenance window (web AND mobile down)
npx wrangler kv key put --env stage --binding CONFIG maintenance.backend.active true
npx wrangler kv key put --env production --binding CONFIG maintenance.backend.active true
npx wrangler kv key delete --env stage --binding CONFIG maintenance.backend.active
npx wrangler kv key delete --env production --binding CONFIG maintenance.backend.active
```

The Worker caches each KV value at edge for 30s, so changes take up to
30s to fully propagate.

## Toggle backend liveness probe

```bash
npx wrangler kv key put --env stage --binding CONFIG use.backend.check true
```

When enabled, the Worker probes `${BACKEND_ORIGIN}/actuator/health/readiness`
(30s edge cache) before forwarding **mobile** (`/api/mobile/*`) requests only.
If the probe fails (non-2xx or throw), that mobile request gets the maintenance
response automatically. The probe never gates web traffic. Useful during
planned droplet outages.

## Debugging

```bash
npx wrangler tail --env stage       # tail live logs
npx wrangler tail --env production
```

## Required GH Actions secrets

| Secret | Scope | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | account-scoped | Workers Scripts: Edit; Workers Routes: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | account-scoped | Visible in Cloudflare dashboard right sidebar |

Same token works for both stage and production deploys (account-scoped,
not env-scoped). Same secrets format as `oglasino-image-worker`.

## Migrating from the dashboard-edited prod Worker

The current `oglasino-prod-router` exists only on Cloudflare's
dashboard. Migration plan:

1. Bootstrap this repo (this PR) — code parity with dashboard.
2. Igor merges `feature/bootstrap` into `main` — GH Actions deploys
   the Worker as `oglasino-router-prod` (NEW name, distinct from old).
3. **Critical step:** Cloudflare dashboard → Workers & Pages →
   `oglasino-prod-router` → Triggers → Routes — copy the existing
   route patterns, then move them to `oglasino-router-prod` Worker.
   This is the actual cutover. Brief outage (~10-30s per route).
4. Verify production traffic still works (smoke test, watch
   `wrangler tail --env production` for live logs).
5. Delete the old `oglasino-prod-router` Worker from Cloudflare.

The naming change `oglasino-prod-router` → `oglasino-router-prod`
matches the `<purpose>-<env>` convention used by
`oglasino-images-prod` / `oglasino-images-stage`.
