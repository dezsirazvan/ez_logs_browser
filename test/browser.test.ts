import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUPABASE = "https://abc.supabase.co";
const ENDPOINT = "https://ezlogs.test/api/ingest/browser";
const SESSION = "5e55e55e-1111-4222-8333-944455556666";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "ES256" })}.${b64({ sub: "u1", email: "dana@example.com", session_id: SESSION })}.c2lnbmF0dXJl`;
const SETTINGS = `${SUPABASE}/auth/v1/settings`;

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

// A minimal browser window: fetch, document events, location, page lifecycle.
function fakeWindow(handler: Handler) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const calls: { url: string; init?: RequestInit; input: RequestInfo | URL }[] = [];
  const doc = {
    visibilityState: "visible",
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
  };
  const w = {
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init, input });
      return handler(url, init);
    }),
    location: { href: "https://app.example.com/board", origin: "https://app.example.com", pathname: "/board", hash: "" },
    history: {
      pushState(_s: unknown, _t: string, url?: string) {
        if (url === "/boom") throw new Error("the app's own error");
        if (url) w.location.pathname = new URL(url, w.location.href).pathname;
        return "kept";
      },
      replaceState(_s: unknown, _t: string, url?: string) { if (url) w.location.pathname = new URL(url, w.location.href).pathname; },
    },
    document: doc,
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
  };
  return {
    w,
    doc,
    calls,
    fire: (type: string, extra: object = {}) => (listeners[type] ?? []).forEach((fn) => fn({ type, ...extra })),
    reports: () => calls.filter((c) => c.url === ENDPOINT).flatMap((c) => JSON.parse(String(c.init?.body)).reports),
    appCalls: (url: string) => calls.filter((c) => c.url === url),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settingsOk = (url: string) => (url === SETTINGS ? json(200, {}) : undefined);
const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

// A server function call without a login, failing: no session in its report.
async function fetchNoLogin(fake: { w: { fetch: (u: string, i?: RequestInit) => Promise<Response> } }) {
  await fake.w.fetch("/_serverFn/89b33048", { method: "GET" });
}

async function load() {
  vi.resetModules();
  return import("../src/index");
}

describe("@ezlogs/browser", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  async function setup(handler: Handler, options: { pages?: string[] } = {}) {
    const fake = fakeWindow(handler);
    (globalThis as { window?: unknown }).window = fake.w;
    const { init } = await load();
    init({ key: "ezlpub_test", supabaseUrl: SUPABASE, endpoint: ENDPOINT, ...options });
    await settle();
    return fake;
  }

  async function flush() {
    await settle();
    vi.advanceTimersByTime(1_100);
    await settle();
  }

  it("reports a failed Supabase call with its code only, and returns the app's response untouched", async () => {
    const fake = await setup(async (url) =>
      settingsOk(url) ?? (url.startsWith(`${SUPABASE}/rest/v1/tasks`) ?
        json(409, { code: "23505", message: "duplicate key", details: "Key (title)=(Secret)" }) : new Response(null, { status: 202 })));

    const response = await fake.w.fetch(`${SUPABASE}/rest/v1/tasks?select=*&title=eq.Secret`, {
      method: "POST", body: JSON.stringify({ title: "Secret" }), headers: { Authorization: `Bearer ${TOKEN}`, apikey: "anon-key" }
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "23505", message: "duplicate key", details: "Key (title)=(Secret)" });
    await flush();

    const [r] = fake.reports();
    expect(r).toEqual({ kind: "failure", method: "POST", path: "/rest/v1/tasks", status: 409, code: "23505", session_id: SESSION,
                        at: expect.any(String) });
    const sent = JSON.stringify(fake.reports());
    expect(sent).not.toContain("Secret"); // never the query string, the body or `details`
    expect(sent).not.toContain("duplicate key"); // never Supabase's message
    expect(sent).not.toContain(TOKEN.split(".")[1]); // never the login token, nor any part of it
    expect(sent).not.toContain("dana@example.com"); // nor what is inside it besides the session id
    expect(sent).not.toContain("anon-key"); // never the app's API key
    const post = fake.appCalls(ENDPOINT)[0]!;
    expect(post.init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit", headers: { "Content-Type": "text/plain" } });
    expect(JSON.parse(String(post.init?.body)).key).toBe("ezlpub_test");
  });

  it("keeps only the table, function or bucket of a path: never a file name or an id", async () => {
    const fake = await setup(async (url) => settingsOk(url) ?? json(500, {}));
    await fake.w.fetch(`${SUPABASE}/storage/v1/object/avatars/u1/passport%20scan.png`, { method: "POST" });
    await fake.w.fetch(`${SUPABASE}/storage/v1/object/public/docs/u1/a.pdf`);
    await fake.w.fetch(`${SUPABASE}/auth/v1/admin/users/1fa4eeb7-22bc-4b24-8d5f-12bd220d14a8`, { method: "DELETE" });
    await fake.w.fetch(`${SUPABASE}/rest/v1/rpc/send_invite`, { method: "POST" });
    await fake.w.fetch("/_serverFn/89b33048abc", { method: "POST" });
    await flush();
    expect(fake.reports().map((r) => r.path).sort())
      .toEqual(["/_serverFn", "/auth/v1/admin", "/rest/v1/rpc/send_invite", "/storage/v1/object/avatars", "/storage/v1/object/docs"]);
    expect(JSON.stringify(fake.reports())).not.toMatch(/passport|a\.pdf|1fa4eeb7|89b33048/);
  });

  it("reports nothing for successful calls, or calls to other hosts", async () => {
    const fake = await setup(async (url) => (url.includes("other.com") ? new Response(null, { status: 500 }) : json(200, [])));
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`);
    await fake.w.fetch("https://other.com/api", { method: "POST" });
    await flush();
    expect(fake.reports()).toEqual([]);
  });

  it("reports a call that got no answer, and the app still sees its own error", async () => {
    const fake = await setup(async (url) => {
      if (url.includes("/storage/")) throw new TypeError("Failed to fetch");
      return json(200, {});
    });
    await expect(fake.w.fetch(`${SUPABASE}/storage/v1/object/avatars/u1/me.png`, { method: "POST" })).rejects.toThrow("Failed to fetch");
    await flush();
    expect(fake.reports()[0]).toMatchObject({ path: "/storage/v1/object/avatars", status: 0 });
  });

  it("never reports a call the app cancelled", async () => {
    const fake = await setup(async () => { throw new DOMException("The user aborted a request.", "AbortError"); });
    const controller = new AbortController();
    controller.abort();
    await expect(fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { signal: controller.signal })).rejects.toThrow();
    await expect(fake.w.fetch(`${SUPABASE}/rest/v1/orders`)).rejects.toThrow();
    await flush();
    expect(fake.reports()).toEqual([]);
  });

  it("reports a failed sign-in by its code: never the email, the password or the message", async () => {
    const fake = await setup(async (url) =>
      url.includes("/auth/v1/token") ? json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }) : json(200, {}));
    await fake.w.fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: "POST", body: JSON.stringify({ email: "ana@example.com", password: "hunter2" })
    });
    await flush();
    expect(fake.reports()[0]).toEqual({ kind: "failure", method: "POST", path: "/auth/v1/token", status: 400, code: "invalid_credentials",
                                        at: expect.any(String) });
    expect(JSON.stringify(fake.reports())).not.toMatch(/hunter2|ana@example\.com|Invalid login/);
  });

  it("never sends an error message, which can quote what was typed, nor an odd code", async () => {
    const fake = await setup(async (url) => (url.includes("tasks") ? json(400, { code: "22P02", message: 'invalid input syntax: "my secret note"' }) :
      json(400, { code: "my secret note" })));
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "PATCH" });
    await fake.w.fetch(`${SUPABASE}/rest/v1/notes`, { method: "PATCH" });
    await flush();
    expect(fake.reports().map((r) => r.code).sort()).toEqual(["22P02", undefined]);
    expect(JSON.stringify(fake.reports())).not.toContain("secret");
  });

  it("never reports a session refresh failing, or .single() finding no row", async () => {
    const fake = await setup(async (url) =>
      url.includes("refresh_token") ? json(400, { error_code: "refresh_token_not_found" }) :
      url.includes("/rest/v1/profiles") ? json(406, { code: "PGRST116", message: "no rows" }) : json(200, {}));
    await fake.w.fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, { method: "POST" });
    await fake.w.fetch(`${SUPABASE}/rest/v1/profiles?id=eq.1`);
    await flush();
    expect(fake.reports()).toEqual([]);
  });

  it("reports a successful sign-out with its session id only, and no other success", async () => {
    const fake = await setup(async (url) => new Response(null, { status: url.includes("logout") ? 204 : 200 }));
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    await fake.w.fetch(`${SUPABASE}/auth/v1/logout?scope=global`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    await fake.w.fetch(`${SUPABASE}/auth/v1/logout`, { method: "POST" }); // no session: nothing to name
    await flush();
    expect(fake.reports()).toEqual([{ kind: "sign_out", method: "POST", path: "/auth/v1/logout", status: 204, session_id: SESSION,
                                      at: expect.any(String) }]);
    expect(JSON.stringify(fake.reports())).not.toContain(TOKEN.split(".")[1]);
  });

  it("takes only a well-formed session id from the token, and nothing from an odd or anonymous one", async () => {
    const fake = await setup(async () => json(500, {}));
    const anon = `${b64({ alg: "HS256" })}.${b64({ role: "anon" })}.sig`;
    const odd = `${b64({ alg: "ES256" })}.${b64({ session_id: "not-a-uuid" })}.sig`;
    await fake.w.fetch(`${SUPABASE}/rest/v1/a`, { method: "POST", headers: { Authorization: `Bearer ${anon}` } });
    await fake.w.fetch(`${SUPABASE}/rest/v1/b`, { method: "POST", headers: { Authorization: `Bearer ${odd}` } });
    await fake.w.fetch(`${SUPABASE}/rest/v1/c`, { method: "POST", headers: { Authorization: "Bearer garbage" } });
    await flush();
    expect(fake.reports().map((r) => r.session_id)).toEqual([undefined, undefined, undefined]);
  });

  it("reports the app's own server functions failing, with the session of the login the call carries", async () => {
    const fake = await setup(async () => new Response(null, { status: 500 }));
    await fake.w.fetch("/_serverFn/89b33048", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    await fetchNoLogin(fake);
    await flush();
    expect(fake.reports()[0]).toEqual({ kind: "failure", method: "POST", path: "/_serverFn", status: 500, session_id: SESSION, at: expect.any(String) });
    expect(fake.reports()[1]).toEqual({ kind: "failure", method: "GET", path: "/_serverFn", status: 500, at: expect.any(String) });
  });

  describe("the app's own server code (with @ezlogs/server)", () => {
    const wrapped = (id: string | null, status = 200) =>
      new Response(null, { status, headers: id ? { "x-ezlogs": "1", "x-ezlogs-correlation": id } : { "x-ezlogs": "1" } });
    const SERVER_ID = `ezl_${Date.now()}_5e5e5e5e`;

    it("puts the click's id on its server function calls and reports a write with the id the server used", async () => {
      let sent: string | null = null;
      const fake = await setup(async (url, init) => {
        if (url === ENDPOINT) return new Response(null, { status: 202 });
        sent = header(init, "x-correlation-id");
        return wrapped(sent);
      });
      fake.fire("click");
      await fake.w.fetch("/_serverFn/89b33048", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(sent).toMatch(/^ezl_/);
      await flush();
      expect(fake.reports()).toEqual([{ kind: "server_call", method: "POST", path: "/_serverFn", status: 200, correlation_id: sent,
                                         session_id: SESSION, at: expect.any(String) }]);
    });

    it("reports nothing for a read, an unwrapped server, a call outside a click, or without a known person", async () => {
      const fake = await setup(async (url) => (url === ENDPOINT ? new Response(null, { status: 202 }) :
                                               url.includes("plain") ? new Response(null) : wrapped(SERVER_ID)));
      fake.fire("click");
      await fake.w.fetch("/_serverFn/89b33048", { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } });
      await fake.w.fetch("/_serverFn/plain", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
      vi.advanceTimersByTime(3_000);
      await fake.w.fetch("/_serverFn/89b33048", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
      fake.fire("click");
      await fake.w.fetch("/_serverFn/89b33048", { method: "POST" });
      await flush();
      expect(fake.reports()).toEqual([]);
      expect(header(fake.appCalls("/_serverFn/plain")[0]!.init, "x-correlation-id")).toMatch(/^ezl_/); // same origin: stamped
    });

    it("never sends an Edge Function a header, and reports its write with the id the function answered", async () => {
      const fn = `${SUPABASE}/functions/v1/send-invoice`;
      const fake = await setup(async (url) => (url === ENDPOINT ? new Response(null, { status: 202 }) : url === fn ? wrapped(SERVER_ID) : json(200, {})));
      fake.fire("click");
      await fake.w.fetch(fn, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toBeNull();
      await flush();
      expect(fake.reports()).toEqual([{ kind: "server_call", method: "POST", path: "/functions/v1/send-invoice", status: 200,
                                         correlation_id: SERVER_ID, session_id: SESSION, at: expect.any(String) }]);
    });

    it("ignores an answered id that is not EZLogs' own", async () => {
      const fake = await setup(async (url) => (url === ENDPOINT ? new Response(null, { status: 202 }) : wrapped("someone-elses-id")));
      fake.fire("click");
      await fake.w.fetch("/_serverFn/89b33048", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
      await flush();
      expect(fake.reports()).toEqual([]);
    });
  });

  it("asks once, with the app's own key, whether Supabase accepts the header, then stamps one id per click", async () => {
    const fake = await setup(async (url) => settingsOk(url) ?? json(201, {}));
    expect(fake.appCalls(SETTINGS)).toHaveLength(0); // nothing before the app's first call
    fake.fire("click");
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST", headers: { apikey: "anon" } });
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toBeNull(); // not before the answer
    await settle();
    const probe = fake.appCalls(SETTINGS);
    expect(probe).toHaveLength(1);
    expect(header(probe[0]!.init, "apikey")).toBe("anon");

    fake.fire("click");
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST", headers: { apikey: "anon" } });
    await fake.w.fetch(`${SUPABASE}/storage/v1/object/files/a.png`, { method: "POST", headers: new Headers({ apikey: "anon" }) });
    await fake.w.fetch(`${SUPABASE}/auth/v1/user`, { method: "PUT", headers: [["apikey", "anon"]] });
    await fake.w.fetch(`${SUPABASE}/functions/v1/send-invite`, { method: "POST" });
    const ids = fake.calls.slice(-4).map((c) => header(c.init, "x-correlation-id"));
    expect(ids[0]).toMatch(/^ezl_\d{13}_[0-9a-f]{8}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).toBeNull(); // Edge Functions set their own CORS: never stamped
    expect(fake.calls.slice(-4, -1).map((c) => header(c.init, "apikey"))).toEqual(["anon", "anon", "anon"]); // the app's headers kept
    expect(fake.appCalls(SETTINGS)).toHaveLength(1); // asked once

    vi.advanceTimersByTime(2_500);
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toBeNull(); // the click is over
  });

  it("gives a failure the id of its click, the one the click's other Supabase calls carried", async () => {
    const fake = await setup(async (url) => settingsOk(url) ?? (url.includes("tasks") ? json(201, {}) : json(409, { code: "23505" })));
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    fake.fire("click");
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    await fake.w.fetch(`${SUPABASE}/rest/v1/tags`, { method: "POST" });
    await flush();
    const stamped = header(fake.appCalls(`${SUPABASE}/rest/v1/tasks`)[0]!.init, "x-correlation-id");
    expect(stamped).toMatch(/^ezl_/);
    expect(fake.reports().at(-1)).toMatchObject({ path: "/rest/v1/tags", correlation_id: stamped });
  });

  it("stamps at most 10 calls of one click", async () => {
    const fake = await setup(async (url) => settingsOk(url) ?? json(201, {}));
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    fake.fire("click");
    for (let i = 0; i < 12; i++) await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    const stamped = fake.calls.slice(-12).filter((c) => header(c.init, "x-correlation-id"));
    expect(stamped).toHaveLength(10);
  });

  it("keeps a click's id for its chain of calls (save, then reload), and counts only writes", async () => {
    let finish: (r: Response) => void = () => undefined;
    const fake = await setup(async (url, init) => {
      if (settingsOk(url)) return settingsOk(url)!;
      if (url.endsWith("/slow")) return new Promise<Response>((r) => { finish = r; });
      return json(init?.method === "GET" || !init?.method ? 200 : 201, {});
    });
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    fake.fire("click");
    const slow = fake.w.fetch(`${SUPABASE}/rest/v1/slow`, { method: "POST" });
    vi.advanceTimersByTime(3_000); // the save takes 3 seconds
    finish(json(201, {}));
    await slow;
    await settle();
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "GET" }); // the reload right after
    const id = header(fake.appCalls(`${SUPABASE}/rest/v1/slow`)[0]!.init, "x-correlation-id");
    expect(id).toMatch(/^ezl_/);
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toBe(id);

    fake.fire("click");
    for (let i = 0; i < 12; i++) await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "GET" });
    for (let i = 0; i < 12; i++) await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    const stamped = fake.calls.slice(-24).map((c) => Boolean(header(c.init, "x-correlation-id")));
    expect(stamped.slice(0, 12).every(Boolean)).toBe(true); // reads: all stamped, none counted
    expect(stamped.slice(12).filter(Boolean)).toHaveLength(10);
  });

  it("never keeps a click's id past 30 seconds, even while one of its calls never answers", async () => {
    const fake = await setup(async (url) => settingsOk(url) ?? (url.endsWith("/hang") ? new Promise<Response>(() => undefined) : json(201, {})));
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    fake.fire("click");
    void fake.w.fetch(`${SUPABASE}/rest/v1/hang`, { method: "POST" });
    vi.advanceTimersByTime(10_000);
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toMatch(/^ezl_/); // still in flight: same click
    vi.advanceTimersByTime(21_000);
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toBeNull();
  });

  it("asks again later when the header check got no answer at all, at most 3 times", async () => {
    let attempts = 0;
    const fake = await setup(async (url) => {
      if (url === SETTINGS) { attempts += 1; if (attempts < 2) throw new TypeError("offline"); return json(200, {}); }
      return json(201, {});
    });
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    expect(attempts).toBe(1); // not again at once
    vi.advanceTimersByTime(11_000);
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    expect(attempts).toBe(2);
    fake.fire("click");
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toMatch(/^ezl_/);
  });

  it("reports the same failure once per click, even within 10 seconds", async () => {
    const fake = await setup(async (url) => settingsOk(url) ?? (url === ENDPOINT ? new Response(null, { status: 202 }) : json(409, { code: "23505" })));
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    for (let click = 0; click < 2; click++) {
      fake.fire("click");
      for (let i = 0; i < 3; i++) await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
      vi.advanceTimersByTime(2_500);
    }
    await flush();
    const tasks = fake.reports().filter((r: { path: string }) => r.path === "/rest/v1/tasks");
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((r: { correlation_id: string }) => r.correlation_id)).size).toBe(2);
  });

  it("never adds the header when Supabase refused it, and never retries the app's call", async () => {
    const fake = await setup(async (url) => {
      if (url === SETTINGS) throw new TypeError("CORS");
      return json(201, {});
    });
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    fake.fire("click");
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toBeNull();
    expect(fake.appCalls(`${SUPABASE}/rest/v1/tasks`)).toHaveLength(1);
  });

  it("leaves Request and URL inputs and unusual headers or init objects exactly as the app passed them", async () => {
    const fake = await setup(async (url) => settingsOk(url) ?? json(201, {}));
    await fake.w.fetch(`${SUPABASE}/rest/v1/x`, { headers: { apikey: "anon" } });
    await settle();
    fake.fire("click");
    const request = new Request(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    await fake.w.fetch(request);
    expect(fake.calls.at(-1)!.input).toBe(request);
    expect(fake.calls.at(-1)!.init).toBeUndefined();
    const url = new URL(`${SUPABASE}/rest/v1/tasks`);
    await fake.w.fetch(url, { method: "POST" });
    expect(fake.calls.at(-1)!.input).toBe(url);
    function* once() { yield ["apikey", "anon"] as [string, string]; }
    const oneShot = { method: "POST", headers: once() as unknown as HeadersInit };
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, oneShot);
    expect(fake.calls.at(-1)!.init).toBe(oneShot); // never read or copied: the app's iterator is intact
    class Init { method = "POST"; }
    const custom = new Init();
    await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, custom);
    expect(fake.calls.at(-1)!.init).toBe(custom);
  });

  it("reports a retry that fails with different statuses of one class once, but a different class again", async () => {
    let n = 0;
    const fake = await setup(async (url) => (url === ENDPOINT ? new Response(null, { status: 202 }) : ++n % 2 ? json(500, { message: "a" }) : json(502, { message: "b" })));
    for (let i = 0; i < 4; i++) await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    await flush();
    expect(fake.reports()).toHaveLength(1);
    const down = await setup(async (url) => (url === ENDPOINT ? new Response(null, { status: 202 }) : json(409, { code: "23505" })));
    await down.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    await down.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    await flush();
    expect(down.reports()).toHaveLength(1);
  });

  it("sends a retry loop once and at most 20 reports a minute", async () => {
    const fake = await setup(async (url) => (url === ENDPOINT ? new Response(null, { status: 202 }) : json(500, { message: "boom" })));
    for (let i = 0; i < 5; i++) await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
    await flush();
    expect(fake.reports()).toHaveLength(1);
    for (let i = 0; i < 30; i++) await fake.w.fetch(`${SUPABASE}/rest/v1/table_${i}`, { method: "POST" });
    for (let i = 0; i < 5; i++) await flush();
    expect(fake.reports()).toHaveLength(20);
  });

  it("sends what waits when the page is hidden", async () => {
    const fake = await setup(async (url) => (url === ENDPOINT ? new Response(null, { status: 202 }) : json(500, { message: "x".repeat(300) })));
    for (let i = 0; i < 12; i++) await fake.w.fetch(`${SUPABASE}/rest/v1/table_${i}`, { method: "POST" });
    await settle();
    fake.doc.visibilityState = "hidden";
    fake.fire("visibilitychange");
    await settle();
    expect(fake.reports()).toHaveLength(12);
  });

  it("keeps the app working when EZLogs is down, slow or answers garbage", async () => {
    for (const ezlogs of [() => Promise.reject(new TypeError("down")), () => new Promise<Response>(() => undefined),
                          async () => new Response("<html>", { status: 500 })]) {
      delete (globalThis as { window?: unknown }).window;
      const fake = await setup(async (url) => (url === ENDPOINT ? ezlogs() : json(500, { message: "boom" })));
      const response = await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { method: "POST" });
      expect(response.status).toBe(500);
      await flush();
      const again = await fake.w.fetch(`${SUPABASE}/rest/v1/orders`, { method: "POST" });
      expect(again.status).toBe(500);
    }
  });

  it("does nothing on the server, with a wrong key, or when started twice", async () => {
    const { init } = await load();
    expect(() => init({ key: "ezlpub_x", supabaseUrl: SUPABASE })).not.toThrow(); // no window
    const fake = fakeWindow(async () => new Response(null, { status: 200 }));
    (globalThis as { window?: unknown }).window = fake.w;
    const original = fake.w.fetch;
    init({ key: "ezl_full_key", supabaseUrl: SUPABASE });
    expect(fake.w.fetch).toBe(original);
    init({ key: "ezlpub_x", supabaseUrl: "not a url" });
    expect(fake.w.fetch).toBe(original);
    init({ key: "ezlpub_x", supabaseUrl: SUPABASE });
    const patched = fake.w.fetch;
    init({ key: "ezlpub_x", supabaseUrl: SUPABASE });
    expect(fake.w.fetch).toBe(patched);
  });
  describe("page views (pages)", () => {
    const PAGES = ["/", "/board", "/tasks", "/tasks/:id", "/tasks/new", "/files/*", "/u/$name", "not a route", "/a/Bad Word"];
    const ok = async (url: string) => settingsOk(url) ?? json(200, []);
    const read = (fake: ReturnType<typeof fakeWindow>, table: string) =>
      fake.w.fetch(`${SUPABASE}/rest/v1/${table}?select=*&id=eq.42`, { headers: { Authorization: `Bearer ${TOKEN}`, apikey: "anon" } });
    const views = (fake: ReturnType<typeof fakeWindow>) => fake.reports().filter((r: { kind: string }) => r.kind === "page_view");
    async function wait(ms: number) {
      await settle();
      vi.advanceTimersByTime(ms);
      await settle();
    }

    it("records nothing about pages without a route list, and leaves history alone", async () => {
      const fake = await setup(ok);
      const push = fake.w.history.pushState;
      await read(fake, "tasks");
      await wait(6_000);
      expect(views(fake)).toEqual([]);
      expect(fake.w.history.pushState).toBe(push);
    });

    it("records the page a signed-in person opened, by its route, with the tables it read first", async () => {
      const fake = await setup(ok, { pages: PAGES });
      await read(fake, "tasks");
      await read(fake, "profiles");
      await read(fake, "tasks");
      await wait(6_000); // the first 5 s close the view; the queue sends a second later
      await wait(1_100);
      const [v] = views(fake);
      expect(v).toEqual({ kind: "page_view", page: "/board", tables: ["tasks", "profiles"], correlation_id: expect.stringMatching(/^ezl_\d{13}_[0-9a-f]{8}$/),
                          session_id: SESSION, at: expect.any(String) });
      await read(fake, "late_table"); // after the first 5 s: not the page's
      await wait(10_000);
      expect(views(fake)).toHaveLength(1);
    });

    it("names a page only by the route list: an address it doesn't list is just a page", async () => {
      const fake = await setup(ok, { pages: PAGES });
      await read(fake, "tasks");
      for (const path of ["/tasks/42", "/tasks/new", "/u/charles", "/u/charles/settings", "/files/a/b.pdf", "/Bad Word"]) {
        fake.w.history.pushState({}, "", path);
        await read(fake, "tasks");
      }
      await wait(6_000);
      await wait(1_100);
      expect(views(fake).map((v: { page: string | null }) => v.page)).toEqual(["/board", "/tasks/42", "/tasks/new", "/u/:id", null, "/files/*", null]);
      const sent = views(fake).map((v: { page: string | null; tables: string[] }) => [v.page, v.tables]);
      expect(JSON.stringify(sent)).not.toMatch(/charles|pdf|Bad/);
      expect(JSON.stringify(fake.reports())).not.toMatch(/charles|b\.pdf|Bad Word/);
    });

    it("counts the same page once (a filter or a replaceState), and a route change through popstate", async () => {
      const fake = await setup(ok, { pages: PAGES });
      await read(fake, "tasks");
      fake.w.history.replaceState({}, "", "/board?filter=mine");
      fake.w.history.pushState({}, "", "/tasks");
      fake.w.location.pathname = "/board";
      fake.fire("popstate");
      await wait(6_000);
      await wait(1_100);
      expect(views(fake).map((v: { page: string }) => v.page)).toEqual(["/board", "/tasks", "/board"]);
    });

    it("never records a person who isn't signed in, and stops at a sign-out", async () => {
      const fake = await setup(ok, { pages: PAGES });
      await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { headers: { apikey: "anon" } }); // no login
      await wait(6_000);
      await wait(1_100);
      expect(views(fake)).toEqual([]);

      fake.w.history.pushState({}, "", "/tasks");
      await read(fake, "tasks");
      await fake.w.fetch(`${SUPABASE}/auth/v1/logout`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, apikey: "anon" } });
      fake.w.history.pushState({}, "", "/");
      await wait(6_000);
      await wait(1_100);
      expect(views(fake).map((v: { page: string }) => v.page)).toEqual(["/tasks"]);
    });

    it("joins the click that opened the page, and sends what waits when the page is hidden", async () => {
      const fake = await setup(ok, { pages: PAGES });
      await read(fake, "tasks");
      fake.fire("click");
      fake.w.history.pushState({}, "", "/tasks/7");
      await read(fake, "tasks");
      fake.doc.visibilityState = "hidden";
      fake.fire("visibilitychange");
      await settle();
      const [first, second] = views(fake);
      expect(second.page).toBe("/tasks/7");
      expect(second.correlation_id).not.toBe(first.correlation_id);
    });

    it("names the record only where the route calls it an id and the value is a database id", async () => {
      const uuid = "b38a12a9-4d9b-4d83-bda0-b3e19c03a236";
      const ulid = "01HV9ZQK3M8X5T2N7B4C6D1E0F";
      const fake = await setup(ok, { pages: ["/tasks/$taskId", "/projects/:project_id/tasks/:id", "/u/$name", "/call/:phone",
                                              "/blog/[slug]", "/files/[id]", "/orders/:uuid"] });
      await read(fake, "tasks");
      const paths = [`/tasks/${uuid}`, "/tasks/my-first-task", `/projects/12/tasks/${uuid}`, "/u/123", "/call/0721234567",
                     "/blog/how-we-work", `/files/${ulid}`, "/orders/not-an-id", `/tasks/${uuid.toUpperCase()}`];
      for (const path of paths) {
        fake.w.history.pushState({}, "", path);
        await read(fake, "tasks");
      }
      await wait(6_000);
      await wait(1_100);
      expect(views(fake).map((v: { page: string }) => v.page).slice(1)).toEqual([
        `/tasks/${uuid}`, "/tasks/:id", `/projects/12/tasks/${uuid}`, "/u/:id", "/call/:id", "/blog/:id", `/files/${ulid}`,
        "/orders/:id", `/tasks/${uuid.toUpperCase()}`,
      ]);
      expect(JSON.stringify(fake.reports())).not.toMatch(/my-first-task|0721234567|how-we-work|not-an-id/);
    });

    it("counts another record on the same route as another page", async () => {
      const fake = await setup(ok, { pages: ["/tasks/:id"] });
      fake.w.history.pushState({}, "", "/tasks/1");
      await read(fake, "tasks");
      fake.w.history.pushState({}, "", "/tasks/2");
      await read(fake, "tasks");
      fake.w.history.replaceState({}, "", "/tasks/2?tab=comments");
      await wait(6_000);
      await wait(1_100);
      expect(views(fake).map((v: { page: string }) => v.page)).toEqual(["/tasks/1", "/tasks/2"]);
    });

    it("counts the same page once even after its first 5 seconds", async () => {
      const fake = await setup(ok, { pages: PAGES });
      await read(fake, "tasks");
      await wait(6_000);
      fake.w.history.replaceState({}, "", "/board?sort=new");
      fake.w.history.pushState({}, "", "/board");
      await wait(6_000);
      await wait(1_100);
      expect(views(fake)).toHaveLength(1);
    });

    it("picks the most specific route: a word over a parameter over a catch-all, an exact route over a catch-all", async () => {
      const fake = await setup(ok, { pages: ["/*", "/tasks/*", "/tasks/:id", "/tasks/new", "/"] });
      await read(fake, "tasks");
      for (const path of ["/", "/tasks/7", "/tasks/new", "/tasks/7/edit", "/other"]) {
        fake.w.history.pushState({}, "", path);
        await read(fake, "tasks");
      }
      await wait(6_000);
      await wait(1_100);
      expect(views(fake).map((v: { page: string }) => v.page)).toEqual(["/*", "/", "/tasks/7", "/tasks/new", "/tasks/*", "/*"]);
    });

    it("stops naming a person whose sign-out was refused or whose login is gone", async () => {
      const fake = await setup(async (url) => settingsOk(url) ?? (url.endsWith("/logout") ? json(401, {}) : json(200, [])), { pages: PAGES });
      await read(fake, "tasks");
      await fake.w.fetch(`${SUPABASE}/auth/v1/logout`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
      fake.w.history.pushState({}, "", "/tasks");
      await fake.w.fetch(`${SUPABASE}/rest/v1/tasks`, { headers: { apikey: "anon" } }); // signed out now
      fake.w.history.pushState({}, "", "/settings");
      await wait(6_000);
      await wait(1_100);
      expect(views(fake).map((v: { page: string }) => v.page)).toEqual(["/board"]);
    });

    it("reads a hash router's path, and leaves the app's history calls exactly as they were", async () => {
      const fake = await setup(ok, { pages: PAGES });
      await read(fake, "tasks");
      fake.w.location.hash = "#/tasks/9?tab=x";
      fake.fire("hashchange");
      await read(fake, "tasks");
      const wrapped = fake.w.history.pushState;
      const { init } = await import("../src/index"); // a second init changes nothing
      init({ key: "ezlpub_test", supabaseUrl: SUPABASE, endpoint: ENDPOINT, pages: PAGES });
      expect(fake.w.history.pushState).toBe(wrapped);
      expect(() => fake.w.history.pushState({}, "", "/boom")).toThrow("the app's own error");
      expect(fake.w.history.pushState({}, "", "/tasks/9")).toBe("kept");
      await wait(6_000);
      await wait(1_100);
      expect(views(fake).map((v: { page: string }) => v.page)).toEqual(["/board", "/tasks/9"]);
    });

    it("ignores a route list that isn't one, and odd routes in it", async () => {
      const fake = await setup(ok, { pages: "/tasks" as unknown as string[] });
      const push = fake.w.history.pushState;
      await read(fake, "tasks");
      await wait(7_000);
      expect(views(fake)).toEqual([]);
      expect(fake.w.history.pushState).toBe(push);
    });

    it("sends at most 30 page views a minute, apart from failures", async () => {
      const fake = await setup(async (url) => settingsOk(url) ?? (url.includes("/boom") ? json(500, {}) : json(200, [])), { pages: PAGES });
      await read(fake, "tasks");
      for (let i = 0; i < 40; i++) fake.w.history.pushState({}, "", i % 2 ? "/tasks" : "/board");
      await fake.w.fetch(`${SUPABASE}/rest/v1/boom`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
      for (let i = 0; i < 6; i++) await wait(1_100);
      expect(views(fake)).toHaveLength(30);
      expect(fake.reports().filter((r: { kind: string }) => r.kind === "failure")).toHaveLength(1);
    });
  });
});

