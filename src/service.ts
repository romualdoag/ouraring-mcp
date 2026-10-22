/**
 * ouraring-mcp service layer — pure Oura API v2 client, no MCP imports.
 *
 * Thin wrappers over https://api.ouraring.com/v2/usercollection/*.
 * Every tool in index.ts maps 1:1 to one function here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OURA_API_BASE =
  (process.env.OURA_API_BASE || process.env.OURARING_API_BASE)?.replace(/\/$/, "") ||
  "https://api.ouraring.com";

const TIMEOUT_MS = Number(process.env.OURA_TIMEOUT_MS || process.env.OURARING_TIMEOUT_MS || 30_000);

/** Env alias: OURARING_* (user's ~/.hermes/.env) wins, OURA_* is the fallback. */
export function envVar(name: string): string | undefined {
  const v = process.env[`OURARING_${name}`]?.trim() || process.env[`OURA_${name}`]?.trim();
  return v || undefined;
}

function packageVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    // src/service.ts -> ../package.json in dev, dist/service.js -> ../package.json in build
    for (const candidate of [join(dir, "../package.json"), join(dir, "../../package.json")]) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8")).version || "0.0.0";
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

export const USER_AGENT = `ouraring-mcp/${packageVersion()}`;

// ---------------------------------------------------------------------------
// errors + auth
// ---------------------------------------------------------------------------

export class OuraError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OuraError";
    this.status = status;
  }
}

export function getAccessToken(): string {
  const token = envVar("ACCESS_TOKEN");
  if (!token) {
    throw new OuraError(
      "No Oura credentials. Set OURARING_ACCESS_TOKEN (OAuth2 access token — Oura retired Personal Access Tokens in Dec 2025) " +
        "or run `npm run auth:oura` for the OAuth2 flow with the OURARING_CLIENT_ID/OURARING_CLIENT_SECRET already in ~/.hermes/.env. " +
        "If you have OURARING_REFRESH_TOKEN, the server will refresh automatically.",
    );
  }
  return token;
}

export function getRefreshToken(): string | undefined {
  return envVar("REFRESH_TOKEN");
}

