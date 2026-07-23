// ============================================================================
// Oglasino router Worker.
// Serves prod and stage environments via wrangler.toml [env.*] config.
// Routes frontend → Vercel, API → droplet (via gray-cloud origin),
// maintenance based on KV flags.
//
// KV flags (CONFIG namespace; each "true" | "false"; absent/null = false = up;
// 30s edge cache on every read):
//   - maintenance.web.active      — web's own maintenance state
//   - maintenance.backend.active  — backend's maintenance state
//   - admin.bypass.disabled       — when true, admins are blocked too (full lockdown)
//   - use.backend.check           — when true, enable the backend liveness probe
//
// Per-client maintenance is COMPOSED from the dependency flags, per request:
//
//   Web / apex / API-host request (everything except /api/mobile/*):
//     webDown = maintenance.web.active OR maintenance.backend.active
//       (web cannot function without the backend, so a backend-down also takes
//        web down; the probe does NOT gate web)
//     When webDown:
//       admin.bypass.disabled=false → allow admin + API only (block !isAdminRequest)
//       admin.bypass.disabled=true  → block everyone (full lockdown)
//
//   Mobile request (path starts with /api/mobile/):
//     backendDown = maintenance.backend.active OR probeFailed
//       (mobile depends only on the backend; maintenance.web.active does NOT
//        affect mobile, and admin.bypass.disabled does NOT apply — mobile has
//        no admin surface)
//     When backendDown → 503 maintenance JSON (mobile keys off the
//        X-Oglasino-Maintenance header, not the bare 503).
//     Otherwise → strip the /mobile segment (/api/mobile/<rest> → /api/<rest>)
//        and forward to BACKEND_ORIGIN; the backend never sees /mobile.
//
// Backend liveness probe (gated by use.backend.check; mobile path only):
//   GETs BACKEND_ORIGIN/api/public/health/check with
//   { cf: { cacheTtl: 30, cacheEverything: true } }. The edge cache bounds
//   backend probe load to ~once per TTL per edge location regardless of how
//   many mobile clients hit the worker. A non-2xx or thrown probe → probeFailed.
//   The target is the same public health endpoint the mobile boot gate calls,
//   so the probe and the client agree on "backend reachable". It is a shallow
//   liveness check: app up, dependencies (db/redis/es) unknown. The former
//   target — /actuator/health/readiness — was dependency-aware but is not
//   served to outside callers (bare /actuator/* 404s at the proxy, /api/actuator/*
//   is 403-blocked), so it made every probe fail and 503'd all mobile traffic
//   whenever use.backend.check was on.
//
// Fail-open: if any CONFIG.get throws, all four flags fall back to false
//   (= everything up). Better to serve traffic than to lock everyone out on a
//   transient KV outage. Do not change this to fail closed.
//
// .well-known app-association files BYPASS this matrix (deliberate exception):
//   GET /.well-known/apple-app-site-association and /.well-known/assetlinks.json
//   are served directly by the worker, before the maintenance gate / origin
//   forward / KV reads, and tier-correct per env (prod = com.oglasino,
//   stage = com.oglasino.preview). A 503 (or an origin-emitted redirect) for
//   these during a maintenance window can de-verify the domain's app
//   association — verification must survive maintenance.
// ============================================================================

export interface Env {
  CONFIG: KVNamespace;
  FRONTEND_ORIGIN: string;
  BACKEND_ORIGIN: string;
  MAINTENANCE_ORIGIN: string;
  APEX_HOST: string;
  WWW_HOST: string; // empty string when env has no www variant (e.g., stage)
  API_HOST: string;
  ENVIRONMENT: string; // "stage" | "production"
}

const MAINTENANCE_JSON = JSON.stringify({
  status: "maintenance",
  message:
    "Oglasino is undergoing maintenance. Please try again in a few minutes.",
  retryAfter: 120,
});

const NOINDEX_HEADER = "noindex, nofollow, noarchive, nosnippet";

// Backend liveness probe target, appended to BACKEND_ORIGIN (see the probe note
// at the top of this file). Same path on every env — the origin differs, the
// endpoint does not.
const BACKEND_PROBE_PATH = "/api/public/health/check";

// .well-known app-association files, served directly by the worker (see the
// maintenance-matrix note above). Tier-correct: prod uses the com.oglasino
// identifiers, stage the com.oglasino.preview ones. The iOS Team ID
// (44PHQVN8PB) is shared across tiers. The Android sha256 fingerprints are the
// registered signing-key SHA-256s (prod: the Play App Signing key + the upload
// key from Play Console; stage: the EAS preview keystore).
const WELL_KNOWN_AASA_PATH = "/.well-known/apple-app-site-association";
const WELL_KNOWN_ASSETLINKS_PATH = "/.well-known/assetlinks.json";

