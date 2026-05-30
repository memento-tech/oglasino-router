# Architecture

## Routing flow

```
                ┌─────────────────────────────────────┐
                │      Cloudflare edge network        │
                │                                     │
   user ─────►  │  ┌─────────────────────────────┐   │
   request      │  │  oglasino-router-prod       │   │
                │  │  (or oglasino-router-stage) │   │
                │  └─────┬───────────────────────┘   │
                │        │                           │
                │        ├── reads KV (maintenance.web.active,
                │        │             maintenance.backend.active)
                │        ▼                           │
                │   maintenance? ──yes──► maintenance page
                │   (composed per      (or 503 JSON for API/mobile)
                │    client)                         │
                │        no                          │
                │        │                           │
                │        ├── apex/www host? ─►  Vercel (FRONTEND_ORIGIN)
                │        │                           │
                │        └── api host? ─────────►  Cloudflare DNS
                │                                    │
                │                                    │ resolves
                │                                    │ api-origin.oglasino.com
                │                                    │ (gray cloud, direct)
                │                                    ▼
                └────────────────────────────►  droplet
                                                (Spring Boot)
```

## Why gray-cloud origin

The `api-origin.oglasino.com` (and stage equivalent) is a DNS-only
record (gray cloud) that points at the droplet IP directly. The Worker
forwards API requests by `fetch()`-ing this hostname.

If the API hostname `api.oglasino.com` were the only DNS record, the
Worker's `fetch()` to `api.oglasino.com` would loop back through the
Worker — Cloudflare proxies the request, hits the Worker again,
infinite recursion.

Gray-cloud `api-origin` skips the Cloudflare proxy and hits the
droplet directly. Solves the recursion problem.

## Why the same Worker handles frontend and API

Single source of truth for maintenance gating. The Worker reads two
dependency flags from KV — `maintenance.web.active` and
`maintenance.backend.active` — and composes the maintenance decision per
client on every request:

- **Web / apex / API host:** down when `maintenance.web.active OR
  maintenance.backend.active` (web cannot function without the backend).
  During maintenance, `admin.bypass.disabled` decides who is blocked —
  `false` lets admin + API through, `true` is a full lockdown.
- **Mobile (`/api/mobile/*`):** down when `maintenance.backend.active OR` the
  backend liveness probe fails. Mobile depends only on the backend, so
  `maintenance.web.active` does not affect it and the admin bypass does not
  apply.

So `maintenance.web.active` takes only web down (mobile keeps running on a
live backend), while `maintenance.backend.active` takes both down. No
coordination needed between two Workers.

## Stage routing differences

Stage has no `www.stage.oglasino.com` — not needed for a non-public
testing environment. The Worker's WWW_HOST is empty for stage and
the redirect logic is skipped.

Stage Worker also adds `X-Robots-Tag: noindex, nofollow, noarchive,
nosnippet` to all responses to prevent search engine indexing of the
test environment. This is NOT applied for production responses.
