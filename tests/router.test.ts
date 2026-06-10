import { describe, it, expect, afterEach, vi } from "vitest";
import worker, { type Env } from "../src/index";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function makeKv(
  values: Record<string, string | null> = {},
  opts: { throwForKey?: string } = {}
): KVNamespace {
  return {
    get: vi.fn(async (key: string) => {
      if (opts.throwForKey && key === opts.throwForKey) {
        throw new Error("KV unavailable");
      }
      return values[key] ?? null;
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function prodEnv(
  kvValues: Record<string, string | null> = {},
  kvOpts: { throwForKey?: string } = {}
): Env {
  return {
    CONFIG: makeKv(kvValues, kvOpts),
    FRONTEND_ORIGIN: "https://oglasino-web-prod.vercel.app",
    BACKEND_ORIGIN: "https://api-origin.oglasino.com",
    MAINTENANCE_ORIGIN: "https://oglasino-maintenance.pages.dev",
    APEX_HOST: "oglasino.com",
    WWW_HOST: "www.oglasino.com",
    API_HOST: "api.oglasino.com",
    ENVIRONMENT: "production",
  };
}

function stageEnv(
  kvValues: Record<string, string | null> = {},
  kvOpts: { throwForKey?: string } = {}
): Env {
  return {
    CONFIG: makeKv(kvValues, kvOpts),
    FRONTEND_ORIGIN: "https://oglasino-web-stage.vercel.app",
    BACKEND_ORIGIN: "https://api-origin-stage.oglasino.com",
    MAINTENANCE_ORIGIN: "https://oglasino-maintenance.pages.dev",
    APEX_HOST: "stage.oglasino.com",
    WWW_HOST: "",
    API_HOST: "api-stage.oglasino.com",
    ENVIRONMENT: "stage",
  };
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("router", () => {
  describe("host routing", () => {
    it("redirects www → apex (301) preserving path and query", async () => {
      const env = prodEnv();
      const req = new Request("https://www.oglasino.com/foo/bar?q=1");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe(
        "https://oglasino.com/foo/bar?q=1"
      );
    });

    it("does not redirect when WWW_HOST is empty (stage env)", async () => {
      const env = stageEnv();
      const req = new Request("https://www.stage.oglasino.com/foo");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown host", async () => {
      const env = prodEnv();
      const req = new Request("https://random.example.com/foo");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(404);
    });
  });

  // Composition row: web up when both dependency flags are off → allow everyone
  describe("matrix: maintenance off — allow everyone", () => {
    it("API forwards to BACKEND_ORIGIN", async () => {
      const env = prodEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("hello", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://api.oglasino.com/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://api-origin.oglasino.com/v1/things"
      );
    });

    it("frontend forwards to FRONTEND_ORIGIN", async () => {
      const env = prodEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("<html/>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/page?x=1");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/page?x=1"
      );
    });

    it("admin frontend path forwards to FRONTEND_ORIGIN", async () => {
      const env = prodEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("<html/>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/rs-sr/admin/users");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/rs-sr/admin/users"
      );
    });
  });

  // Two-flag web composition: webDown = web.active OR backend.active.
  describe("web composition: webDown = web.active OR backend.active", () => {
    it("web.active only → web is down (non-admin page blocked)", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/foo");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-maintenance.pages.dev/foo"
      );
    });

    it("backend.active only → web is down (non-admin page blocked)", async () => {
      const env = prodEnv({ "maintenance.backend.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/foo");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
    });

    it("both flags off → web is up (forwards normally)", async () => {
      const env = prodEnv({
        "maintenance.web.active": "false",
        "maintenance.backend.active": "false",
      });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("<html/>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/foo");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/foo"
      );
    });

    it("admin bypass still works when maintenance on + bypass enabled", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("<html/>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/rs-sr/admin/users");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/rs-sr/admin/users"
      );
    });
  });

  // Composition row: web down (web.active=true), admin.bypass.disabled=false → allow admin + API only
  describe("matrix: maintenance on + bypass enabled — allow admin + API", () => {
    it("admin API path bypasses and forwards to BACKEND_ORIGIN", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://api.oglasino.com/admin/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://api-origin.oglasino.com/admin/things"
      );
    });

    it("non-admin API path also bypasses (matrix: API allowed)", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://api.oglasino.com/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://api-origin.oglasino.com/v1/things"
      );
    });

    it("admin frontend path /xx-xx/admin/... bypasses", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("<html/>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/rs-sr/admin/users");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/rs-sr/admin/users"
      );
    });

    it("admin frontend root /xx-xx/admin bypasses", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("<html/>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/en-us/admin");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/en-us/admin"
      );
    });

    it("/api/... on frontend host bypasses (Next.js API routes)", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("{}", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/users");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/api/users"
      );
    });

    it("/_next/ assets bypass", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("/* chunk */", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/_next/static/chunk.js");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/_next/static/chunk.js"
      );
    });

    it("/favicon.ico bypasses", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/favicon.ico");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/favicon.ico"
      );
    });

    it("non-admin frontend page is blocked with 503 from MAINTENANCE_ORIGIN", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/foo?x=1");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Retry-After")).toBe("120");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-maintenance.pages.dev/foo?x=1"
      );
    });
  });

  // Composition row: web down + admin.bypass.disabled=true → block everyone
  describe("matrix: maintenance on + bypass disabled — full lockdown", () => {
    it("API request returns 503 JSON", async () => {
      const env = prodEnv({
        "maintenance.web.active": "true",
        "admin.bypass.disabled": "true",
      });
      const req = new Request("https://api.oglasino.com/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      expect(res.headers.get("Retry-After")).toBe("120");
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const body = (await res.json()) as { status: string; retryAfter: number };
      expect(body.status).toBe("maintenance");
      expect(body.retryAfter).toBe(120);
    });

    it("admin API path also returns 503 JSON (full lockdown blocks admin too)", async () => {
      const env = prodEnv({
        "maintenance.web.active": "true",
        "admin.bypass.disabled": "true",
      });
      const req = new Request("https://api.oglasino.com/admin/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("Content-Type")).toContain("application/json");
    });

    it("admin frontend path returns 503 from MAINTENANCE_ORIGIN", async () => {
      const env = prodEnv({
        "maintenance.web.active": "true",
        "admin.bypass.disabled": "true",
      });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/rs-sr/admin/users");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-maintenance.pages.dev/rs-sr/admin/users"
      );
    });

    it("non-admin frontend returns 503 from MAINTENANCE_ORIGIN", async () => {
      const env = prodEnv({
        "maintenance.web.active": "true",
        "admin.bypass.disabled": "true",
      });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/foo");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
    });

    it("/_next/ asset also returns 503 (no static carve-out in full lockdown)", async () => {
      const env = prodEnv({
        "maintenance.web.active": "true",
        "admin.bypass.disabled": "true",
      });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/_next/static/chunk.js");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
    });

    it("backend.active drives full lockdown too (web.active off)", async () => {
      const env = prodEnv({
        "maintenance.backend.active": "true",
        "admin.bypass.disabled": "true",
      });
      const req = new Request("https://api.oglasino.com/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
    });
  });

  describe("mobile path (/api/mobile/*)", () => {
    it("backend.active true → mobile gets 503 + X-Oglasino-Maintenance", async () => {
      const env = prodEnv({ "maintenance.backend.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("should not forward", {
          status: 200,
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
      expect(res.headers.get("Content-Type")).toContain("application/json");
      // No origin/probe call — backend already known down via the flag.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("probe fails (non-ok) → mobile gets 503", async () => {
      const env = prodEnv({ "use.backend.check": "true" });
      const fetchMock = vi.fn(async (input: unknown) => {
        const u = urlOf(input);
        if (u.endsWith("/actuator/health/readiness"))
          return new Response("down", { status: 503 });
        return new Response("should not reach origin", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
    });

    it("probe throws → mobile gets 503", async () => {
      const env = prodEnv({ "use.backend.check": "true" });
      const fetchMock = vi.fn(async (input: unknown) => {
        const u = urlOf(input);
        if (u.endsWith("/actuator/health/readiness"))
          throw new Error("network");
        return new Response("should not reach origin", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
    });

    it("both clear → mobile forwards to backend with /mobile stripped", async () => {
      const env = prodEnv({ "use.backend.check": "true" });
      const fetchMock = vi.fn(async (input: unknown) => {
        const u = urlOf(input);
        if (u.endsWith("/actuator/health/readiness"))
          return new Response("ok", { status: 200 });
        return new Response("from origin", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request(
        "https://oglasino.com/api/mobile/v1/things?q=1"
      );
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("from origin");
      // Forwarded URL is /api/<rest> — no /mobile segment.
      const forwarded = fetchMock.mock.calls
        .map((c) => urlOf(c[0]))
        .find((u) => u.startsWith("https://api-origin.oglasino.com/api/"));
      expect(forwarded).toBe("https://api-origin.oglasino.com/api/v1/things?q=1");
      expect(forwarded).not.toContain("/mobile");
    });

    it("no probe configured + both flags clear → mobile forwards stripped", async () => {
      const env = prodEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("from origin", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://api-origin.oglasino.com/api/v1/things"
      );
      // Probe not run when use.backend.check is unset.
      const probed = fetchMock.mock.calls.some((c) =>
        urlOf(c[0]).endsWith("/actuator/health/readiness")
      );
      expect(probed).toBe(false);
    });

    it("ignores maintenance.web.active — web down, backend up, probe ok → mobile FORWARDS", async () => {
      const env = prodEnv({
        "maintenance.web.active": "true",
        "maintenance.backend.active": "false",
        "use.backend.check": "true",
      });
      const fetchMock = vi.fn(async (input: unknown) => {
        const u = urlOf(input);
        if (u.endsWith("/actuator/health/readiness"))
          return new Response("ok", { status: 200 });
        return new Response("from origin", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      const res = await worker.fetch(req, env, ctx);
      // The core decoupling: web maintenance must not block mobile. Assert the
      // request was actually handled by the mobile branch (stripped forward to
      // BACKEND_ORIGIN, probe run) — not merely "not blocked" by some other path.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("from origin");
      const forwarded = fetchMock.mock.calls
        .map((c) => urlOf(c[0]))
        .find((u) => u.startsWith("https://api-origin.oglasino.com/api/"));
      expect(forwarded).toBe("https://api-origin.oglasino.com/api/v1/things");
      const probed = fetchMock.mock.calls.some((c) =>
        urlOf(c[0]).endsWith("/actuator/health/readiness")
      );
      expect(probed).toBe(true);
    });

    it("ignores admin.bypass.disabled — full web lockdown, backend up → mobile FORWARDS", async () => {
      const env = prodEnv({
        "maintenance.web.active": "true",
        "admin.bypass.disabled": "true",
      });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("from origin", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://api-origin.oglasino.com/api/v1/things"
      );
    });

    it("probe target is /actuator/health/readiness with edge cache opts", async () => {
      const env = prodEnv({ "use.backend.check": "true" });
      let probeInit: RequestInit | undefined;
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const u = urlOf(input);
        if (u.endsWith("/actuator/health/readiness")) {
          probeInit = init;
          return new Response("ok", { status: 200 });
        }
        return new Response("from origin", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      await worker.fetch(req, env, ctx);
      const probed = fetchMock.mock.calls
        .map((c) => urlOf(c[0]))
        .find((u) => u.includes("/actuator/health/readiness"));
      expect(probed).toBe(
        "https://api-origin.oglasino.com/actuator/health/readiness"
      );
      expect(
        (probeInit as unknown as { cf?: { cacheTtl?: number } })?.cf?.cacheTtl
      ).toBe(30);
    });

    it("backend.active true short-circuits the probe (no probe call)", async () => {
      const env = prodEnv({
        "maintenance.backend.active": "true",
        "use.backend.check": "true",
      });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      await worker.fetch(req, env, ctx);
      const probed = fetchMock.mock.calls.some((c) =>
        urlOf(c[0]).endsWith("/actuator/health/readiness")
      );
      expect(probed).toBe(false);
    });

    it("mobile traffic on the API host also strips /mobile and forwards", async () => {
      const env = stageEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("from origin", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request(
        "https://api-stage.oglasino.com/api/mobile/v1/things"
      );
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://api-origin-stage.oglasino.com/api/v1/things"
      );
    });
  });

  describe("KV error handling (fail-open)", () => {
    it("KV throws on maintenance.web.active: fails open (normal routing)", async () => {
      const env = prodEnv({}, { throwForKey: "maintenance.web.active" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toContain(
        "oglasino-web-prod.vercel.app"
      );
    });

    it("KV throws on maintenance.backend.active: fails open (normal routing)", async () => {
      const env = prodEnv({}, { throwForKey: "maintenance.backend.active" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toContain(
        "oglasino-web-prod.vercel.app"
      );
    });

    it("KV throws on admin.bypass.disabled: fails open (normal routing)", async () => {
      const env = prodEnv({}, { throwForKey: "admin.bypass.disabled" });
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toContain(
        "oglasino-web-prod.vercel.app"
      );
    });

    it("KV throws on use.backend.check: fails open — all flags false, normal routing", async () => {
      const env = prodEnv(
        { "maintenance.web.active": "true" },
        { throwForKey: "use.backend.check" }
      );
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/");
      const res = await worker.fetch(req, env, ctx);
      // Throw on any read resets ALL flags to false, so even the set
      // maintenance.web.active does not block — full fail-open.
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toContain(
        "oglasino-web-prod.vercel.app"
      );
    });

    it("KV throws on use.backend.check: mobile fails open too (forwards stripped)", async () => {
      const env = prodEnv(
        { "maintenance.backend.active": "true" },
        { throwForKey: "use.backend.check" }
      );
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("from origin", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/api/mobile/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://api-origin.oglasino.com/api/v1/things"
      );
    });
  });

  describe("noindex header (stage subdomain SEO protection)", () => {
    it("added for stage frontend hosts", async () => {
      const env = stageEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("ok", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://stage.oglasino.com/");
      const res = await worker.fetch(req, env, ctx);
      expect(res.headers.get("X-Robots-Tag")).toBe(
        "noindex, nofollow, noarchive, nosnippet"
      );
    });

    it("added for stage API hosts", async () => {
      const env = stageEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://api-stage.oglasino.com/v1/things");
      const res = await worker.fetch(req, env, ctx);
      expect(res.headers.get("X-Robots-Tag")).toBe(
        "noindex, nofollow, noarchive, nosnippet"
      );
    });

    it("not added for production hosts", async () => {
      const env = prodEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("ok", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/");
      const res = await worker.fetch(req, env, ctx);
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
    });

    it("added on the stage maintenance HTML 503 response", async () => {
      const env = stageEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://stage.oglasino.com/foo");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
      expect(res.headers.get("X-Robots-Tag")).toBe(
        "noindex, nofollow, noarchive, nosnippet"
      );
      // Served from MAINTENANCE_ORIGIN (the HTML branch), not the origin.
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-maintenance.pages.dev/foo"
      );
    });

    it("not added on the production maintenance HTML 503 response", async () => {
      const env = prodEnv({ "maintenance.web.active": "true" });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/foo");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-Oglasino-Maintenance")).toBe("true");
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
    });
  });

  describe(".well-known app-association files (direct-served)", () => {
    it("prod AASA → 200 application/json with com.oglasino appID", async () => {
      const env = prodEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("should not forward", {
          status: 200,
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request(
        "https://oglasino.com/.well-known/apple-app-site-association"
      );
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
      const body = (await res.json()) as {
        applinks: { details: Array<{ appIDs: string[]; components: unknown[] }> };
      };
      expect(body.applinks.details[0].appIDs).toEqual([
        "44PHQVN8PB.com.oglasino",
      ]);
      expect(body.applinks.details[0].components).toHaveLength(9);
      // Served by the worker, not the origin.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stage AASA → preview appID (tier-correct, keyed off env not host)", async () => {
      const env = stageEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("should not forward", {
          status: 200,
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request(
        "https://stage.oglasino.com/.well-known/apple-app-site-association"
      );
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        applinks: { details: Array<{ appIDs: string[] }> };
      };
      expect(body.applinks.details[0].appIDs).toEqual([
        "44PHQVN8PB.com.oglasino.preview",
      ]);
      // No stage noindex header (not routed through forwardToOrigin).
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("prod assetlinks → 200 application/json with com.oglasino package", async () => {
      const env = prodEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("should not forward", {
          status: 200,
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request(
        "https://oglasino.com/.well-known/assetlinks.json"
      );
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      const body = (await res.json()) as Array<{
        target: { package_name: string };
      }>;
      expect(body[0].target.package_name).toBe("com.oglasino");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stage assetlinks → com.oglasino.preview package (tier-correct)", async () => {
      const env = stageEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("should not forward", {
          status: 200,
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request(
        "https://stage.oglasino.com/.well-known/assetlinks.json"
      );
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        target: { package_name: string };
      }>;
      expect(body[0].target.package_name).toBe("com.oglasino.preview");
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("served even when maintenance is active (bypasses the gate)", async () => {
      const env = prodEnv({
        "maintenance.web.active": "true",
        "maintenance.backend.active": "true",
        "admin.bypass.disabled": "true",
      });
      const fetchMock = vi.fn(
        async (_input: unknown) =>
          new Response("<html>maint</html>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request(
        "https://oglasino.com/.well-known/apple-app-site-association"
      );
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("X-Oglasino-Maintenance")).toBeNull();
      // Full lockdown is set, yet no maintenance origin was hit.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("not redirected on apex (served directly, not 301'd)", async () => {
      const env = prodEnv();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("x", { status: 200 }))
      );
      const req = new Request(
        "https://oglasino.com/.well-known/assetlinks.json"
      );
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("Location")).toBeNull();
    });

    it("an unrelated path still forwards as before (no regression)", async () => {
      const env = prodEnv();
      const fetchMock = vi.fn(
        async (_input: unknown) => new Response("<html/>", { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/.well-known/other.txt");
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
        "https://oglasino-web-prod.vercel.app/.well-known/other.txt"
      );
    });
  });

  describe("forwarding", () => {
    it("X-Forwarded-Host + X-Forwarded-Proto set when forwarding to origin", async () => {
      const env = prodEnv();
      let captured: Request | null = null;
      const fetchMock = vi.fn(async (input: unknown) => {
        if (input instanceof Request) captured = input;
        return new Response("ok", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/page");
      req.headers.set("Host", "oglasino.com");
      await worker.fetch(req, env, ctx);
      expect(captured).not.toBeNull();
      const fwd = captured as unknown as Request;
      expect(fwd.headers.get("X-Forwarded-Host")).toBe("oglasino.com");
      expect(fwd.headers.get("X-Forwarded-Proto")).toBe("https");
    });

    it("POST method preserved when forwarding to origin", async () => {
      const env = prodEnv();
      let capturedMethod: string | null = null;
      let capturedUrl: string | null = null;
      const fetchMock = vi.fn(async (input: unknown) => {
        if (input instanceof Request) {
          capturedMethod = input.method;
          capturedUrl = input.url;
        }
        return new Response("ok", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://api.oglasino.com/v1/things", {
        method: "POST",
      });
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toBe("https://api-origin.oglasino.com/v1/things");
    });

    it("query string preserved when forwarding", async () => {
      const env = prodEnv();
      let capturedUrl: string | null = null;
      const fetchMock = vi.fn(async (input: unknown) => {
        if (input instanceof Request) capturedUrl = input.url;
        return new Response("ok", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const req = new Request("https://oglasino.com/search?q=hello&page=2");
      await worker.fetch(req, env, ctx);
      expect(capturedUrl).toBe(
        "https://oglasino-web-prod.vercel.app/search?q=hello&page=2"
      );
    });
  });
});
