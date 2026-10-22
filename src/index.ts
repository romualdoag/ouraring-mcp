#!/usr/bin/env node
/**
 * ouraring-mcp — read your own Oura Ring data through MCP.
 *
 * Personal, single-user, non-commercial. Data is fetched on demand
 * from api.ouraring.com and never stored by this server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getCollection,
  getDaily,
  getPersonalInfo,
  getRecentSummary,
  listCollections,
  ouraStatus,
  DAILY_TYPES,
  DETAIL_COLLECTIONS,
} from "./service.js";

const server = new McpServer({ name: "ouraring-mcp", version: "0.3.0" });

type Ok = { content: [{ type: "text"; text: string }] };
type Err = { content: [{ type: "text"; text: string }]; isError: true };

const asText = (obj: unknown): Ok => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});
const asError = (err: unknown): Err => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});
async function safe(fn: () => Promise<unknown>): Promise<Ok | Err> {
  try {
    return asText(await fn());
  } catch (err) {
    return asError(err);
  }
}

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Calendar date YYYY-MM-DD.");
const limitParam = z
  .number()
  .int()
  .positive()
  .max(10000)
  .optional()
  .describe("Max items (default 50).");
const fieldsParam = z
  .string()
  .optional()
  .describe("Comma-separated field selector (most routes; not daily_resilience/enhanced_tag/tag).");

server.registerTool(
  "oura_status",
  {
    description: "Check whether Oura credentials are configured (no network call).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => safe(() => ouraStatus()),
);

server.registerTool(
  "list_collections",
  {
    description: "List every Oura collection this server can read, with the OAuth scope each needs.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => safe(async () => listCollections()),
);

server.registerTool(
  "get_personal_info",
  {
    description: "Your Oura profile (age, weight, height, email). Scopes: personal, email.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => safe(() => getPersonalInfo()),
);

server.registerTool(
  "get_daily",
  {
    description:
      "Daily summaries for sleep, readiness, activity, stress, spo2, resilience or cardiovascular_age. Best for questions like 'how did I sleep this week?'.",
    inputSchema: {
      data_type: z.enum(DAILY_TYPES as unknown as [string, ...string[]]).describe("Which daily summary."),
      start_date: dateParam,
      end_date: dateParam,
      limit: limitParam,
      fields: fieldsParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ data_type, start_date, end_date, limit, fields }) =>
    safe(() => getDaily(data_type, { start_date, end_date, limit, fields })),
);

server.registerTool(
  "get_collection",
  {
    description:
      "Read any Oura v2 collection: sleep sessions, workouts, guided sessions, tags, heartrate samples, sleep_time, rest_mode_period, ring_configuration, vo2_max, or daily_* summaries. One document via document_id, or a date range.",
    inputSchema: {
      collection: z
        .string()
        .describe(
          `Collection name — one of: ${(DETAIL_COLLECTIONS as readonly string[]).join(", ")}, daily_sleep, daily_readiness, daily_activity, daily_stress, daily_spo2, daily_resilience, daily_cardiovascular_age, personal_info.`,
        ),
      start_date: dateParam,
      end_date: dateParam,
      start_datetime: z.string().optional().describe("Heartrate and ring_battery_level: ISO datetime, e.g. 2026-10-15T00:00:00Z."),
      end_datetime: z.string().optional().describe("Heartrate and ring_battery_level: ISO datetime."),
      latest: z.boolean().optional().describe("Heartrate and ring_battery_level: return the most recent sample."),
      document_id: z.string().optional().describe("Fetch one document by id (not for enhanced_tag/heartrate/personal_info/ring_battery_level)."),
      limit: limitParam,
      fields: fieldsParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ collection, start_date, end_date, start_datetime, end_datetime, latest, document_id, limit, fields }) =>
    safe(() =>
      getCollection(collection, {
        start_date,
        end_date,
        start_datetime,
        end_datetime,
        latest,
        document_id,
        limit,
        fields,
      }),
    ),
);

server.registerTool(
  "get_recent_summary",
  {
    description:
      "One-call overview of the last N days (sleep + readiness + activity + stress + spo2 daily summaries) for natural-language summaries like 'how was my week?'.",
    inputSchema: {
      days: z.number().int().min(1).max(90).optional().describe("Recent calendar days (default 7, max 90)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ days }) => safe(() => getRecentSummary(days ?? 7)),
);

await server.connect(new StdioServerTransport());
