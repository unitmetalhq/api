/**
 * Runtime migration runner using `bun:sqlite`
 * -------------------------------------------
 * `drizzle-kit migrate` only knows how to talk to SQLite via `better-sqlite3`
 * or `@libsql/client`, which means it can't run inside the compiled
 * `bun build --compile` binary. This script applies the same migrations
 * (the SQL files in `./drizzle/`) through `bun:sqlite`, which is built
 * into Bun and ships inside the binary for free.
 *
 * Reuses the shared `db` handle from `src/lib/db.ts` so the connection
 * (path, WAL mode) is configured identically to runtime.
 *
 * Run with:
 *   bun --env-file=.env.local run src/script/migrate.ts
 *
 * In production you can call this once before booting the API, or import
 * it from `src/index.ts` to self-migrate on startup.
 */

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "../lib/db";

migrate(db, { migrationsFolder: "./drizzle" });

console.log("migrations applied");
