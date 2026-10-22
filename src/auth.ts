#!/usr/bin/env npx tsx
/**
 * OAuth2 helper for personal single-user setup.
 *
 * 1. Register your app at https://cloud.ouraring.com/oauth/applications
 *    with redirect URI http://localhost:8080/callback
 * 2. Credentials come from OURARING_CLIENT_ID + OURARING_CLIENT_SECRET
 *    (already in ~/.hermes/.env; OURA_* names also accepted, local .env wins)
 * 3. Run `npm run auth:oura` — it prints the authorize URL, listens on
 *    :8080 for the callback, exchanges the code, and prints + optionally
 *    appends tokens to .env
 *
 * The MCP server itself accepts OURARING_ACCESS_TOKEN (or OURA_ACCESS_TOKEN:
 * PAT or OAuth access token). Use the refresh token below to mint a fresh
 * access token when the old one expires:
 *
 *   curl -s -u "$OURARING_CLIENT_ID:$OURARING_CLIENT_SECRET" \
 *     -d grant_type=refresh_token -d refresh_token="$OURARING_REFRESH_TOKEN" \
 *     https://api.ouraring.com/oauth/token
 */
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minimal .env loader — no dependency. Local ./.env wins, ~/.hermes/.env fills gaps. */
function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) {
      process.env[k] = v.replace(/^["']|["']$/g, "");
    }
  }
}
loadEnvFile(join(process.cwd(), ".env"));
loadEnvFile(join(homedir(), ".hermes", ".env"));

const pick = (...names: string[]): string | undefined => {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
};

// OURARING_* (your ~/.hermes/.env) takes precedence, OURA_* is the fallback.
const CLIENT_ID = pick("OURARING_CLIENT_ID", "OURA_CLIENT_ID");
const CLIENT_SECRET = pick("OURARING_CLIENT_SECRET", "OURA_CLIENT_SECRET");
const REDIRECT_URI = pick("OURARING_REDIRECT_URI", "OURA_REDIRECT_URI") || "http://localhost:8080/callback";
const SCOPES = (
  pick("OURARING_SCOPES", "OURA_SCOPES") ||
  "email personal daily heartrate workout tag session spo2 ring_configuration stress heart_health"
).trim();

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set OURARING_CLIENT_ID and OURARING_CLIENT_SECRET first — already in ~/.hermes/.env (see .env.example).");
  process.exit(1);
}

const authorizeUrl =
  "https://cloud.ouraring.com/oauth/authorize?" +
  new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPES });

console.log("\n1) Open this URL in your browser and approve access:\n");
console.log(authorizeUrl + "\n");
console.log("2) Waiting for the callback on http://localhost:8080/callback ...\n");

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost:8080");
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Missing ?code (${err || "no code"}). Re-open the authorize URL.`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Authorized — back to the terminal. You can close this tab.");
  server.close();

  const tokenRes = await fetch("https://api.ouraring.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = await tokenRes.text();
  if (!tokenRes.ok) {
    console.error(`\nToken exchange failed (HTTP ${tokenRes.status}): ${body}`);
    process.exit(1);
  }
  const tokens = JSON.parse(body) as { access_token: string; refresh_token: string; expires_in: number };
  console.log(`\nOK — access token expires in ~${tokens.expires_in}s.`);
  console.log(`\nOURA_ACCESS_TOKEN=${tokens.access_token}`);
  console.log(`OURA_REFRESH_TOKEN=${tokens.refresh_token}\n`);

  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const cur = readFileSync(envPath, "utf8");
    if (!/^OURA_REFRESH_TOKEN=/m.test(cur)) {
      appendFileSync(envPath, `\nOURA_ACCESS_TOKEN=${tokens.access_token}\nOURA_REFRESH_TOKEN=${tokens.refresh_token}\n`);
      console.log("Appended tokens to .env (rotate/revoke any time from your Oura dashboard).");
    } else {
      console.log("Not touching .env (it already has OURA_REFRESH_TOKEN) — copy the values above manually.");
    }
  }
});

server.listen(8080, () => console.log("Listening on http://localhost:8080 ..."));
