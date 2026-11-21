# Changelog

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
