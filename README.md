# @ezlogs/browser

Tells [EZLogs](https://ezlogs.io) when a call from your app to its Supabase backend fails, and when
someone signs out. Your EZLogs activity log then shows, next to every change your database records:

- "Sign-in failed: tried to sign in as 'ana@example.com' (wrong email or password)"
- "Task creation failed (it already exists)"
- "Attachment upload failed (the file is too large)"
- "Signed out"

It works with any app on Supabase, including apps built with Lovable, Bolt and v0. Use it together
with the EZLogs database install, which records what your app changed.

## Install

```sh
npm install @ezlogs/browser
```

Put `init` in its own file and import that file first in your entry file, so it runs before your
Supabase client is created (some supabase-js versions keep the `fetch` they find at that moment):

```ts
// src/ezlogs.ts
import { init } from "@ezlogs/browser";

init({ key: "ezlpub_…", supabaseUrl: import.meta.env.VITE_SUPABASE_URL });
```

```ts
// src/main.tsx: the first line
import "./ezlogs";
```

In a Next.js app use `process.env.NEXT_PUBLIC_SUPABASE_URL` and import it first in a client
component that wraps your app.

Your browser key is on the EZLogs install page. It is public by design (it sits in your app's
JavaScript): it can only send failure reports, never read anything.

## What it sends

For a call to your Supabase project (database, files, accounts, functions) or to your app's own
server functions (`/_serverFn/…`) that failed, or a successful sign-out:

| Sent | Never sent |
|---|---|
| method, and the table, function or bucket the call was for | the rest of the path: file names, ids, the query string |
| status, Supabase's error code and message (a message that quotes a typed value is left out) | request or response bodies, `details`, `hint` |
| the login token the call carried, so EZLogs can say who it was | passwords |
| for a failed sign-in, the email that was typed | your Supabase API key |

EZLogs checks the login token against your own Supabase project only and never stores it. A failure
without a valid login shows as "Someone".

It also puts one `x-correlation-id` header on your app's Supabase calls in the two seconds after a
click, a form submit or Enter (at most 10 calls), so everything one click changed shows as one
action. It does so only after one request to your project's public settings endpoint proved your
Supabase accepts that header, and never on Edge Functions, which set their own CORS rules.

## What it never does

- Track clicks, page views or reads.
- Report a call your app cancelled (navigation, unmount, an abort signal).
- Change what your app's calls return, or retry them.
- Throw. If EZLogs is down, slow or blocked by an ad blocker, your app works exactly the same.
- Run on the server: `init` does nothing outside a browser.

A call that keeps failing in a retry loop is reported once every 10 seconds, and a page sends at
most 20 reports a minute.

## License

MIT
