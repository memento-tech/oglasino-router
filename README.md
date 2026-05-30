# oglasino-router

Cloudflare Worker that routes `oglasino.com` (and stage equivalent)
traffic to:

- Vercel (frontend) for the apex domain
- Spring Boot droplet (via gray-cloud origin) for `api.*` subdomain
- Maintenance page, composed per-client from the `maintenance.web.active` and `maintenance.backend.active` KV flags

## Branches

- `main` (default) → deploys to `oglasino-router-prod`, serves `oglasino.com`
- `stage` → deploys to `oglasino-router-stage`, serves `stage.oglasino.com`

## Local development

```bash
npm install
npm run dev:stage      # local dev server against stage config
npm run dev:production # local dev server against production config
```

Trigger maintenance mode locally by writing to KV (requires
`CLOUDFLARE_API_TOKEN` env var). The worker reads two dependency flags and
composes the per-client decision; `maintenance.web.active` takes web down,
`maintenance.backend.active` takes both web and mobile down. For a full web
maintenance window, set `maintenance.web.active`:

```bash
npx wrangler kv key put --env stage --binding CONFIG maintenance.web.active true
npx wrangler kv key delete --env stage --binding CONFIG maintenance.web.active
```

## Testing

```bash
npm test
```

## Deploy

Push to `stage` or `main`. GH Actions handles the rest.

Manual deploy:

```bash
npm run deploy:stage
npm run deploy:production
```

Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` env vars
locally for manual deploy.

## Architecture

See [docs/architecture.md](docs/architecture.md).

## Operations

Maintenance mode toggling, KV management, debugging, route migration
from the dashboard-edited prod Worker. See
[docs/operations.md](docs/operations.md).

## Status

- [ ] Repo bootstrapped (this PR)
- [ ] Prod Worker re-deployed from this repo (verifies parity with dashboard-edited version)
- [ ] Routes migrated from `oglasino-prod-router` to `oglasino-router-prod` on Cloudflare
- [ ] Old `oglasino-prod-router` Worker deleted from Cloudflare
- [ ] Stage Worker deployed for the first time
- [ ] DNS records configured for stage subdomains (Phase 1C.2-1C.4)
