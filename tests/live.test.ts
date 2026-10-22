import { describe, expect, it } from "vitest";
import { getPersonalInfo } from "../src/service.js";

// Opt-in live test: only runs with a real token. Otherwise passes with a note.
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
});
