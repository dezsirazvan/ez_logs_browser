/**
 * @ezlogs/browser: tells EZLogs when a call from your app to its Supabase backend fails, so your
 * activity log shows "Task creation failed (it already exists)" or "Sign-in failed (wrong email or
 * password)" next to everything your database records.
 *
 *   // src/ezlogs.ts, imported on the first line of the file that loads first in the browser
 *   import { init } from "@ezlogs/browser";
 *   init({ key: "ezlpub_…", supabaseUrl: import.meta.env.VITE_SUPABASE_URL });
 *
 * What it sends, for a call to your Supabase project (database, files, accounts, functions) or to
 * your app's own server functions (`/_serverFn/…`) that failed (status 400 or more, or no answer;
 * a call your app cancelled is not a failure), and for a successful sign-out: the method, the
 * table, function or bucket the call was for, the status, Supabase's error code, the time, the
 * click's id (below) and the Supabase session id. Nothing else.
 *
 * Who it was: the session id is the `session_id` field inside the call's own login token, read
 * here; the token itself never leaves. A session id is not a credential (nothing can be opened
 * with it), and EZLogs names the person only when your database recorded that session.
 *
 * What it never sends: login tokens or any other credential, emails, passwords, error messages,
 * request or response bodies, query strings, file names. It never reads a request body.
 *
 * One click, one action: in the two seconds after a click, a form submit or Enter, it adds one
 * `x-correlation-id` header to your app's Supabase calls, so EZLogs groups that click's changes and
 * failures. Only after one request to your project's public settings endpoint (with your app's own
 * public API key, sent only to your own project) proved your Supabase accepts that header, so an
 * app call is never sent with a header it would refuse.
 *
 * It never throws, never changes or retries your app's calls, and does nothing on the server. If
 * EZLogs is down, slow or blocked, your app works exactly the same.
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
  correlation_id?: string;
  session_id?: string;
  at: string;
}

interface Call {
  method: string;
  path: string;
  supabase: boolean;
  sessionId?: string;
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
const STATE = Symbol.for("ezlogs.browser");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // once, of the project's public settings endpoint (answers 200), with the app's own public key.
  const askOnce = (apikey: string) => {
    probe = "asking";
    send(`${supabaseOrigin}/auth/v1/settings`, { method: "GET", headers: { apikey, "x-correlation-id": correlationId() } })
      .then((r) => { probe = r.ok ? "yes" : "no"; }, () => { probe = "no"; });
  };

  const flush = (all = false) => {
    timer = undefined;
    for (let posts = 0; queue.length > 0 && posts < (all ? 3 : 1); posts++) {
      const reports = queue.splice(0, 10);
      const body = JSON.stringify({ key, reports });
      if (body.length > MAX_BODY_BYTES) continue; // cannot happen with these fields; never send more
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
      if (call?.supabase && probe === "waiting") {
        const apikey = headersOf(input, init)?.get("apikey");
        if (apikey && apikey.length <= 2_000) askOnce(apikey);
      }
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
            report(failure(c, 0, undefined));
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

// The call's headers, read without consuming them (undefined for anything unusual). Used for two
// things only: the app's public `apikey`, for the one CORS check above to the app's own project,
// and the session id inside the login token. Neither the key nor the token is ever sent to EZLogs.
function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers | undefined {
  if (!plain(init)) return undefined;
  return new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined));
}

// The `session_id` field of the call's login token (decoded here, never sent): Supabase's random
// id for this sign-in, which EZLogs matches with the session your database recorded.
function sessionIdOf(headers: Headers | undefined): string | undefined {
  const payload = headers?.get("authorization")?.match(/^Bearer\s+[\w-]+\.([\w-]+)\.[\w-]*$/)?.[1];
  if (!payload || payload.length > 8_000) return undefined;
  try {
    const sid = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))?.session_id;
    return typeof sid === "string" && UUID.test(sid) ? sid.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
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
  const sessionId = supabase ? sessionIdOf(headersOf(input, init)) : undefined;
  if (sessionId) call.sessionId = sessionId;
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
    if (call.sessionId) report({ ...failure(call, response.status, undefined), kind: "sign_out" });
    return;
  }
  if (response.status < 400) return;
  if (!call.supabase) {
    report(failure(call, response.status, undefined));
    return;
  }
  // Supabase's error code only ("23505", "invalid_credentials"): never its message, which can quote
  // what was typed.
  response.clone().text().then((text) => {
    let code: string | undefined;
    try {
      const body = JSON.parse(text.slice(0, 4_000));
      code = [body?.error_code, body?.code].find((v) => typeof v === "string");
    } catch {
      // not JSON: status only
    }
    // `.single()` finding no row is how many apps ask "does it exist?", not a failure.
    if (response.status === 406 && code === "PGRST116") return;
    report(failure(call, response.status, code));
  }).catch(() => report(failure(call, response.status, undefined)));
}

function failure(call: Call, status: number, code: string | undefined): Report {
  const safeCode = code && /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : undefined;
  return { kind: "failure", method: call.method, path: call.path, status, code: safeCode, correlation_id: call.correlationId,
           session_id: call.sessionId, at: new Date().toISOString() };
}

function correlationId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `ezl_${Date.now()}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
