# Changelog

## 0.4.0 (unreleased)

- **`groupClicks()`** for any app with an EZLogs agent on its server (Rails, Next.js): a click's
  requests to the app's own server (same origin, fetch and XMLHttpRequest) carry one
  `x-correlation-id`, so the agent groups them into one action. No key, sends nothing.
- With **@ezlogs/server** in the app's server code, the work a click makes the server do reads as
  that person's ("Ana archived 3 tasks", not "App server"). During a click, the click's id also goes
  on the app's own server function calls (same origin; never on an Edge Function, whose CORS could
  refuse it). For a click's write (POST, PUT, PATCH, DELETE; never a read) that the server answered
  as wrapped, the module reports the id the server's work used (`x-ezlogs-correlation`) with the
  method, path, status, time and session id: the same fields as a failure. EZLogs keeps it only once
  that work's changes are recorded.
- A failing server function call now carries the session of the login the call itself sends.
- One click stays one action through a chain of calls: a click's id lasts while the calls it
  started wait for an answer (and a second after each answer, so "save, then reload" stays
  together), at most 30 seconds. Only writes count toward the 10 calls a click may stamp.
- A call that is retried and fails differently each time (no answer, then a 500) is one report: the
  status counts by class (none, 4xx, 5xx) in the once-every-10-seconds check.
- The one check that your Supabase accepts the click header is asked again (after 10 and 20
  seconds) when it got no answer at all (offline, a blocked network); an answer still decides.
- The same failure on two different clicks is two reports; a retry loop within one click is
  still one.

## 0.3.1 (2026-11-21)

- Page views name the record a page shows. Where your route calls a part an id (`:id`, `$taskId`,
  `[post_id]`, `:uuid`) and its value is a database id (a UUID, a ULID or a number), that id is
  sent (`/tasks/b38a12a9-…`), so EZLogs reads "Ana viewed task 'Launch plan'". Any other part
  (`/u/$username`, `/blog/[slug]`, an id-named part holding a name) stays `:id`. A different
  record on the same route is a new page view.

## 0.3.0 (2026-11-21)

- Added: **page views**, only with the new `pages` option (your app's routes) and only while the
  app's owner has page views on in EZLogs. For a signed-in person: the page they opened as the
  matching route (`/tasks/:id`; an address no route matches is "a page"), and the tables it read in
  its first 5 seconds (names only). No query string, title or content; nothing for visitors who
  aren't signed in; nothing stored on the device. At most 30 a minute. Without `pages`, nothing
  changes from 0.2.0.

## 0.2.0 (2026-11-21)

Sends no credential and nothing typed. **Upgrade from 0.1.0.**

- Removed: the login token. 0.1.0 sent it so EZLogs could name the person; a live token is a
  credential, and no app should have to trust a third party with it. Now only the token's
  `session_id` field is sent (read in the browser; not a credential), and EZLogs names the person
  only when your database recorded that session (EZLogs database install 1.3.0).
- Removed: the email typed into a failed sign-in, and Supabase's error message (it can quote what
  was typed). Only Supabase's error code is sent.
- A sign-out is reported only with a session id.

## 0.1.0 (2026-11-21)

First release.

- Reports a failed call from your app to its Supabase backend (database, files, accounts,
  functions) or to its own server functions, and a successful sign-out, to EZLogs.
- Sends the method, path, status, Supabase's error code and message, the call's login token
  (checked by EZLogs against your own project, never stored) and, for a failed sign-in, the
  email that was typed. Never bodies, query strings or passwords.
- One `x-correlation-id` per click on your Supabase calls, once a first call proved your project
  accepts it, so one click shows as one action.
- Never throws, never changes or retries your app's calls; nothing on the server.
