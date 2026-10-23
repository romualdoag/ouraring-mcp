import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getCollection,
  getDaily,
  getPersonalInfo,
  setFetchForTests,
  resetFetch,
} from "../src/service.js";
import {
  __resetForTests,
  addDaysStr,
  chunkRange,
  close,
  collectionTtlHours,
  defaultCacheTtlHours,
  eachDate,
  getDb,
  getUnfetchedDates,
  groupConsecutiveDates,
  kvGet,
  kvSet,
  loadDayItems,
  personalInfoTtlHours,
  ringConfigurationTtlHours,
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
    if (coll === "personal_info") return json({ id: "user-1", email: "t@example.com" });
    if (seg.length > 3) {
      const docId = decodeURIComponent(seg[3]);
      return json({ data: { id: docId, day: "2026-09-15", score: 77 }, next_token: null });
    }
    if (coll === "ring_configuration") {
      return json({ data: [{ id: "cfg-1", color: "black" }], next_token: null });
    }
    const sd = u.searchParams.get("start_date");
    const ed = u.searchParams.get("end_date");
    const sdt = u.searchParams.get("start_datetime");
    const edt = u.searchParams.get("end_datetime");
    let days: string[] = [];
    if (sd && ed) days = eachDate(sd, ed);
    else if (sdt && edt) days = eachDate(sdt.slice(0, 10), edt.slice(0, 10));
    else days = [todayUtc()];
    const data = days.map((day) =>
      coll === "heartrate"
        ? { id: `hr-${day}`, timestamp: `${day}T12:00:00.000Z`, bpm: 62 }
        : { id: `${coll}-${day}`, day, score: 80 },
    );
    return json({ data, next_token: null });
  }) as typeof fetch;
}

