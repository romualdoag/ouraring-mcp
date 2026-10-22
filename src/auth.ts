#!/usr/bin/env npx tsx
/**
 * OAuth2 helper for personal single-user setup (OAuth2-only — Oura retired PATs Dec 2025).
 *
 * 1. Register your app at https://cloud.ouraring.com/oauth/applications
 *    with redirect URI http://localhost:8080/callback
 * 2. Credentials come from OURARING_CLIENT_ID + OURARING_CLIENT_SECRET
 *    (already in ~/.hermes/.env; OURA_* names also accepted, local .env wins)
 * 3. Remote/headless (Telegram, SSH): run `npm run auth:oura`, open the printed
 *    URL in your own browser, approve, then copy the ?code= from the failed
 *    localhost redirect and re-run as `npm run auth:oura -- --code=...`
 *    Local: `npm run auth:oura` prints the authorize URL and catches the callback on :8080.
 *
 * The MCP server itself accepts OURARING_ACCESS_TOKEN (OAuth2 access token) and
 * auto-refreshes via OURARING_REFRESH_TOKEN when CLIENT_ID/SECRET are present.
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

// Remote/headless exchange: npm run auth:oura -- --code=... (copy ?code= from the localhost redirect)
const codeArg = process.argv.find((a) => a.startsWith("--code="))?.slice("--code=".length)
  || process.env.OURARING_CODE || process.env.OURA_CODE;

async function exchangeCode(code: string): Promise<void> {
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
  console.log(`\nOURARING_ACCESS_TOKEN=${tokens.access_token}`);
  console.log(`OURARING_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  console.log("Save both in ~/.hermes/.env (ACCESS_TOKEN is short-lived; REFRESH_TOKEN lets the server auto-refresh).");
  console.log("Then register: printf 'Y\\n' | hermes mcp add ouraring --command node --env OURARING_REFRESH_TOKEN=... --env OURARING_CLIENT_ID=... --env OURARING_CLIENT_SECRET=... --args /home/hermes/github/ouraring-mcp/dist/index.js");
}

if (codeArg) {
  await exchangeCode(codeArg);
  process.exit(0);
}

console.log("2a) Headless: after approving, copy the ?code= from the browser address bar and re-run:\n");
console.log("     npm run auth:oura -- --code=PASTE_CODE_HERE\n");
console.log("2b) Local: waiting for the callback on http://localhost:8080/callback ...\n");

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
  console.log(`\nOURARING_ACCESS_TOKEN=${tokens.access_token}`);
  console.log(`OURARING_REFRESH_TOKEN=${tokens.refresh_token}\n`);

  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const cur = readFileSync(envPath, "utf8");
    if (!/^OURARING_REFRESH_TOKEN=/m.test(cur)) {
      appendFileSync(envPath, `\nOURARING_ACCESS_TOKEN=${tokens.access_token}\nOURARING_REFRESH_TOKEN=${tokens.refresh_token}\n`);
      console.log("Appended tokens to .env (rotate/revoke any time from your Oura dashboard).");
    } else {
      console.log("Not touching .env (it already has OURARING_REFRESH_TOKEN) — copy the values above manually.");
    }
  } else {
    console.log("Save both in ~/.hermes/.env — REFRESH_TOKEN lets the server auto-refresh.");
  }
});

server.listen(8080, () => console.log("Listening on http://localhost:8080 ..."));
