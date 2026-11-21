# Changelog

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
