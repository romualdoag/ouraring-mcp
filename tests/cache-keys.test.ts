import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getCollection, getDaily, setFetchForTests, resetFetch } from "../src/service.js";
import {
  __resetForTests,
  addDaysStr,
  canonicalCollectionName,
  close,
  collectionCacheKey,
  documentCacheKey,
  eachDate,
  getDb,
  getUnfetchedDates,
  kvGet,
  kvSet,
  legacyKeyFor,
  loadDayItems,
  normalizeDocumentId,
  normalizeFields,
  saveDayItems,
  todayUtc,
} from "../src/cache.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Stub that answers any range with one day-keyed item per requested date. */
function smartStub(calls: string[]) {
  return (async (url: unknown) => {
    const u = new URL(String(url));
    calls.push(`${u.pathname}?${u.searchParams.toString()}`);
    const seg = u.pathname.split("/").filter(Boolean);
    const coll = seg[2];
    if (seg.length > 3) {
      const docId = decodeURIComponent(seg[3]);
      return json({ data: { id: docId, day: "2026-09-15", score: 77 }, next_token: null });
    }
    const sd = u.searchParams.get("start_date");
    const ed = u.searchParams.get("end_date");
    const days = sd && ed ? eachDate(sd, ed) : [todayUtc()];
    return json({ data: days.map((day) => ({ id: `${coll}-${day}`, day, score: 80 })), next_token: null });
  }) as typeof fetch;
}

describe("cache keys hardening (:memory:)", () => {
  beforeEach(() => {
    __resetForTests(":memory:");
    process.env.OURARING_ACCESS_TOKEN = "test-token";
  });
  afterEach(() => {
    resetFetch();
    close();
    delete process.env.OURARING_ACCESS_TOKEN;
  });

  it("normalizeFields: split/trim/lowercase/sort (+dedupe)", () => {
    expect(normalizeFields("score, day")).toBe("day,score");
    expect(normalizeFields("Score,DAY, score ")).toBe("day,score");
    expect(normalizeFields(" b ,a,c ")).toBe("a,b,c");
    expect(normalizeFields("")).toBeUndefined();
    expect(normalizeFields("  , ")).toBeUndefined();
    expect(normalizeFields(undefined)).toBeUndefined();
  });

  it("collectionCacheKey: v1 prefix + fields normalization", () => {
    expect(collectionCacheKey("sleep")).toBe("v1:sleep");
    expect(collectionCacheKey("Sleep", "score, day")).toBe("v1:sleep|fields=day,score");
    expect(collectionCacheKey(" sleep ", "day,score")).toBe(collectionCacheKey("Sleep", "score, day"));
    expect(collectionCacheKey("daily_sleep", "")).toBe("v1:daily_sleep");
    expect(legacyKeyFor(collectionCacheKey("sleep", "day,score"))).toBe("sleep|fields=day,score");
    expect(legacyKeyFor("unversioned")).toBeUndefined();
  });

  it("canonicalCollectionName: trim/case/separators + alias map, passthrough otherwise", () => {
    expect(canonicalCollectionName(" Sleep ")).toBe("sleep");
    expect(canonicalCollectionName("Sleep-Time")).toBe("sleep_time");
    expect(canonicalCollectionName("daily readiness")).toBe("daily_readiness");
    expect(canonicalCollectionName("VO2MAX")).toBe("vo2_max");
    expect(canonicalCollectionName("vo2_max")).toBe("vo2_max");
    // unknown names pass through untouched (validation happens downstream)
    expect(canonicalCollectionName("frobnicate")).toBe("frobnicate");
    // alias shares the keyspace — a rename never orphans rows
    expect(collectionCacheKey("VO2MAX")).toBe(collectionCacheKey("vo2_max"));
    expect(collectionCacheKey("Sleep-Time")).toBe(collectionCacheKey("sleep_time"));
  });

  it("normalizeDocumentId + documentCacheKey: trim/lowercase", () => {
    expect(normalizeDocumentId(" ABC-123 ")).toBe("abc-123");
    expect(documentCacheKey("sleep", undefined, "ABC-123")).toBe(
      documentCacheKey(" Sleep ", undefined, " abc-123 "),
    );
    expect(documentCacheKey("sleep", "score,day", "X")).toBe("v1:sleep|fields=day,score|doc=x");
  });

  it("KV lazy migration: legacy key read via v1 key and copied forward", () => {
    kvSet("personal_info", { id: "user-1" }); // pre-v1 row, unprefixed
    expect(kvGet("v1:personal_info", 720)).toEqual({ id: "user-1" });
    // migrated: legacy row gone, versioned row serves directly
    const db = getDb()!;
    expect(db.prepare("SELECT key FROM kv_cache WHERE key = ?").get("personal_info")).toBeUndefined();
    expect(kvGet("v1:personal_info", 720)).toEqual({ id: "user-1" });
  });

  it("KV legacy fallback respects TTL (expired legacy stays a miss)", () => {
    kvSet("personal_info", { id: "user-1" });
    const db = getDb()!;
    db.prepare("UPDATE kv_cache SET fetched_at = ? WHERE key = ?").run("2000-01-01T00:00:00.000Z", "personal_info");
    expect(kvGet("v1:personal_info", 720)).toBeUndefined();
  });

  it("day tables: legacy rows count as coverage under the v1 key", () => {
    const newKey = collectionCacheKey("daily_sleep");
    const oldDay = addDaysStr(todayUtc(), -20);
    saveDayItems("daily_sleep", [{ date: oldDay, item: { day: oldDay } }], [oldDay]); // pre-v1 write
    expect(newKey).toBe("v1:daily_sleep");
    expect(getUnfetchedDates(newKey, oldDay, oldDay, 0)).toEqual([]);
    expect(loadDayItems(newKey, oldDay, oldDay)).toEqual([{ date: oldDay, item: { day: oldDay } }]);
  });

  it("service: reordered fields hit the same key (1 upstream call)", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    const end = addDaysStr(todayUtc(), -10);
    const start = addDaysStr(todayUtc(), -20);
    await getDaily("sleep", { start_date: start, end_date: end, fields: "score,day" });
    const second = await getDaily("sleep", { start_date: start, end_date: end, fields: " day, SCORE " });
    expect(calls).toHaveLength(1);
    expect(second.cacheHit).toBe(true);
  });

  it("service: document_id case/whitespace hits the same key (1 upstream call)", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    await getCollection("sleep", { document_id: "ABC-123" });
    const second = await getCollection("sleep", { document_id: " abc-123 " });
    expect(calls).toHaveLength(1);
    expect(second.cacheHit).toBe(true);
  });

  it("service: alias/separator spellings resolve to the canonical collection", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    const end = addDaysStr(todayUtc(), -10);
    const start = addDaysStr(todayUtc(), -12);
    const first = await getCollection("Sleep-Time", { start_date: start, end_date: end });
    expect(first.cacheHit).toBe(false);
    expect(first.total).toBe(3);
    const second = await getCollection("sleep_time", { start_date: start, end_date: end });
    expect(calls).toHaveLength(1);
    expect(second.cacheHit).toBe(true);
  });
});