describe("cold cache (offline, :memory:)", () => {
  beforeEach(() => {
    __resetForTests(":memory:");
    process.env.OURARING_ACCESS_TOKEN = "test-token";
    delete process.env.OURARING_CACHE_ENABLED;
    delete process.env.OURA_CACHE_ENABLED;
  });
  afterEach(() => {
    resetFetch();
    close();
    delete process.env.OURARING_ACCESS_TOKEN;
    delete process.env.OURARING_CACHE_ENABLED;
    delete process.env.OURA_CACHE_ENABLED;
  });

  it("kv roundtrips, expires by TTL, and bypasses when disabled", () => {
    kvSet("k", { a: 1 });
    expect(kvGet("k", 720)).toEqual({ a: 1 });
    expect(kvGet("k", -1)).toBeUndefined(); // already expired
    expect(kvGet("missing", 720)).toBeUndefined();
    process.env.OURARING_CACHE_ENABLED = "0";
    expect(kvGet("k", 720)).toBeUndefined();
    expect(getDb()).toBeNull();
  });

  it("TTLs: personal_info/ring_configuration 30d, resto 7d", () => {
    expect(personalInfoTtlHours()).toBe(720);
    expect(ringConfigurationTtlHours()).toBe(720);
    expect(defaultCacheTtlHours()).toBe(168);
    expect(collectionTtlHours("personal_info")).toBe(720);
    expect(collectionTtlHours("ring_configuration")).toBe(720);
    expect(collectionTtlHours("sleep")).toBe(168);
    process.env.OURARING_CACHE_TTL_HOURS = "24";
    expect(defaultCacheTtlHours()).toBe(24);
    expect(collectionTtlHours("sleep")).toBe(24);
    expect(collectionTtlHours("personal_info")).toBe(720); // untouched
    delete process.env.OURARING_CACHE_TTL_HOURS;
  });

  it("getUnfetchedDates: old covered dates don't return, recent always do", () => {
    const today = todayUtc();
    const old = addDaysStr(today, -20);
    saveDayItems("daily_sleep", [{ date: old, item: { day: old } }], [old, today]);
    expect(getUnfetchedDates("daily_sleep", old, old, 0)).toEqual([]);
    // today is covered but recent → always missing
    expect(getUnfetchedDates("daily_sleep", today, today, 2)).toEqual([today]);
    // grouping still merges consecutive gaps
    expect(groupConsecutiveDates([old, addDaysStr(old, 1), addDaysStr(old, 3)]))
      .toEqual([
        { from: old, to: addDaysStr(old, 1) },
        { from: addDaysStr(old, 3), to: addDaysStr(old, 3) },
      ]);
    expect(chunkRange(old, addDaysStr(old, 200), 90)).toHaveLength(3);
  });

  it("incremental getDaily: 2nd historical call hits cache with 0 upstream calls", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    const end = addDaysStr(todayUtc(), -10);
    const start = addDaysStr(todayUtc(), -20);
    const first = await getDaily("sleep", { start_date: start, end_date: end });
    expect(calls).toHaveLength(1);
    expect(first.cacheHit).toBe(false);
    expect(first.total).toBe(11);
    const second = await getDaily("sleep", { start_date: start, end_date: end });
    expect(calls).toHaveLength(1); // zero new upstream calls
    expect(second.cacheHit).toBe(true);
    expect(second).toEqual({ ...first, cacheHit: true });
    // overlapping range only fetches the new dates
    const wider = await getDaily("sleep", { start_date: addDaysStr(todayUtc(), -22), end_date: end });
    expect(wider.cacheHit).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`start_date=${addDaysStr(todayUtc(), -22)}`);
    expect(wider.total).toBe(13);
  });

  it("recent-refetch: live range re-fetches only the last 2 days", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    const start = addDaysStr(todayUtc(), -5);
    const end = todayUtc();
    await getDaily("readiness", { start_date: start, end_date: end });
    expect(calls).toHaveLength(1);
    const second = await getDaily("readiness", { start_date: start, end_date: end });
    expect(calls).toHaveLength(2);
    expect(second.cacheHit).toBe(false);
    // only the recent gap (yesterday + today) was refetched
    expect(calls[1]).toContain(`start_date=${addDaysStr(end, -1)}`);
    expect(calls[1]).toContain(`end_date=${end}`);
    expect(second.total).toBe(6);
  });

  it("getCollection date range is incremental too", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    const end = addDaysStr(todayUtc(), -10);
    const start = addDaysStr(todayUtc(), -15);
    await getCollection("sleep", { start_date: start, end_date: end });
    expect(calls).toHaveLength(1);
    const second = await getCollection("sleep", { start_date: start, end_date: end });
    expect(calls).toHaveLength(1);
    expect(second.cacheHit).toBe(true);
    expect(second.total).toBe(6);
  });

  it("datetime collections (heartrate) are incremental by day", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    const endDay = addDaysStr(todayUtc(), -10);
    const startDay = addDaysStr(todayUtc(), -12);
    const range = {
      start_datetime: `${startDay}T00:00:00.000Z`,
      end_datetime: `${endDay}T23:59:59.000Z`,
    };
    const first = await getCollection("heartrate", range);
    expect(calls).toHaveLength(1);
    expect(first.cacheHit).toBe(false);
    expect(first.total).toBe(3);
    const second = await getCollection("heartrate", range);
    expect(calls).toHaveLength(1);
    expect(second.cacheHit).toBe(true);
    expect(second).toEqual({ ...first, cacheHit: true });
    // items keep their timestamps (bucketed, not truncated to dates)
    const items = second.items as { timestamp: string }[];
    expect(items[0].timestamp).toContain(startDay);
  });

  it("personal_info served from KV on 2nd call (30d TTL)", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    await getPersonalInfo();
    await getPersonalInfo();
    expect(calls).toHaveLength(1);
    const via = await getCollection("personal_info");
    expect(calls).toHaveLength(1);
    expect(via.cacheHit).toBe(true);
  });

  it("ring_configuration served from KV on 2nd call (30d TTL)", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    const first = await getCollection("ring_configuration");
    expect(first.cacheHit).toBe(false);
    const second = await getCollection("ring_configuration");
    expect(second.cacheHit).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("single-document fetch cached in KV (resto 7d)", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    const first = await getCollection("sleep", { document_id: "abc-123" });
    expect(first.cacheHit).toBe(false);
    const second = await getCollection("sleep", { document_id: "abc-123" });
    expect(second.cacheHit).toBe(true);
    expect(second).toEqual({ ...first, cacheHit: true });
    expect(calls).toHaveLength(1);
  });

  it("CACHE_ENABLED=0 is fail-soft: direct fetch, no crash, no store", async () => {
    const calls: string[] = [];
    setFetchForTests(smartStub(calls));
    process.env.OURARING_CACHE_ENABLED = "0";
    const end = addDaysStr(todayUtc(), -10);
    const start = addDaysStr(todayUtc(), -15);
    const first = await getDaily("sleep", { start_date: start, end_date: end });
    const second = await getDaily("sleep", { start_date: start, end_date: end });
    expect(calls).toHaveLength(2);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(false);
    expect(loadDayItems("daily_sleep", start, end)).toEqual([]);
  });
});