// Identical across tiers; only the appID differs. Shared so the two AASA bodies
// can't drift apart. The leading /*/ wildcard matches the locale segment (the OS
// matches the un-stripped web URL; +native-intent strips the locale afterward).
const AASA_COMPONENTS = [
  { "/": "/*/product/*" },
  { "/": "/*/user/*" },
  { "/": "/*/catalog" },
  { "/": "/*/catalog/*" },
  { "/": "/*/about" },
  { "/": "/*/pricing" },
  { "/": "/*/privacy" },
  { "/": "/*/terms" },
  { "/": "/*/blog/free-zone" },
];

const AASA_PROD = JSON.stringify({
  applinks: {
    details: [
      { appIDs: ["44PHQVN8PB.com.oglasino"], components: AASA_COMPONENTS },
    ],
  },
});

const AASA_STAGE = JSON.stringify({
  applinks: {
    details: [
      {
        appIDs: ["44PHQVN8PB.com.oglasino.preview"],
        components: AASA_COMPONENTS,
      },
    ],
  },
});

const ASSETLINKS_PROD = JSON.stringify([
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.oglasino",
      sha256_cert_fingerprints: [
        "F3:65:E3:D9:BE:B0:90:D8:BD:3B:CD:B6:71:1B:F8:34:9C:7B:A8:20:4F:74:95:51:DE:11:02:EA:AE:87:92:83",
        "31:11:F7:8A:6A:CB:8F:C3:18:C9:E9:CA:66:67:2A:72:4C:56:52:B3:B0:49:FD:37:A6:A5:57:02:32:9A:C5:B1",
      ],
    },
  },
]);

const ASSETLINKS_STAGE = JSON.stringify([
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.oglasino.preview",
      sha256_cert_fingerprints: ["8E:BB:98:89:E6:8C:2B:3D:7E:AC:46:96:D7:38:C4:01:E6:18:85:B6:DF:E8:19:52:DE:EC:08:1A:CC:D7:6C:5A"],
    },
  },
]);

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    // www → apex 301 (only when env has a WWW_HOST)
    if (env.WWW_HOST && host === env.WWW_HOST) {
      return Response.redirect(
        `https://${env.APEX_HOST}${path}${url.search}`,
        301
      );
    }

    // Serve the .well-known app-association files directly — before the
    // maintenance gate, the origin forward, and the KV reads. Tier-correct per
    // env (not host); built without forwardToOrigin so no redirect or stage
    // noindex header attaches. Deliberate maintenance-matrix exception (see the
    // note at the top of this file).
    if (path === WELL_KNOWN_AASA_PATH || path === WELL_KNOWN_ASSETLINKS_PATH) {
      const isStageEnv = env.ENVIRONMENT === "stage";
      const body =
        path === WELL_KNOWN_AASA_PATH
          ? isStageEnv
            ? AASA_STAGE
            : AASA_PROD
          : isStageEnv
            ? ASSETLINKS_STAGE
            : ASSETLINKS_PROD;
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "max-age=3600",
        },
      });
    }

    const isApi = host === env.API_HOST;
    const isFrontend = host === env.APEX_HOST;

    if (!isApi && !isFrontend) {
      return new Response("Not found", { status: 404 });
    }

    // Mobile traffic is identified purely by path — it arrives on the apex host
    // (prod) or the API host (stage), so host classification can't tell it apart.
    const isMobile = path.startsWith("/api/mobile/");

    // Requests that count as "admin infrastructure" and should be allowed
    // through when maintenance is active but the admin bypass is enabled.
    const isAdminRequest =
      // The admin page itself and anything under it (e.g. /rs-sr/admin, /en-us/admin/users)
      /^\/[a-z]{2}-[a-z]{2}\/admin(\/|$)/i.test(path) ||
      // All API traffic (admin talks to the backend)
      isApi ||
      path.startsWith("/api/") ||
      // Next.js static assets and chunks
      path.startsWith("/_next/") ||
      // Common static files the browser will request
      path === "/favicon.ico";

    // Read all four maintenance flags (30s edge cache each). Every read sits
    // inside this single fail-open try/catch — including use.backend.check, so
    // a throw on ANY read resets ALL flags to false (full fail-open).
    let maintenanceWebActive = false;
    let maintenanceBackendActive = false;
    let adminBypassDisabled = false;
    let useBackendCheck = false;
    try {
      const [webRaw, backendRaw, bypassRaw, backendCheckRaw] =
        await Promise.all([
          env.CONFIG.get("maintenance.web.active", { cacheTtl: 30 }),
          env.CONFIG.get("maintenance.backend.active", { cacheTtl: 30 }),
          env.CONFIG.get("admin.bypass.disabled", { cacheTtl: 30 }),
          env.CONFIG.get("use.backend.check", { cacheTtl: 30 }),
        ]);
      maintenanceWebActive = webRaw === "true";
      maintenanceBackendActive = backendRaw === "true";
      adminBypassDisabled = bypassRaw === "true";
      useBackendCheck = backendCheckRaw === "true";
    } catch (_err) {
      // Fail open on KV errors — better to serve traffic than to lock everyone out.
      // All four flags fall back to false (equivalent to "no KV entry").
      maintenanceWebActive = false;
      maintenanceBackendActive = false;
      adminBypassDisabled = false;
      useBackendCheck = false;
    }

    const isStage = env.ENVIRONMENT === "stage";

    // Mobile path (/api/mobile/*): a worker-only label. Gated on backend
    // availability only — never on web maintenance or the admin bypass.
    if (isMobile) {
      let backendDown = maintenanceBackendActive;
      // Probe only when the backend isn't already known down (mirrors the
      // "skip probe when maintenance is set" optimization and bounds load).
      if (!backendDown && useBackendCheck) {
        try {
          const probe = await fetch(
            `${env.BACKEND_ORIGIN}${BACKEND_PROBE_PATH}`,
            { cf: { cacheTtl: 30, cacheEverything: true } }
          );
          if (!probe.ok) backendDown = true;
        } catch (_err) {
          backendDown = true;
        }
      }
      if (backendDown) {
        return maintenanceResponse(true, path, url.search, env, isStage);
      }
      // Strip the /mobile segment: /api/mobile/<rest> → /api/<rest>.
      const backendPath = "/api" + path.slice("/api/mobile".length);
      return forwardToOrigin(
        env.BACKEND_ORIGIN,
        backendPath,
        url.search,
        request,
        isStage
      );
    }

    // Web / apex / API-host composition: web is down when its own flag OR the
    // backend flag is set. The admin bypass shapes who gets through:
    // - bypass enabled (admin.bypass.disabled=false) → block only non-admin
    // - bypass disabled (admin.bypass.disabled=true)  → block everyone
    const webDown = maintenanceWebActive || maintenanceBackendActive;
    if (webDown) {
      const shouldBlock = adminBypassDisabled || !isAdminRequest;
      if (shouldBlock) {
        return maintenanceResponse(isApi, path, url.search, env, isStage);
      }
    }

    if (isApi) {
      return forwardToOrigin(
        env.BACKEND_ORIGIN,
        path,
        url.search,
        request,
        isStage
      );
    }
    return forwardToOrigin(
      env.FRONTEND_ORIGIN,
      path,
      url.search,
      request,
      isStage
    );
  },
};

