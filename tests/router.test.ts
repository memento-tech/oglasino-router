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

function stageEnv(kvValues: Record<string, string | null> = {}): Env {
  return {
    CONFIG: makeKv(kvValues),
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

  it("admin path bypasses maintenance and forwards to backend", async () => {
    const env = prodEnv({ "maintenance.active": "true" });
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

  it("maintenance flag true + non-admin: API gets 503 JSON", async () => {
    const env = prodEnv({ "maintenance.active": "true" });
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

  it("maintenance flag true + non-admin: frontend served from MAINTENANCE_ORIGIN with 503", async () => {
    const env = prodEnv({ "maintenance.active": "true" });
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
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(urlOf(fetchMock.mock.calls[0][0])).toBe(
      "https://oglasino-maintenance.pages.dev/foo?x=1"
    );
  });

  it("maintenance flag false: API forwards to BACKEND_ORIGIN", async () => {
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

  it("maintenance flag false: frontend forwards to FRONTEND_ORIGIN", async () => {
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

  it("backend liveness probe failure: maintenance kicks in", async () => {
    const env = prodEnv({ "use.backend.check": "true" });
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = urlOf(input);
      if (u.endsWith("/health")) return new Response("down", { status: 502 });
      return new Response("should not reach origin", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request("https://api.oglasino.com/v1/things");
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(503);
  });

  it("backend liveness probe success: normal routing to origin", async () => {
    const env = prodEnv({ "use.backend.check": "true" });
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = urlOf(input);
      if (u.endsWith("/health")) return new Response("ok", { status: 200 });
      return new Response("from origin", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request("https://api.oglasino.com/v1/things");
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from origin");
  });

  it("KV read failure: maintenance fails open (normal routing)", async () => {
    const env = prodEnv({}, { throwForKey: "maintenance.active" });
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

  it("noindex header added for stage hosts", async () => {
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

  it("noindex header NOT added for production hosts", async () => {
    const env = prodEnv();
    const fetchMock = vi.fn(
      async (_input: unknown) => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request("https://oglasino.com/");
    const res = await worker.fetch(req, env, ctx);
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("X-Forwarded-Host header set when forwarding to origin", async () => {
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
});
