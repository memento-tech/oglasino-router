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

```bash
# Enable
npx wrangler kv key put --env stage --binding CONFIG maintenance.active true
npx wrangler kv key put --env production --binding CONFIG maintenance.active true

# Disable
npx wrangler kv key delete --env stage --binding CONFIG maintenance.active
npx wrangler kv key delete --env production --binding CONFIG maintenance.active
```

The Worker caches the KV value at edge for 30s, so changes take up to
30s to fully propagate.

## Toggle backend liveness probe

```bash
npx wrangler kv key put --env stage --binding CONFIG use.backend.check true
```

When enabled, the Worker probes `${BACKEND_ORIGIN}/health` before
forwarding. If the probe fails, requests get the maintenance response
automatically. Useful during planned droplet outages.

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