function maintenanceResponse(
  isApi: boolean,
  path: string,
  search: string,
  env: Env,
  addNoIndex: boolean
): Response | Promise<Response> {
  if (isApi) {
    return new Response(MAINTENANCE_JSON, {
      status: 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": "120",
        "Cache-Control": "no-store",
        "X-Oglasino-Maintenance": "true",
      },
    });
  }

  return fetch(`${env.MAINTENANCE_ORIGIN}${path}${search}`).then((upstream) => {
    const headers = new Headers(upstream.headers);
    headers.set("X-Oglasino-Maintenance", "true");
    headers.set("Cache-Control", "no-store");
    headers.set("Retry-After", "120");
    // Stage maintenance pages must not be indexed, same as forwarded stage
    // traffic — the MAINTENANCE_ORIGIN upstream doesn't set this itself.
    if (addNoIndex) {
      headers.set("X-Robots-Tag", NOINDEX_HEADER);
    }
    return new Response(upstream.body, {
      status: 503,
      statusText: "Service Unavailable",
      headers,
    });
  });
}

async function forwardToOrigin(
  originBase: string,
  path: string,
  search: string,
  originalRequest: Request,
  addNoIndex: boolean
): Promise<Response> {
  const targetUrl = `${originBase}${path}${search}`;

  const newHeaders = new Headers(originalRequest.headers);
  const originalHost = originalRequest.headers.get("Host") || "";
  if (originalHost) {
    newHeaders.set("X-Forwarded-Host", originalHost);
    newHeaders.set("X-Forwarded-Proto", "https");
  }
  // Marks the request as having passed through this Worker, so the origin can
  // tell edge-proxied traffic from a direct hit on the *.vercel.app host and
  // redirect the latter to the canonical host. Spoofable by design — it gates
  // nothing (see the brief's trust-boundary note).
  newHeaders.set("x-oglasino-edge", "1");

  const forwarded = new Request(targetUrl, {
    method: originalRequest.method,
    headers: newHeaders,
    body: originalRequest.body,
    redirect: "manual",
  });

  const upstream = await fetch(forwarded);

  // For stage subdomains, force noindex headers regardless of upstream
  if (addNoIndex) {
    const respHeaders = new Headers(upstream.headers);
    respHeaders.set("X-Robots-Tag", NOINDEX_HEADER);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  }

  return upstream;
}
