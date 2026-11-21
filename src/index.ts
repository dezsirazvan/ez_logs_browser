/**
 * @ezlogs/browser: tells EZLogs when a call from your app to its Supabase backend fails, and
 * when someone signs out, so your activity log shows "Sign-in failed (wrong email or password)"
 * or "Task creation failed (it already exists)" next to everything your database records.
 *
 *   // src/ezlogs.ts, imported first in src/main.tsx (`import "./ezlogs";`)
 *   import { init } from "@ezlogs/browser";
 *   init({ key: "ezlpub_…", supabaseUrl: import.meta.env.VITE_SUPABASE_URL });
 *
 * Imported first, so it runs before your Supabase client is created: some supabase-js versions
 * keep the `fetch` they find at that moment.
 *
 * What it does:
 * - watches only your app's calls to Supabase (database, files, accounts, functions) and its
 *   own TanStack server functions (`/_serverFn/…`);
 * - reports a call that failed (status 400 or more, or no answer; a call your app cancelled is
 *   not a failure) and a successful sign-out: method, the table, function or bucket the call was
 *   for (never the rest of the path: no file names, no ids, no query string), status, Supabase's
 *   error code and message, the login token the call carried (EZLogs checks it against your own
 *   project and never stores it), and for a failed sign-in the email that was typed;
 * - puts one `x-correlation-id` on the Supabase calls of the two seconds after a click, so the
 *   click's changes show as one action. Only after a first request proved your Supabase accepts
 *   that header.
 *
 * What it never does: send request or response bodies, track clicks, page views or reads,
 * change what your app's calls return, or throw. If EZLogs is down, slow or blocked, your app
 * works exactly the same.
 */

export interface InitOptions {
  /** Your EZLogs browser key (`ezlpub_…`). Public by design: it can only send failure reports. */
  key: string;
  /** Your Supabase project URL, as your Supabase client uses it. */
  supabaseUrl: string;
  /** Where reports go. Only for tests. */
  endpoint?: string;
}

interface Report {
  kind: "failure" | "sign_out";
  method: string;
  path: string;
  status: number;
  code?: string;
  message?: string;
  correlation_id?: string;
  at: string;
  token?: string;
  email?: string;
}

interface Call {
  method: string;
  path: string;
  supabase: boolean;
  token?: string;
  apikey?: string;
  email?: string;
  correlationId?: string;
}

const DEFAULT_ENDPOINT = "https://app.ezlogs.io/api/ingest/browser";
const SUPABASE_AREAS = /^\/(rest|storage|auth|functions)\/v1(\/|$)/;
const STAMPED_AREAS = /^\/(rest|storage|auth)\/v1(\/|$)/; // Edge Functions set their own CORS
const SERVER_FUNCTION = /^\/_serverFn\//;
const STORAGE_PREFIXES = new Set(["public", "sign", "authenticated", "info", "list", "upload"]);
const GESTURE_MS = 2_000;
const GESTURE_CALLS = 10;
const REPEAT_MS = 10_000;
const PER_MINUTE = 20;
const MAX_BODY_BYTES = 15_000;
const MAX_TOKEN_CHARS = 8_000;
const STATE = Symbol.for("ezlogs.browser");

type Fetch = typeof fetch;

/** Starts reporting. Safe to call more than once and on the server (it does nothing there). */
export function init(options: InitOptions): void {
  try {
    const w = typeof window === "undefined" ? undefined : (window as Window & { [STATE]?: true });
    if (!w || typeof w.fetch !== "function" || w[STATE]) return;
    const key = String(options?.key ?? "");
    const supabase = new URL(String(options?.supabaseUrl ?? ""));
    if (!key.startsWith("ezlpub_") || !/^https?:$/.test(supabase.protocol)) return;
    w[STATE] = true;
    start(w, key, supabase.origin, options.endpoint || DEFAULT_ENDPOINT);
  } catch {
    // never break the app
  }
}

