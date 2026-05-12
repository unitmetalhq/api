/**
 * SQLite + Drizzle setup
 * ----------------------
 * One process-wide DB handle backed by `bun:sqlite` (built into Bun, no
 * native addon to compile) wrapped with `drizzle-orm/bun-sqlite`.
 *
 * The file path is configurable via `DATABASE_PATH` so the dev/prod
 * deployments can point at different locations; defaults to `./data.db`
 * at the process cwd for local development.
 *
 * WAL mode is enabled so concurrent reads (the `/markets` route) don't
 * block on the cron-driven writer (`refreshMarkets`).
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as marketsSchema from "../modules/markets/schema";

const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data.db";

const sqlite = new Database(DATABASE_PATH, { create: true });
sqlite.run("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite, {
  schema: { ...marketsSchema },
});

export type DB = typeof db;
