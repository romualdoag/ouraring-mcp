# Privacy Policy — Ouraring-MCP

Effective: 2026-10-22 · Contact: romualdoag@gmail.com

**Ouraring-MCP** ("the app") is a personal, single-user, non-commercial
Model Context Protocol (MCP) server that lets its owner read **their own**
Oura Ring data through an AI assistant in natural language
(sleep, readiness, activity, heart rate, SpO2, stress, workouts, sessions,
tags, ring configuration).

## Data we access

Only via the official Oura API v2, and only after **you** (the single user)
authorize it — with a Personal Access Token or your own OAuth2 client:

- Profile: email, age, weight, height (`email`, `personal` scopes)
- Daily summaries: sleep, readiness, activity, stress, SpO2, resilience,
  cardiovascular age (`daily`, `spo2`, `stress`, `heart_health` scopes)
- Detailed records: sleep sessions, workouts, guided/unguided sessions,
  tags, heart-rate samples, sleep timing, rest mode
  (`heartrate`, `workout`, `session`, `tag` scopes)
- Ring info: configuration, battery (`ring_configuration` scope)

We do **not** access anything outside the scopes you approved, and we never
access anyone else's data — there is exactly one user: the token holder.

## How data is handled

- **Fetched on demand.** When you ask a question, the server calls the Oura
  API live over HTTPS and returns the result to your assistant.
- **Cached locally, on your machine only.** Repeat queries reuse a local
  SQLite file (`./oura-cache.sqlite`, never committed, never uploaded) so
  the server doesn't re-hit Oura every time. No logs of health data, no
  backups. Delete the file any time to wipe the cache; set
  `OURARING_CACHE_ENABLED=0` to disable it entirely.
- **Not shared.** Data is never sold, never sent to advertisers or third
  parties, never used for tracking. The only network calls are to
  `api.ouraring.com` (Oura) at your request.
- **Local credentials.** Your token/client secret live only in your own
  `.env` file on your machine. Revoke any time from
  https://cloud.ouraring.com/personal-access-tokens (PAT) or your
  [OAuth applications page](https://cloud.ouraring.com/oauth/applications)
  — revoking instantly cuts off this app.

## Retention and deletion

Only the local cache file above is retained, on your machine. Delete the local
checkout/`.env`/cache file and revoke the token and every copy is gone. To ask
questions about this policy, email romualdoag@gmail.com.

## Security

All Oura traffic is HTTPS with bearer tokens sent as `Authorization` headers;
tokens are never logged, never committed (see `.gitignore`), and never
embedded in URLs. The server binds only to stdio — it opens no ports and
accepts no inbound connections (the one exception is the opt-in
`npm run auth:oura` helper, which briefly listens on
`http://localhost:8080/callback` during your own OAuth authorization and
then exits).

## Changes

Material changes to this policy will be committed to this file with a new
effective date before the app's behavior changes.