function start(w: Window, key: string, supabaseOrigin: string, endpoint: string): void {
  const original: Fetch = w.fetch;
  const send: Fetch = (...args) => original.apply(w, args);
  const queue: Report[] = [];
  const recent = new Map<string, number>();
  let sentThisMinute = 0;
  let minuteStart = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probe: "waiting" | "asking" | "yes" | "no" = "waiting";
  let gesture: { id: string; until: number; calls: number } | undefined;

  // One correlation id per click, submit or Enter, for the app's next few Supabase calls.
  const onGesture = (event: Event) => {
    try {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") return;
      gesture = { id: correlationId(), until: Date.now() + GESTURE_MS, calls: 0 };
    } catch {
      gesture = undefined;
    }
  };
  for (const type of ["click", "submit", "keydown"]) {
    try {
      w.document?.addEventListener(type, onGesture, { capture: true, passive: true });
    } catch {
      // no document: no gestures
    }
  }

  // Stamp only once a request proved this Supabase answers one carrying the header (its CORS
  // allows it), so an app call is never sent with it before that and none is ever lost. Asked
  // once, with the app's own public key from its first call, of an endpoint that answers 200.
  const askOnce = (apikey: string) => {
    probe = "asking";
    send(`${supabaseOrigin}/auth/v1/settings`, { method: "GET", headers: { apikey, "x-correlation-id": correlationId() } })
      .then((r) => { probe = r.ok ? "yes" : "no"; }, () => { probe = "no"; });
  };

  const flush = (all = false) => {
    timer = undefined;
    for (let posts = 0; queue.length > 0 && posts < (all ? 3 : 1); posts++) {
      const reports = queue.splice(0, 10);
      let body = JSON.stringify({ key, reports });
      while (body.length > MAX_BODY_BYTES && reports.length > 0) {
        reports.pop();
        body = JSON.stringify({ key, reports });
      }
      if (reports.length === 0) continue;
      send(endpoint, { method: "POST", body, keepalive: true, credentials: "omit", mode: "cors",
                       headers: { "Content-Type": "text/plain" } }).catch(() => undefined);
    }
    if (queue.length > 0) timer = setTimeout(flush, 1_000);
  };

  const report = (r: Report) => {
    const now = Date.now();
    const repeat = `${r.kind} ${r.method} ${r.path} ${r.status} ${r.code ?? ""}`;
    if ((recent.get(repeat) ?? 0) > now - REPEAT_MS) return; // a retry loop is one report
    recent.set(repeat, now);
    if (recent.size > 200) recent.clear();
    if (now - minuteStart > 60_000) { minuteStart = now; sentThisMinute = 0; }
    if (sentThisMinute >= PER_MINUTE) return;
    sentThisMinute += 1;
    queue.push(r);
    timer ??= setTimeout(flush, 1_000);
  };

  // Leaving or hiding the page (mobile browsers often never fire pagehide): send what waits.
  const leave = () => {
    try {
      if (timer) clearTimeout(timer);
      flush(true);
    } catch {
      // fine
    }
  };
  try {
    w.addEventListener("pagehide", leave);
    w.document?.addEventListener("visibilitychange", () => { if (w.document?.visibilityState === "hidden") leave(); });
  } catch {
    // fine without them
  }

  const watched: Fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let call: Call | undefined;
    let args: [RequestInfo | URL, RequestInit | undefined] = [input, init];
    try {
      call = describe(w, supabaseOrigin, input, init);
      if (call?.supabase && call.apikey && probe === "waiting") askOnce(call.apikey);
      const g = gesture && gesture.until > Date.now() && gesture.calls < GESTURE_CALLS ? gesture : undefined;
      if (call && g) {
        g.calls += 1;
        call.correlationId = g.id;
        if (probe === "yes" && call.supabase && STAMPED_AREAS.test(call.path) && typeof input === "string" && plain(init)) {
          const headers = new Headers(init?.headers);
          if (!headers.has("x-correlation-id")) headers.set("x-correlation-id", g.id);
          args = [input, { ...init, headers }];
        }
      }
    } catch {
      call = undefined;
      args = [input, init];
    }
    const result = original.apply(w, args);
    if (call) {
      const c = call;
      result.then(
        (response) => { try { onResponse(c, response, report); } catch { /* never break the app */ } },
        (error: unknown) => {
          try {
            // A call the app cancelled (navigation, unmount, abortSignal) is not a failure.
            if ((error as { name?: string })?.name === "AbortError" || init?.signal?.aborted) return;
            report(failure(c, 0, undefined, undefined));
          } catch {
            // never break the app
          }
        }
      );
    }
    return result;
  } as Fetch;
  w.fetch = watched;
}

