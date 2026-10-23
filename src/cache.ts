/**
 * Cold cache for ouraring-mcp (adapted from parksapi-mcp historyCache.ts).
 *
 * Single-user Oura API: every date-ranged query is cached per collection in
 * SQLite with day-granularity coverage (`oura_fetched`). Repeat/overlapping
 * queries only fetch dates not yet covered. The last 2 days
 * (OURA_RECENT_REFRESH_DAYS) always refetch — Oura keeps finalizing scores —
 * while older days are immutable: fetched once, served forever.
 *
 * NODATE / single-object data (personal_info, ring_configuration) and
 * single-document fetches go to a generic KV table with long TTLs.
 *
 * Location: OURARING_CACHE_PATH (fallback OURA_CACHE_PATH), default
 * ./oura-cache.sqlite in the server's working directory.
 * OURARING_CACHE_ENABLED=0 (or OURA_CACHE_ENABLED=0) disables it
 * (fail-soft bypass). The file is git-ignored — cached upstream data must
 * never be committed.
 *
 * Fail-soft: any SQLite error (read-only cwd, lock, schema) disables the
 * cache and the caller falls through to the upstream API.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/** Recent days always refetch (today + yesterday): Oura keeps appending. */
export const OURA_RECENT_REFRESH_DAYS = 2;

/** Version prefix baked into every cache key (KV + day tables).
 *  Bumping it retires a whole keyspace at once; readers fall back to the
 *  unprefixed legacy key on miss (lazy migration, fail-soft). */
export const CACHE_KEY_VERSION = "v1";

/** Chunk size for gap fetches (bound single-response size). */
export const OURA_MAX_RANGE_DAYS = 90;

// ---------------------------------------------------------------------------
// env knobs
// ---------------------------------------------------------------------------

function envPick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

export function isCacheEnabled(): boolean {
  return (
    process.env.OURARING_CACHE_ENABLED !== "0" &&
    process.env.OURA_CACHE_ENABLED !== "0"
  );
}

function cacheDbPath(): string {
  return (
    dbPathOverride ??
    envPick("OURARING_CACHE_PATH", "OURA_CACHE_PATH") ??
    path.join(process.cwd(), "oura-cache.sqlite")
  );
}

/** TTL for personal_info KV entries (default 30d = 720h). */
export function personalInfoTtlHours(): number {
  return Number(
    envPick("OURARING_PERSONAL_INFO_TTL_HOURS", "OURA_PERSONAL_INFO_TTL_HOURS") ??
      720,
  );
}

/** TTL for ring_configuration KV entries (default 30d = 720h). */
export function ringConfigurationTtlHours(): number {
  return Number(
    envPick(
      "OURARING_RING_CONFIGURATION_TTL_HOURS",
      "OURA_RING_CONFIGURATION_TTL_HOURS",
    ) ?? 720,
  );
}

/** Default KV TTL for everything else (default 7d = 168h). */
export function defaultCacheTtlHours(): number {
  return Number(
    envPick("OURARING_CACHE_TTL_HOURS", "OURA_CACHE_TTL_HOURS") ?? 168,
  );
}

/** TTL for a KV entry of a given collection. */
export function collectionTtlHours(collection: string): number {
  const c = canonicalCollectionName(collection);
  if (c === "personal_info") return personalInfoTtlHours();
  if (c === "ring_configuration") return ringConfigurationTtlHours();
  return defaultCacheTtlHours();
}

// ---------------------------------------------------------------------------
// db handle
// ---------------------------------------------------------------------------

let dbPathOverride: string | undefined;
let db: DatabaseSync | null = null;

/** Test hook: point the cache at another file (or ':memory:'). */
export function __resetForTests(dbPath = ":memory:"): void {
  close();
  dbPathOverride = dbPath;
}

/** Alias kept for symmetry with the parksapi handoff naming. */
export const __resetCacheForTests = __resetForTests;

