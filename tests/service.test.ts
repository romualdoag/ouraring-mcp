import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  collectionPath,
  getDaily,
  getCollection,
  getRecentSummary,
  listCollections,
  ouraStatus,
  getAccessToken,
  setFetchForTests,
  resetFetch,
  OuraError,
} from "../src/service.js";

function fakeFetch(routes: Record<string, unknown>) {
  return (async (url: unknown) => {
    const u = String(url);
    const path = u.replace("https://api.ouraring.com", "").split("?")[0];
    const body = routes[path] ?? { data: [], next_token: null };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("offline unit", () => {
  beforeEach(() => {
    process.env.OURARING_ACCESS_TOKEN = "test-token";
    delete process.env.OURA_ACCESS_TOKEN;
  });
  afterEach(() => {
    resetFetch();
    delete process.env.OURARING_ACCESS_TOKEN;
  });

  it("prefers OURARING_ACCESS_TOKEN over OURA_ACCESS_TOKEN", () => {
    process.env.OURA_ACCESS_TOKEN = "other";
    expect(getAccessToken()).toBe("test-token");
  });

  it("falls back to OURA_ACCESS_TOKEN", () => {
    delete process.env.OURARING_ACCESS_TOKEN;
    process.env.OURA_ACCESS_TOKEN = "fallback";
    expect(getAccessToken()).toBe("fallback");
    delete process.env.OURA_ACCESS_TOKEN;
  });

  it("throws without credentials", () => {
    delete process.env.OURARING_ACCESS_TOKEN;
    delete process.env.OURA_ACCESS_TOKEN;
    expect(() => getAccessToken()).toThrow(OuraError);
  });

  it("rejects unknown daily type", async () => {
    await expect(getDaily("nope")).rejects.toThrow(/Unknown daily type/);
  });

  it("rejects bad dates", async () => {
    await expect(getDaily("sleep", { start_date: "15/10/2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("rejects unknown collection", async () => {
    await expect(getCollection("nope")).rejects.toThrow(/Unknown collection/);
  });

  it("getDaily paginates and caps with limit", async () => {
    let calls = 0;
    setFetchForTests((async () => {
      calls++;
      const body =
        calls === 1
          ? { data: [{ day: "2026-10-20" }, { day: "2026-10-21" }], next_token: "abc" }
          : { data: [{ day: "2026-10-22" }], next_token: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch);
    // limit=1: first page already exceeds the cap → single item, truncated
    const capped = await getDaily("sleep", { limit: 1 });
    expect(capped.items).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect(calls).toBe(1);
    // no limit: follows next_token and merges both pages
    calls = 0;
    const full = await getDaily("sleep", {});
    expect(full.total).toBe(3);
    expect(full.truncated).toBe(false);
    expect(calls).toBe(2);
  });

  it("maps 401 to credentials error", async () => {
    setFetchForTests(
      (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
    );
    await expect(getDaily("sleep")).rejects.toThrow(/credentials/i);
  });

  it("getRecentSummary joins five dailies (incl. spo2)", async () => {
    setFetchForTests(
      fakeFetch({
        "/v2/usercollection/daily_sleep": { data: [{ day: "2026-10-22", score: 80 }], next_token: null },
        "/v2/usercollection/daily_readiness": { data: [{ day: "2026-10-22", score: 75 }], next_token: null },
        "/v2/usercollection/daily_activity": { data: [{ day: "2026-10-22", score: 90 }], next_token: null },
        "/v2/usercollection/daily_stress": { data: [], next_token: null },
        "/v2/usercollection/daily_spo2": { data: [{ day: "2026-10-22" }], next_token: null },
      }),
    );
    const res = await getRecentSummary(7);
    expect(res.counts).toMatchObject({ daily_sleep: 1, daily_readiness: 1, daily_activity: 1, daily_spo2: 1 });
  });

  it("listCollections covers the OAuth form scopes", () => {
    const names = listCollections().map((c) => c.collection);
    for (const c of ["daily_sleep", "workout", "heartrate", "session", "tag", "daily_spo2", "ring_configuration"]) {
      expect(names).toContain(c);
    }
  });

  it("ouraStatus reports oauth client from OURARING_*", async () => {
    process.env.OURARING_CLIENT_ID = "id";
    process.env.OURARING_CLIENT_SECRET = "secret";
    const s = await ouraStatus();
    expect(s.oauth_client_configured).toBe(true);
    delete process.env.OURARING_CLIENT_ID;
    delete process.env.OURARING_CLIENT_SECRET;
  });

  it("collectionPath uses spec-exact case (vO2_max)", () => {
    expect(collectionPath("vo2_max")).toBe("/v2/usercollection/vO2_max");
    expect(collectionPath("VO2_MAX")).toBe("/v2/usercollection/vO2_max");
    expect(collectionPath("sleep")).toBe("/v2/usercollection/sleep");
    expect(() => collectionPath("nope")).toThrow(OuraError);
  });

  it("listCollections exposes exact paths", () => {
    const byName = new Map(listCollections().map((c) => [c.collection, c.path]));
    expect(byName.get("vo2_max")).toBe("/v2/usercollection/vO2_max");
    expect(byName.size).toBe(19);
  });

  it("routes datetime params for ring_battery_level, none for ring_configuration", async () => {
    const seen: string[] = [];
    setFetchForTests((async (url: unknown) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ data: [], next_token: null }), { status: 200 });
    }) as typeof fetch);
    await getCollection("ring_battery_level", { start_datetime: "2026-10-21T00:00:00-04:00" });
    expect(seen[0]).toContain("start_datetime=2026-10-21");
    expect(seen[0]).not.toContain("start_date=");
    await getCollection("ring_configuration", { start_date: "2026-10-21", end_date: "2026-10-22" });
    expect(seen[1]).not.toContain("start_date=");
    await getCollection("vo2_max", { start_date: "2026-10-21", end_date: "2026-10-22" });
    expect(seen[2]).toContain("/v2/usercollection/vO2_max?");
  });

  it("rejects document_id where the API has no doc variant", async () => {
    await expect(getCollection("enhanced_tag", { document_id: "x" })).rejects.toThrow(/no single-document endpoint/);
    await expect(getCollection("heartrate", { document_id: "x" })).rejects.toThrow(/no single-document endpoint/);
    await expect(getCollection("ring_battery_level", { document_id: "x" })).rejects.toThrow(/no single-document endpoint/);
  });

  it("validates fields support per route", async () => {
    await expect(getDaily("resilience", { fields: "score" })).rejects.toThrow(/does not support field selection/);
    await expect(getCollection("tag", { fields: "tag_type" })).rejects.toThrow(/does not support field selection/);
    const seen: string[] = [];
    setFetchForTests((async (url: unknown) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ data: [], next_token: null }), { status: 200 });
    }) as typeof fetch);
    await getDaily("sleep", { fields: "score" });
    expect(seen[0]).toContain("fields=score");
  });
});
