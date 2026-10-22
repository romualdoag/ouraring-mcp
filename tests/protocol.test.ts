import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");

function rpc(objects: unknown[], expectedResponses: number): Promise<{ lines: unknown[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [entry], {
      env: { ...process.env, OURARING_ACCESS_TOKEN: "test-token" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let errBuf = "";
    const lines: unknown[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("protocol timeout; got stdout: " + buf.slice(0, 2000) + " stderr: " + errBuf.slice(0, 2000)));
    }, 20_000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          lines.push(JSON.parse(line));
        } catch {
          /* ignore */
        }
        if (lines.length >= expectedResponses) {
          clearTimeout(timer);
          child.kill();
          resolve({ lines });
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      errBuf += d.toString();
    });
    for (const o of objects) child.stdin.write(JSON.stringify(o) + "\n");
  });
}

describe("stdio protocol (hermetic — no live upstream)", () => {
  it("handshake + tools/list + validation error", async () => {
    const { lines } = await rpc([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_collection", arguments: { collection: "nope" } } },
    ], 3);
    const byId = new Map(lines.map((l) => [(l as { id: number }).id, l] as const));
    expect(byId.has(1)).toBe(true);
    const list = byId.get(2) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["oura_status", "list_collections", "get_personal_info", "get_daily", "get_collection", "get_recent_summary"]) {
      expect(names).toContain(n);
    }
    const errCall = byId.get(3) as { result: { isError: boolean; content: { text: string }[] } };
    expect(errCall.result.isError).toBe(true);
    expect(errCall.result.content[0].text).toMatch(/Unknown collection/);
  }, 30_000);
});