export function close(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

/** Alias for callers that prefer the explicit name. */
export const closeCache = close;

export function getDb(): DatabaseSync | null {
  if (!isCacheEnabled()) return null;
  if (db) return db;
  try {
    const opened = new DatabaseSync(cacheDbPath());
    opened.exec("PRAGMA journal_mode=WAL");
    opened.exec("PRAGMA busy_timeout=5000");
    opened.exec(`
      CREATE TABLE IF NOT EXISTS oura_fetched (
        collection_key TEXT NOT NULL,
        date TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (collection_key, date)
      );
      CREATE TABLE IF NOT EXISTS oura_days (
        collection_key TEXT NOT NULL,
        date TEXT NOT NULL,
        idx INTEGER NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY (collection_key, date, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_days_collection
        ON oura_days(collection_key, date);
      CREATE TABLE IF NOT EXISTS kv_cache (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
    db = opened;
    return db;
  } catch {
    // Fail-soft: read-only cwd or locked file never breaks API calls.
    return null;
  }
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Dates in [from, to] without usable coverage. Dates within
 * `refreshRecentDays` of `to` always count as missing — the upstream keeps
 * finalizing them. Old dates only miss when never fetched (immutable).
 */
export function getUnfetchedDates(
  collectionKey: string,
  from: string,
  to: string,
  refreshRecentDays = OURA_RECENT_REFRESH_DAYS,
): string[] {
  const store = getDb();
  const dates = eachDate(from, to);
  if (!store) return dates;
  try {
    const cutoff = addDaysStr(to, -refreshRecentDays);
    // Union with the legacy (pre-v1) keyspace: rows written before the
    // version prefix still count as coverage; new writes go to the new key.
    const legacy = legacyKeyFor(collectionKey);
    const keys = legacy && legacy !== collectionKey ? [collectionKey, legacy] : [collectionKey];
    const placeholders = keys.map(() => "?").join(",");
    const rows = store
      .prepare(
        `SELECT date FROM oura_fetched WHERE collection_key IN (${placeholders}) AND date >= ? AND date <= ?`,
      )
      .all(...keys, from, to) as { date: string }[];
    const covered = new Set(rows.map((r) => r.date));
    return dates.filter((d) => d > cutoff || !covered.has(d));
  } catch {
    return dates;
  }
}

/** Group consecutive YYYY-MM-DD dates into {from, to} sub-ranges. */
export function groupConsecutiveDates(
  dates: string[],
): { from: string; to: string }[] {
  const ranges: { from: string; to: string }[] = [];
  for (const d of dates) {
    const last = ranges.at(-1);
    if (last && addDaysStr(last.to, 1) === d) last.to = d;
    else ranges.push({ from: d, to: d });
  }
  return ranges;
}

/** Split a {from, to} range into chunks of at most `size` days. */
export function chunkRange(
  from: string,
  to: string,
  size = OURA_MAX_RANGE_DAYS,
): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDaysStr(cursor, size - 1) <= to ? addDaysStr(cursor, size - 1) : to;
    out.push({ from: cursor, to: end });
    cursor = addDaysStr(end, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// day rows (date-ranged collections)
// ---------------------------------------------------------------------------

export type DayItem = { date: string; item: unknown };

const DAY_KEYS = [
  "day",
  "date",
  "timestamp",
  "start_time",
  "start_datetime",
  "created_at",
  "time",
] as const;

/** Extract the YYYY-MM-DD bucket for an Oura item, if parseable. */
export function itemDay(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  for (const k of DAY_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      return v.slice(0, 10);
    }
  }
  return undefined;
}

/** Cache key for a collection query (collection + field selector). */
export function collectionCacheKey(collection: string, fields?: string): string {
  const c = canonicalCollectionName(collection);
  const f = normalizeFields(fields);
  return f ? `${CACHE_KEY_VERSION}:${c}|fields=${f}` : `${CACHE_KEY_VERSION}:${c}`;
}

/**
 * Historic renames / out-of-band spellings: old key → canonical collection.
 * A rename must never orphan cached rows — add the old name here and both
 * spellings resolve to the same keyspace. (No renames shipped yet; `vo2max`
 * covers the bare spelling users type for the case-sensitive `vO2_max` route.)
 */
const COLLECTION_ALIASES: Record<string, string> = {
  vo2max: "vo2_max",
};

/** Canonical collection name: trim + lowercase, `-`/space → `_`, alias map. */
export function canonicalCollectionName(collection: string): string {
  const normalized = collection
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_")
    .replace(/_+/g, "_");
  return COLLECTION_ALIASES[normalized] ?? normalized;
}

/** Canonical field selector: split on comma, trim, lowercase, dedupe, sort. */
export function normalizeFields(fields?: string): string | undefined {
  if (fields === undefined) return undefined;
  const parts = [...new Set(fields.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean))].sort();
  return parts.length > 0 ? parts.join(",") : undefined;
}

/** Canonical document id: trim + lowercase. */
export function normalizeDocumentId(documentId: string): string {
  return documentId.trim().toLowerCase();
}

/** Cache key for a single-document fetch (collection + fields + document). */
export function documentCacheKey(
  collection: string,
  fields: string | undefined,
  documentId: string,
): string {
  return `${collectionCacheKey(collection, fields)}|doc=${normalizeDocumentId(documentId)}`;
}

/**
 * Legacy (pre-v1) counterpart of a versioned key: strip the `v1:` prefix.
 * `undefined` when the key was never versioned (nothing to fall back to).
 */
export function legacyKeyFor(key: string): string | undefined {
  const prefix = `${CACHE_KEY_VERSION}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

/** Load cached items for a collection key over [from, to], ordered by date. */
export function loadDayItems(
  collectionKey: string,
  from: string,
  to: string,
): DayItem[] {
  const store = getDb();
  if (!store) return [];
  try {
    const legacy = legacyKeyFor(collectionKey);
    const keys = legacy && legacy !== collectionKey ? [collectionKey, legacy] : [collectionKey];
    const placeholders = keys.map(() => "?").join(",");
    const rows = store
      .prepare(
        `SELECT date, item_json AS itemJson, collection_key AS key FROM oura_days
         WHERE collection_key IN (${placeholders}) AND date >= ? AND date <= ?
         ORDER BY date, idx`,
      )
      .all(...keys, from, to) as { date: string; itemJson: string; key: string }[];
    // Dedupe rows present under both keys (pre/post-migration overlap),
    // preferring the versioned key; same-key duplicates are preserved.
    const seen = new Map<string, string>();
    const ordered = [...rows].sort((a, b) =>
      a.key === collectionKey && b.key !== collectionKey ? -1
      : b.key === collectionKey && a.key !== collectionKey ? 1
      : 0,
    );
    const out: DayItem[] = [];
    for (const r of ordered) {
      const dedupe = `${r.date}::${r.itemJson}`;
      const firstKey = seen.get(dedupe);
      if (firstKey !== undefined && firstKey !== r.key) continue;
      seen.set(dedupe, r.key);
      out.push({ date: r.date, item: JSON.parse(r.itemJson) as unknown });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  } catch {
    return [];
  }
}

/**
 * Save items bucketed by day + mark `fetchedDates` covered. Idempotent:
 * rows for the fetched dates are replaced (delete + insert) in one
 * transaction, so re-saving an overlapping range never duplicates.
 */
export function saveDayItems(
  collectionKey: string,
  items: DayItem[],
  fetchedDates: string[],
): void {
  const store = getDb();
  if (!store || fetchedDates.length === 0) return;
  const now = new Date().toISOString();
  try {
    store.exec("BEGIN IMMEDIATE");
    const placeholders = fetchedDates.map(() => "?").join(",");
    store
      .prepare(
        `DELETE FROM oura_days WHERE collection_key = ? AND date IN (${placeholders})`,
      )
      .run(collectionKey, ...fetchedDates);
    const insert = store.prepare(
      `INSERT OR REPLACE INTO oura_days (collection_key, date, idx, item_json)
       VALUES (?, ?, ?, ?)`,
    );
    const perDate = new Map<string, number>();
    for (const { date, item } of items) {
      const idx = perDate.get(date) ?? 0;
      perDate.set(date, idx + 1);
      insert.run(collectionKey, date, idx, JSON.stringify(item));
    }
    const mark = store.prepare(
      "INSERT OR REPLACE INTO oura_fetched (collection_key, date, fetched_at) VALUES (?, ?, ?)",
    );
    for (const d of fetchedDates) mark.run(collectionKey, d, now);
    store.exec("COMMIT");
  } catch {
    try {
      store.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    /* fail-soft: caller already holds the data in memory */
  }
}

// ---------------------------------------------------------------------------
// KV (personal_info, ring_configuration, single docs — near-static data)
// ---------------------------------------------------------------------------

/** Read from KV when fresh; `undefined` = miss, expired, disabled, or error.
 *  On a miss under a versioned key, the legacy (pre-v1) key is tried and,
 *  when fresh, copied forward — lazy migration, fail-soft. */
export function kvGet(key: string, ttlHours: number): unknown | undefined {
  const store = getDb();
  if (!store) return undefined;
  try {
    const readFresh = (k: string): { found: boolean; value?: unknown } => {
      const row = store
        .prepare("SELECT value_json AS valueJson, fetched_at AS fetchedAt FROM kv_cache WHERE key = ?")
        .get(k) as { valueJson: string; fetchedAt: string } | undefined;
      if (!row) return { found: false };
      const ageMs = Date.now() - Date.parse(row.fetchedAt);
      if (!Number.isFinite(ageMs) || ageMs > ttlHours * 3_600_000) return { found: true };
      return { found: true, value: JSON.parse(row.valueJson) as unknown };
    };
    const hit = readFresh(key);
    if (hit.value !== undefined) return hit.value;
    if (hit.found) return undefined; // present but expired — legacy is older still
    const legacy = legacyKeyFor(key);
    if (!legacy || legacy === key) return undefined;
    const old = readFresh(legacy);
    if (old.value === undefined) return undefined;
    // Lazy forward-migration (best-effort; never breaks the read path).
    try {
      kvSet(key, old.value);
      store.prepare("DELETE FROM kv_cache WHERE key = ?").run(legacy);
    } catch {
      /* fail-soft */
    }
    return old.value;
  } catch {
    return undefined;
  }
}

/** Write to KV (fail-soft). */
export function kvSet(key: string, value: unknown): void {
  const store = getDb();
  if (!store) return;
  try {
    store
      .prepare("INSERT OR REPLACE INTO kv_cache (key, value_json, fetched_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), new Date().toISOString());
  } catch {
    /* fail-soft */
  }
}
