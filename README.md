# ouraring-mcp

MCP (Model Context Protocol) server that lets an AI assistant read **your own**
Oura Ring data — sleep, readiness, activity, heart rate, SpO2, stress,
workouts, sessions — so you can ask questions and get summaries in natural
language. Personal, single-user, non-commercial use. Data is fetched on demand
and not stored or shared.

Built for the Oura API v2 (`api.ouraring.com`), same stdio-MCP layout as
[`parksapi-mcp`](https://github.com/romualdoag/parksapi-mcp).

## Tools

| Tool | What it does | Oura scope(s) |
|---|---|---|
| `oura_status` | Credential check (no network) | — |
| `list_collections` | Every readable collection + required scope | — |
| `get_personal_info` | Profile (age, weight, height, email) | `personal`, `email` |
| `get_daily` | Daily summaries: `sleep`, `readiness`, `activity`, `stress`, `spo2`, `resilience`, `cardiovascular_age` | `daily` (+ `spo2`/`stress`/`heart_health`) |
| `get_collection` | Any collection: `sleep`, `sleep_time`, `workout`, `session`, `tag`, `enhanced_tag`, `heartrate`, `rest_mode_period`, `ring_configuration`, `ring_battery_level`, `vo2_max`, `daily_*`; single doc via `document_id` | per collection |
| `get_recent_summary` | Last N days (sleep + readiness + activity + stress) in one call | `daily` |

All tools return JSON as text and are read-only. Unknown collections/types
return `{ isError: true }` with a plain message, never a protocol error.
Date params are `YYYY-MM-DD`; heartrate also accepts ISO datetimes + `latest`.

## Requirements

Node 22+.

## Setup

```bash
npm install
npm run build
```

### OAuth2 (only method — Oura retired PATs Dec 2025)

Register at https://cloud.ouraring.com/oauth/applications with:

- **Redirect URI:** `http://localhost:8080/callback`
- **Scopes:** `email personal daily heartrate workout tag session spo2 ring_configuration stress heart_health`
- **Privacy / Terms:** this repo's `PRIVACY.md` / `TERMS.md`

Then:

```bash
npm run auth:oura       # prints the authorize URL
# open the URL, approve, copy ?code= from the localhost redirect, then:
npm run auth:oura -- --code=PASTE_CODE_HERE
```

`auth:oura` reads `OURARING_CLIENT_ID`/`OURARING_CLIENT_SECRET` from the
environment → local `.env` → `~/.hermes/.env`, then prints
`OURARING_ACCESS_TOKEN` (short-lived) + `OURARING_REFRESH_TOKEN` (long-lived).
The server auto-refreshes via the refresh token when client credentials are present — no manual refresh needed.

## Install in your tools

Build once (`npm install && npm run build`), then point any client at
`dist/index.js` via stdio with `OURARING_REFRESH_TOKEN` + `OURARING_CLIENT_ID` +
`OURARING_CLIENT_SECRET` in the environment (server auto-refreshes; access token alone expira rápido).
Replace `/path/to/ouraring-mcp` with your checkout below.

### Claude Code

```bash
claude mcp add ouraring \
  --env OURARING_REFRESH_TOKEN=... \
  --env OURARING_CLIENT_ID=... \
  --env OURARING_CLIENT_SECRET=... \
  -- node /path/to/ouraring-mcp/dist/index.js
```

Or per-project `.mcp.json` (user scope: `claude mcp add -s user ...`):

```json
{
  "mcpServers": {
    "ouraring": {
      "command": "node",
      "args": ["/path/to/ouraring-mcp/dist/index.js"],
      "env": {
        "OURARING_REFRESH_TOKEN": "...",
        "OURARING_CLIENT_ID": "...",
        "OURARING_CLIENT_SECRET": "..."
      }
    }
  }
}
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.ouraring]
command = "node"
args = ["/path/to/ouraring-mcp/dist/index.js"]

[mcp_servers.ouraring.env]
OURARING_REFRESH_TOKEN = "..."
OURARING_CLIENT_ID = "..."
OURARING_CLIENT_SECRET = "..."
```

### OpenCode

```bash
opencode mcp add ouraring \
  --env OURARING_REFRESH_TOKEN=... \
  --env OURARING_CLIENT_ID=... \
  --env OURARING_CLIENT_SECRET=... \
  -- node /path/to/ouraring-mcp/dist/index.js
```

Config-file equivalent (`opencode.jsonc`; v2 nests under `mcp.servers`,
older versions use flat `mcp`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "ouraring": {
        "type": "local",
        "command": ["node", "/path/to/ouraring-mcp/dist/index.js"],
        "environment": {
          "OURARING_REFRESH_TOKEN": "...",
          "OURARING_CLIENT_ID": "...",
          "OURARING_CLIENT_SECRET": "..."
        }
      }
    }
  }
}
```

### Hermes (`~/.hermes/config.yaml`)

```yaml
mcp_servers:
  ouraring:
    command: node
    args:
      - /home/hermes/github/ouraring-mcp/dist/index.js
    env:
      OURARING_REFRESH_TOKEN: "..."
      OURARING_CLIENT_ID: "..."
      OURARING_CLIENT_SECRET: "..."
    enabled: true
