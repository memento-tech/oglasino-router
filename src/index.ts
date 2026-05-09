// ============================================================================
// Oglasino router Worker.
// Serves prod and stage environments via wrangler.toml [env.*] config.
// Routes frontend → Vercel, API → droplet (via gray-cloud origin),
// maintenance page when KV flag CONFIG.maintenance.active === "true".
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
  message: "Oglasino is undergoing maintenance. Please try again in a few minutes.",
  retryAfter: 120,
});

const NOINDEX_HEADER = "noindex, nofollow, noarchive, nosnippet";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    // www → apex 301 (only when env has a WWW_HOST)
    if (env.WWW_HOST && host === env.WWW_HOST) {
      return Response.redirect(`https://${env.APEX_HOST}${path}${url.search}`, 301);
    }

    const isApi = host === env.API_HOST;
    const isFrontend = host === env.APEX_HOST;

    if (!isApi && !isFrontend) {
      return new Response("Not found", { status: 404 });
    }

    // Admin path bypasses maintenance
    const isAdminBypass = path.startsWith("/admin");

    // Read maintenance flag (30s edge cache)
    let maintenanceActive = false;
    try {
      const v = await env.CONFIG.get("maintenance.active", { cacheTtl: 30 });
      maintenanceActive = v === "true";
    } catch (_err) {
      maintenanceActive = false; // fail open on KV errors
    }

    // Optional: backend liveness probe
    if (!maintenanceActive) {
      const useBackendCheck = await env.CONFIG.get("use.backend.check", { cacheTtl: 30 });
      if (useBackendCheck === "true") {
        try {
          const probe = await fetch(`${env.BACKEND_ORIGIN}/health`, {
            cf: { cacheTtl: 30, cacheEverything: true },
          });
          if (!probe.ok) maintenanceActive = true;
        } catch (_err) {
          maintenanceActive = true;
        }
      }
    }

    if (maintenanceActive && !isAdminBypass) {
      return maintenanceResponse(isApi, path, url.search, env);
    }

    const isStage = env.ENVIRONMENT === "stage";

    if (isApi) {
      return forwardToOrigin(env.BACKEND_ORIGIN, path, url.search, request, isStage);
    }
    return forwardToOrigin(env.FRONTEND_ORIGIN, path, url.search, request, isStage);
  },
};

function maintenanceResponse(
  isApi: boolean,
  path: string,
  search: string,
  env: Env,
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
  addNoIndex: boolean,
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