// Headers and init objects the module may read and copy without consuming or losing anything:
// none, a plain object, an array or a Headers instance. Anything else is left untouched.
function plain(init?: RequestInit): boolean {
  if (init === undefined) return true;
  if (Object.getPrototypeOf(init) !== Object.prototype) return false;
  const h = init.headers;
  return h === undefined || Array.isArray(h) || h instanceof Headers || Object.getPrototypeOf(h) === Object.prototype;
}

function describe(w: Window, supabaseOrigin: string, input: RequestInfo | URL, init?: RequestInit): Call | undefined {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = new URL(href, w.location?.href);
  const supabase = url.origin === supabaseOrigin && SUPABASE_AREAS.test(url.pathname);
  const serverFunction = url.origin === w.location?.origin && SERVER_FUNCTION.test(url.pathname);
  if (!supabase && !serverFunction) return undefined;
  // A refresh of an expired session failing is the session ending, not something the person did.
  if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") return undefined;

  const method = (init?.method || (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
  const call: Call = { method, path: serverFunction ? "/_serverFn" : shortPath(url.pathname), supabase };
  if (!supabase || !plain(init)) return call; // never read headers we could consume
  const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined));
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && bearer.split(".").length === 3 && bearer.length <= MAX_TOKEN_CHARS) call.token = bearer;
  const apikey = headers.get("apikey");
  if (apikey && apikey.length <= 2_000) call.apikey = apikey; // only for the one CORS check, never sent to EZLogs
  if (url.pathname === "/auth/v1/token" && typeof init?.body === "string") {
    try {
      const email = JSON.parse(init.body)?.email;
      if (typeof email === "string" && email.length <= 200) call.email = email;
    } catch {
      // not JSON: no email
    }
  }
  return call;
}

// The part of a Supabase path that names the call: /rest/v1/<table>, /rest/v1/rpc/<fn>,
// /functions/v1/<fn>, /auth/v1/<endpoint>, /storage/v1/object/<bucket>. Never a file name or an id.
function shortPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "storage" && parts[2] === "object") {
    let rest = parts.slice(3);
    if (rest[0] && STORAGE_PREFIXES.has(rest[0])) rest = rest.slice(rest[0] === "upload" ? 2 : 1);
    return `/${["storage", "v1", "object", ...rest.slice(0, 1)].join("/")}`;
  }
  const keep = parts[0] === "rest" && parts[2] === "rpc" ? 4 : 3;
  return `/${parts.slice(0, keep).join("/")}`.slice(0, 200);
}

function onResponse(call: Call, response: Response, report: (r: Report) => void): void {
  if (call.path === "/auth/v1/logout" && response.ok) {
    report({ kind: "sign_out", method: call.method, path: call.path, status: response.status, at: new Date().toISOString(),
             correlation_id: call.correlationId, token: call.token });
    return;
  }
  if (response.status < 400) return;
  if (!call.supabase) {
    report(failure(call, response.status, undefined, undefined));
    return;
  }
  response.clone().text().then((text) => {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = JSON.parse(text.slice(0, 4_000));
      code = [body?.error_code, body?.code].find((v) => typeof v === "string");
      message = [body?.message, body?.msg, body?.error_description, body?.error].find((v) => typeof v === "string");
    } catch {
      // not JSON: status only
    }
    // `.single()` finding no row is how many apps ask "does it exist?", not a failure.
    if (response.status === 406 && code === "PGRST116") return;
    // Postgres data errors (class 22) quote the value that was typed: the code says enough.
    if (code?.startsWith("22")) message = undefined;
    report(failure(call, response.status, code, message));
  }).catch(() => report(failure(call, response.status, undefined, undefined)));
}

function failure(call: Call, status: number, code: string | undefined, message: string | undefined): Report {
  return {
    kind: "failure",
    method: call.method,
    path: call.path,
    status,
    code: code?.slice(0, 60),
    message: message?.slice(0, 300),
    correlation_id: call.correlationId,
    at: new Date().toISOString(),
    token: call.token,
    email: call.path === "/auth/v1/token" ? call.email : undefined
  };
}

function correlationId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `ezl_${Date.now()}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