```

Then restart the gateway. Verify with `oura_status` (no network call).

### OpenClaw

```bash
openclaw mcp add ouraring \
  --cwd /path/to/ouraring-mcp \
  -- command node --arg /path/to/ouraring-mcp/dist/index.js
openclaw mcp doctor ouraring --probe
```

Set the tokens via Settings → MCP (scoped config editor → environment
values), or `OURARING_REFRESH_TOKEN` + client credentials in the gateway environment.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "ouraring": {
      "command": "node",
      "args": ["/path/to/ouraring-mcp/dist/index.js"],
      "env": {
        "OURARING_REFRESH_TOKEN": "...",
        "OURARING_CLIENT_ID": "...",
        "OURARING_CLIENT_SECRET": "..."
      }
    }
  }
}
```

## Examples

```json
{ "data_type": "sleep", "start_date": "2026-10-15", "end_date": "2026-10-22" }
{ "collection": "heartrate", "start_datetime": "2026-10-22T00:00:00Z", "latest": true }
{ "collection": "ring_battery_level", "start_datetime": "2026-10-21T00:00:00-04:00" }
{ "collection": "workout", "start_date": "2026-10-01", "end_date": "2026-10-22", "fields": "activity_type,calories" }
{ "collection": "VO2_Max", "start_date": "2026-09-22", "end_date": "2026-10-22" }
{ "days": 7 }
```

Notes (checked against Oura's OpenAPI spec):

- Collection names are case-insensitive, but the API path for VO₂max is
  case-sensitive upstream (`vO2_max`) — the server maps it automatically.
- `heartrate` and `ring_battery_level` query by ISO datetime + `latest`;
  `ring_configuration` takes no date params; everything else takes
  `start_date`/`end_date`. Single-doc fetch via `document_id` only where the
  API offers it (not for `enhanced_tag`/`heartrate`/`personal_info`/`ring_battery_level`).
- `fields` selects response fields on most routes (not `daily_resilience`,
  `enhanced_tag`, `tag`).
- Webhooks (`/v2/webhook/*`) are out of scope: they need a public HTTPS URL
  and write operations — this server is read-only by design.

## Privacy

See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md): on-demand reads only,
no storage, no sharing, single user. Revoke any time from your Oura dashboard.

## Develop

```bash
npm test   # build + vitest (offline unit, stdio protocol, opt-in live)
npm audit --audit-level=moderate   # fail on moderate+ advisories (dev + prod deps)
```

`tests/live.test.ts` calls the real API only when `OURARING_ACCESS_TOKEN` is set;
otherwise it passes with a skip note.

Every push is gated: `npm run setup:hooks` installs a `pre-push` hook that
rebuilds and runs the suite — a red test blocks the push. GitHub Actions
(`.github/workflows/ci.yml`) enforces the same on every push/PR, plus
`npm audit` (moderate+) so new advisories break the build before merge.
Dependency upgrades that fix audit findings must keep the suite green
(e.g. vitest 3 → 5); if a fix needs a breaking major, do it in its own commit
with the audit delta in the message.
