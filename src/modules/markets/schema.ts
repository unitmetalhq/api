/**
 * Drizzle schema for the cached CoinGecko market snapshot.
 *
 * One row per curated coin (see `src/config/markets.ts`). The cron job in
 * this module refreshes the table every 5 minutes; `/markets` reads from
 * it. Frequently-queried fields are flattened into columns; everything
 * else from the upstream payload is preserved verbatim in `raw` so we
 * can add columns later without losing historical data.
 */

import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const markets = sqliteTable("markets", {
  /** CoinGecko coin id, e.g. "bitcoin". Stable across renames. */
  coinId: text("coin_id").primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  image: text("image"),

  currentPrice: real("current_price"),
  marketCap: real("market_cap"),
  marketCapRank: integer("market_cap_rank"),
  fullyDilutedValuation: real("fully_diluted_valuation"),
  totalVolume: real("total_volume"),
  high24h: real("high_24h"),
  low24h: real("low_24h"),
  priceChange24h: real("price_change_24h"),
  priceChangePercentage24h: real("price_change_percentage_24h"),
  marketCapChange24h: real("market_cap_change_24h"),
  marketCapChangePercentage24h: real("market_cap_change_percentage_24h"),
  /**
   * Only populated when the upstream call is made with
   * `price_change_percentage=1h` (the current refresh job does so). Null
   * for any row written before that param was added.
   */
  priceChangePercentage1hInCurrency: real("price_change_percentage_1h_in_currency"),

  circulatingSupply: real("circulating_supply"),
  totalSupply: real("total_supply"),
  maxSupply: real("max_supply"),

  /**
   * All-time high block. `athDate`/`atlDate` are kept as the upstream
   * ISO-8601 strings — they're informational and we don't want to lose
   * sub-second precision through a `Date` round-trip.
   */
  ath: real("ath"),
  athChangePercentage: real("ath_change_percentage"),
  athDate: text("ath_date"),
  atl: real("atl"),
  atlChangePercentage: real("atl_change_percentage"),
  atlDate: text("atl_date"),

  /**
   * Return on investment vs. an early reference (CoinGecko's own metric).
   * Almost always null; when present it's `{ times, currency, percentage }`,
   * so storing as a nested JSON blob beats three sparse columns.
   */
  roi: text("roi", { mode: "json" }).$type<{
    times?: number;
    currency?: string;
    percentage?: number;
  } | null>(),

  /** ISO-8601 timestamp from CoinGecko marking the upstream sample time. */
  lastUpdated: text("last_updated"),

  /**
   * Full upstream row as JSON. Lets `/markets` expose any field we forgot
   * to flatten and gives us a free audit trail of what CoinGecko returned.
   */
  raw: text("raw", { mode: "json" }).$type<Record<string, unknown>>(),

  /**
   * Unix epoch ms when we wrote this row. Defaults to "now" on insert via
   * a SQLite expression so we don't need to plumb a timestamp through
   * every upsert site.
   */
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