describe("groupClicks (any stack: one click, one action)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  async function grouped() {
    const fake = fakeWindow(async () => new Response(null, { status: 200 }));
    class FakeXhr {
      headers: Record<string, string> = {};
      listeners: Record<string, () => void> = {};
      open(_m: string, _u: string) { /* recorded by the module */ }
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
      send() { this.listeners.loadend?.(); }
    }
    (fake.w as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
    (globalThis as { window?: unknown }).window = fake.w;
    const { groupClicks } = await load();
    groupClicks();
    return { fake, FakeXhr };
  }

  it("puts one id on a click's own-server requests, fetch and XHR, and nothing outside a click", async () => {
    const { fake, FakeXhr } = await grouped();
    await fake.w.fetch("/orders", { method: "POST" });
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toBeNull();
    fake.fire("submit");
    await fake.w.fetch("/orders", { method: "POST" });
    await fake.w.fetch("https://app.example.com/orders/7", { method: "GET" });
    const xhr = new FakeXhr();
    xhr.open("PATCH", "/orders/7");
    xhr.send();
    const ids = fake.calls.slice(-2).map((c) => header(c.init, "x-correlation-id"));
    expect(ids[0]).toMatch(/^ezl_\d{13}_[0-9a-f]{8}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(xhr.headers["x-correlation-id"]).toBe(ids[0]);
  });

  it("never adds it to another site's request, and sends nothing anywhere", async () => {
    const { fake } = await grouped();
    fake.fire("click");
    await fake.w.fetch("https://api.stripe.com/v1/charges", { method: "POST" });
    expect(header(fake.calls.at(-1)!.init, "x-correlation-id")).toBeNull();
    expect(fake.calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/charges"]);
  });

  it("starts a new id for the next click", async () => {
    const { fake } = await grouped();
    fake.fire("click");
    await fake.w.fetch("/a", { method: "POST" });
    vi.advanceTimersByTime(4_000);
    fake.fire("click");
    await fake.w.fetch("/b", { method: "POST" });
    const [a, b] = fake.calls.map((c) => header(c.init, "x-correlation-id"));
    expect(a).not.toBe(b);
  });
});
