import { describe, expect, it } from "vitest";
import { getCollection, getPersonalInfo } from "../src/service.js";

// Opt-in live tests: only run with real credentials. Otherwise pass with a note.
const token = process.env.OURARING_ACCESS_TOKEN || process.env.OURA_ACCESS_TOKEN;

describe("live (opt-in)", () => {
  it("personal_info with real credentials", async () => {
    if (!token) {
      console.log("SKIP live: set OURARING_ACCESS_TOKEN to hit api.ouraring.com");
      expect(true).toBe(true);
      return;
    }
    const res = await getPersonalInfo(token);
    expect(res).toBeTruthy();
  }, 60_000);

  it("vO2_max exact-case path + ring_battery_level datetime route", async () => {
    if (!token) {
      console.log("SKIP live: set OURARING_ACCESS_TOKEN to hit api.ouraring.com");
      expect(true).toBe(true);
      return;
    }
    const v = await getCollection("vo2_max", { start_date: "2026-09-22", end_date: "2026-10-22" }, token);
    expect(v.collection).toBe("vo2_max");
    const b = await getCollection(
      "ring_battery_level",
      { start_datetime: "2026-10-21T00:00:00-04:00" },
      token,
    );
    expect(b.collection).toBe("ring_battery_level");
  }, 60_000);
});