/** Exchange OURARING_REFRESH_TOKEN (+ client credentials) for a fresh access token. */
export async function refreshAccessToken(): Promise<string> {
  const refreshToken = getRefreshToken();
  const clientId = envVar("CLIENT_ID");
  const clientSecret = envVar("CLIENT_SECRET");
  if (!refreshToken) throw new OuraError("No OURARING_REFRESH_TOKEN configured — run `npm run auth:oura` once.");
  if (!clientId || !clientSecret) throw new OuraError("Need OURARING_CLIENT_ID + OURARING_CLIENT_SECRET to refresh (already in ~/.hermes/.env).");
  const res = await fetch(`${OURA_API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) throw new OuraError(`Oura token refresh failed (HTTP ${res.status}): ${body.slice(0, 300)}`, res.status);
  let json: { access_token?: string };
  try {
    json = JSON.parse(body);
  } catch {
    throw new OuraError("Oura token refresh returned non-JSON.", res.status);
  }
  if (!json.access_token) throw new OuraError("Oura token refresh returned no access_token.", res.status);
  process.env.OURARING_ACCESS_TOKEN = json.access_token;
  return json.access_token;
}

// ---------------------------------------------------------------------------
// injectable fetch (timeout, UA, unit-testable offline)
// ---------------------------------------------------------------------------

export type FetchLike = typeof fetch;

let fetchImpl: FetchLike = fetch;

export function setFetchForTests(fn: FetchLike): void {
  fetchImpl = fn;
}

export function resetFetch(): void {
  fetchImpl = fetch;
}

export interface PageResult<T = unknown> {
  data: T[];
  next_token: string | null;
}

async function ouraGet<T = unknown>(
  path: string,
  params: Record<string, string | undefined>,
  token?: string,
  _retried?: boolean,
): Promise<PageResult<T>> {
  const accessToken = token ?? getAccessToken();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, v);
  }
  const url = `${OURA_API_BASE}${path}${qs.size ? `?${qs}` : ""}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new OuraError(`Oura request timed out after ${TIMEOUT_MS}ms: ${path}`, 0);
    }
    throw new OuraError(
      `Network error reaching Oura API (${path}): ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    // OAuth access tokens are short-lived — if a refresh token is configured, try once, then retry.
    if (!_retried && !token && getRefreshToken() && envVar("CLIENT_ID") && envVar("CLIENT_SECRET")) {
      try {
        const fresh = await refreshAccessToken();
        return ouraGet<T>(path, params, fresh, true);
      } catch {
        /* fall through to the credentials error below */
      }
    }
    throw new OuraError(
      "Oura rejected the credentials (HTTP " +
        res.status +
        "). Token expired/revoked or missing scope — the server already tried refresh (if configured); otherwise run `npm run auth:oura` again. Oura retired PATs in Dec 2025, OAuth2 only.",
      res.status,
    );
  }
  if (res.status === 429) {
    throw new OuraError("Oura rate limit hit (HTTP 429). Wait a minute and retry.", 429);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OuraError(`Oura API error HTTP ${res.status} on ${path}: ${body.slice(0, 500)}`, res.status);
  }
  const json = (await res.json()) as PageResult<T>;
  return { data: json.data ?? [], next_token: json.next_token ?? null };
}

// ---------------------------------------------------------------------------
// collections registry (no per-collection code in tools)
// ---------------------------------------------------------------------------

export const DAILY_TYPES = [
  "activity",
  "cardiovascular_age",
  "readiness",
  "resilience",
  "sleep",
  "spo2",
  "stress",
] as const;
export type DailyType = (typeof DAILY_TYPES)[number];

export const DETAIL_COLLECTIONS = [
  "sleep",
  "sleep_time",
  "workout",
  "session",
  "tag",
  "enhanced_tag",
  "heartrate",
  "rest_mode_period",
  "ring_configuration",
  "ring_battery_level",
  "vo2_max",
] as const;
export type DetailCollection = (typeof DETAIL_COLLECTIONS)[number];

const COLLECTION_SCOPE: Record<string, string> = {
  personal_info: "personal, email",
  daily_activity: "daily",
  daily_cardiovascular_age: "daily + heart_health",
  daily_readiness: "daily",
  daily_resilience: "daily",
  daily_sleep: "daily",
  daily_spo2: "daily + spo2",
  daily_stress: "daily + stress",
  sleep: "daily",
  sleep_time: "daily",
  workout: "workout",
  session: "session",
  tag: "tag",
  enhanced_tag: "tag",
  heartrate: "heartrate",
  rest_mode_period: "daily",
  ring_configuration: "ring_configuration",
  ring_battery_level: "ring_configuration",
  vo2_max: "daily",
};

export function listCollections(): { collection: string; path: string; scope: string }[] {
  const daily = DAILY_TYPES.map((t) => ({
    collection: `daily_${t}`,
    path: `/v2/usercollection/daily_${t}`,
    scope: COLLECTION_SCOPE[`daily_${t}`] || "",
  }));
  const detail: { collection: string; path: string; scope: string }[] = [
    { collection: "personal_info", path: "/v2/usercollection/personal_info", scope: COLLECTION_SCOPE.personal_info },
    ...DETAIL_COLLECTIONS.map((c) => ({
      collection: c,
      path: `/v2/usercollection/${c}`,
      scope: COLLECTION_SCOPE[c] || "",
    })),
  ];
  return [...detail, ...daily];
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function withLimit<T>(arr: T[], limit?: number): { items: T[]; truncated: boolean; total: number } {
  const total = arr.length;
  if (limit === undefined) return { items: arr, truncated: false, total };
  return { items: arr.slice(0, limit), truncated: total > limit, total };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

export async function ouraStatus(): Promise<Record<string, unknown>> {
  let configured = false;
  let tokenPrefix = "";
  try {
    const t = getAccessToken();
    configured = true;
    tokenPrefix = `${t.slice(0, 4)}… (${t.length} chars)`;
  } catch {
    configured = false;
  }
  const refreshConfigured = Boolean(getRefreshToken());
  return {
    server: "ouraring-mcp",
    version: packageVersion(),
    api_base: OURA_API_BASE,
    auth: "oauth2-only (Oura retired PATs Dec 2025)",
    auth_configured: configured,
    token: tokenPrefix || null,
    refresh_token_configured: refreshConfigured,
    oauth_client_configured: Boolean(envVar("CLIENT_ID") && envVar("CLIENT_SECRET")),
    redirect_uri: envVar("REDIRECT_URI") || "http://localhost:8080/callback",
    hint: configured
      ? "Credentials present. Call get_personal_info to verify them live."
      : refreshConfigured
        ? "Refresh token present but no access token — next live call will mint one automatically."
        : "No access token. Run `npm run auth:oura -- --code=...` (OAuth2, uses OURARING_CLIENT_ID/SECRET from ~/.hermes/.env).",
  };
}

export async function getPersonalInfo(token?: string): Promise<unknown> {
  const page = await ouraGet("/v2/usercollection/personal_info", {}, token);
  // personal_info returns a single object, not a paged list, on some accounts
  return (page as unknown as { data?: unknown }).data ?? page;
}

export interface DateRangeOpts {
  start_date?: string;
  end_date?: string;
  limit?: number;
  next_token?: string;
}

function assertDateRange(opts: DateRangeOpts): void {
  for (const k of ["start_date", "end_date"] as const) {
    const v = opts[k];
    if (v !== undefined && !isValidDate(v)) {
      throw new OuraError(`Invalid ${k} "${v}" — use YYYY-MM-DD.`);
    }
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    throw new OuraError(`Invalid limit "${opts.limit}" — must be a positive integer.`);
  }
}

async function fetchAllPages<T>(
  path: string,
  params: Record<string, string | undefined>,
  limit: number | undefined,
  token?: string,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = params.next_token;
  const base = { ...params };
  do {
    const page = await ouraGet<T>(path, { ...base, next_token: next }, token);
    out.push(...page.data);
    next = page.next_token ?? undefined;
    if (limit !== undefined && out.length >= limit) break;
    if (out.length > 50_000) break; // safety cap
  } while (next);
  return out;
}

export async function getDaily(
  dataType: string,
  opts: DateRangeOpts = {},
  token?: string,
): Promise<Record<string, unknown>> {
  const t = dataType.toLowerCase() as DailyType;
  if (!(DAILY_TYPES as readonly string[]).includes(t)) {
    throw new OuraError(`Unknown daily type "${dataType}" — one of: ${DAILY_TYPES.join(", ")}.`);
  }
  assertDateRange(opts);
  const rows = await fetchAllPages(`/v2/usercollection/daily_${t}`, {
    start_date: opts.start_date,
    end_date: opts.end_date,
    next_token: opts.next_token,
  }, opts.limit, token);
  const { items, truncated, total } = withLimit(rows, opts.limit ?? 50);
  return {
    collection: `daily_${t}`,
    effective_range: { start_date: opts.start_date ?? null, end_date: opts.end_date ?? null },
    total,
    truncated,
    items,
  };
}

export interface CollectionOpts extends DateRangeOpts {
  start_datetime?: string;
  end_datetime?: string;
  latest?: boolean;
  document_id?: string;
}

export async function getCollection(
  collection: string,
  opts: CollectionOpts = {},
  token?: string,
): Promise<Record<string, unknown>> {
  const c = collection.toLowerCase();
  const known = new Set<string>([...DETAIL_COLLECTIONS, ...DAILY_TYPES.map((t) => `daily_${t}`), "personal_info"]);
  if (!known.has(c)) {
    throw new OuraError(
      `Unknown collection "${collection}". See list_collections — e.g. sleep, workout, session, tag, heartrate, daily_sleep.`,
    );
  }
  if (c === "personal_info") return { collection: c, result: await getPersonalInfo(token) };
  assertDateRange(opts);
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    throw new OuraError(`Invalid limit "${opts.limit}" — must be a positive integer.`);
  }
  // single-document fetch
  if (opts.document_id) {
    const page = await ouraGet(`/v2/usercollection/${c}/${opts.document_id}`, {}, token);
    return { collection: c, document_id: opts.document_id, result: (page as unknown as { data?: unknown }).data ?? page };
  }
  const params: Record<string, string | undefined> = c === "heartrate"
    ? {
      start_datetime: opts.start_datetime,
      end_datetime: opts.end_datetime,
      latest: opts.latest ? "true" : undefined,
      next_token: opts.next_token,
    }
    : { start_date: opts.start_date, end_date: opts.end_date, next_token: opts.next_token };
  const rows = await fetchAllPages(`/v2/usercollection/${c}`, params, opts.limit, token);
  const { items, truncated, total } = withLimit(rows, opts.limit ?? 50);
  return { collection: c, total, truncated, items };
}

/** One-call week overview for natural-language summaries: sleep + readiness + activity + stress. */
export async function getRecentSummary(days = 7, token?: string): Promise<Record<string, unknown>> {
  if (!Number.isInteger(days) || days <= 0 || days > 90) {
    throw new OuraError(`Invalid days "${days}" — integer 1..90.`);
  }
  const end = new Date();
  const start = new Date(Date.now() - (days - 1) * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const range = { start_date: fmt(start), end_date: fmt(end) };
  const [sleep, readiness, activity, stress] = await Promise.all([
    fetchAllPages(`/v2/usercollection/daily_sleep`, range, undefined, token),
    fetchAllPages(`/v2/usercollection/daily_readiness`, range, undefined, token),
    fetchAllPages(`/v2/usercollection/daily_activity`, range, undefined, token),
    fetchAllPages(`/v2/usercollection/daily_stress`, range, undefined, token).catch(() => [] as unknown[]),
  ]);
  return {
    range,
    counts: {
      daily_sleep: sleep.length,
      daily_readiness: readiness.length,
      daily_activity: activity.length,
      daily_stress: stress.length,
    },
    daily_sleep: sleep,
    daily_readiness: readiness,
    daily_activity: activity,
    daily_stress: stress,
    note: "Arrays are day-keyed; join on `day`. Scores are 0-100 where present. Ask follow-ups with get_daily/get_collection for detail.",
  };
}
