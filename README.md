# @ezlogs/browser

Tells [EZLogs](https://ezlogs.io) when a call from your app to its Supabase backend fails, and when
someone signs out. Your EZLogs activity log then shows what failed for whom, next to every change
your database records:

- "Sign-in failed (wrong email or password)"
- "Task creation failed (it already exists)"
- "Attachment upload failed (the file is too large)"

It works with any app on Supabase, including apps built with Lovable, Bolt and v0. Use it together
with the EZLogs database install, which records what your app changed and who did it.

## What it sends, and what it never sends

| Sent, only for a call that failed or a sign-out | Never sent |
|---|---|
| the method (`POST`, `PATCH`, …) | login tokens or any other credential |
| the table, function or bucket the call was for | emails, passwords, names, ids |
| the status (`409`, or `0` when there was no answer) | error messages (they can quote what was typed) |
| Supabase's error code (`23505`, `invalid_credentials`) | request or response bodies, query strings, file names |
| the time, and the id of the click it belongs to | your Supabase API key |
| the Supabase session id (below) | |

It never reads a request body. Successful calls are not reported (except a sign-out), a call your
app cancelled (navigation, unmount, an abort signal) is not a failure, and a session refresh failing
and `.single()` finding no row are not reported either.

**Who it was.** Supabase puts a random `session_id` inside each login token. The module reads that
one field from the call's token, in the browser, and sends only it; the token never leaves. A
session id is not a credential: nothing can be signed in to or opened with it. The EZLogs database
install records each new session's id and user (`auth.sessions`: those two columns only), so EZLogs
names the person only when your own database recorded that session. Otherwise the failure shows as
"Someone", as does a failed sign-in (there is no session yet).

**One click, one action.** In the two seconds after a click, a form submit or Enter, it adds one
`x-correlation-id` header to your app's Supabase calls (at most 10, never to Edge Functions, which
set their own CORS rules), so EZLogs groups everything that click changed and what failed. It does
so only after one request to your project's public settings endpoint, with your app's own public
API key and to your own project only, proved your Supabase accepts that header.

## Install

```sh
npm install @ezlogs/browser
```

Put `init` in its own file, and import that file on the first line of the file that loads first in
the browser, so it runs before your Supabase client is created (some supabase-js versions keep the
`fetch` they find at that moment):

```ts
// src/ezlogs.ts
import { init } from "@ezlogs/browser";

init({ key: "ezlpub_…", supabaseUrl: import.meta.env.VITE_SUPABASE_URL });
```

| App | First line of |
|---|---|
| TanStack Start (Lovable's current template) | `src/routes/__root.tsx`: `import "../ezlogs";` |
| Vite with `src/main.tsx` | `src/main.tsx`: `import "./ezlogs";` |
| Next.js | a `"use client"` component rendered first in the root layout (use `process.env.NEXT_PUBLIC_SUPABASE_URL`) |

Your browser key is on the EZLogs install page. It is public by design (it sits in your app's
JavaScript): it can only send failure reports, never read anything.

## What it never does

- Track clicks, page views or reads.
- Change what your app's calls return, or retry them.
- Throw. If EZLogs is down, slow or blocked by an ad blocker, your app works exactly the same.
- Run on the server: `init` does nothing outside a browser.

A call that keeps failing in a retry loop is reported once every 10 seconds, and a page sends at
most 20 reports a minute.

## License

MIT
