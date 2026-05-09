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
                │        ├── reads KV (maintenance.active)
                │        │                           │
                │        ▼                           │
                │   maintenance? ──yes──► maintenance page
                │        │                  (or 503 JSON for API)
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

Single source of truth for maintenance gating. The KV flag
`maintenance.active` instantly puts the entire site into a 503 state
across both frontend and API. No coordination needed between two
Workers.

## Stage routing differences

Stage has no `www.stage.oglasino.com` — not needed for a non-public
testing environment. The Worker's WWW_HOST is empty for stage and
the redirect logic is skipped.

Stage Worker also adds `X-Robots-Tag: noindex, nofollow, noarchive,
nosnippet` to all responses to prevent search engine indexing of the
test environment. This is NOT applied for production responses.
