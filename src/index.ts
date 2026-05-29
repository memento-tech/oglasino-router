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
//   GETs BACKEND_ORIGIN/actuator/health/readiness with
//   { cf: { cacheTtl: 30, cacheEverything: true } }. The edge cache bounds
//   backend probe load to ~once per TTL per edge location regardless of how
//   many mobile clients hit the worker. A non-2xx or thrown probe → probeFailed.
//
// Fail-open: if any CONFIG.get throws, all four flags fall back to false
//   (= everything up). Better to serve traffic than to lock everyone out on a
//   transient KV outage. Do not change this to fail closed.
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
            `${env.BACKEND_ORIGIN}/actuator/health/readiness`,
            { cf: { cacheTtl: 30, cacheEverything: true } }
          );
          if (!probe.ok) backendDown = true;
        } catch (_err) {
          backendDown = true;
        }
      }
      if (backendDown) {
        return maintenanceResponse(true, path, url.search, env);
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
        return maintenanceResponse(isApi, path, url.search, env);
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
  env: Env
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
