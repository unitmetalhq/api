/**
 * MarketsService
 * --------------
 * Owns the curated CoinGecko market cache.
 *
 *   refreshMarkets()  — pulls the curated id list from CoinGecko and
 *                       upserts the rows into SQLite. Called by the cron
 *                       tick in `index.ts` and once at boot from `src/index.ts`.
 *   getMarkets()      — reads the cached rows back out, ordered by market-cap
 *                       rank. The HTTP route is just a passthrough to this.
 *
 * CoinGecko is only ever touched by `refreshMarkets`; the request path
 * never makes an upstream call. That's the whole point of the cache —
 * `/markets` stays fast and decoupled from CoinGecko's rate limit.
 */

import Coingecko from "@coingecko/coingecko-typescript";
import { asc } from "drizzle-orm";
import { db } from "../../lib/db";
import { marketsConfig } from "../../config/markets";
import { markets, type NewMarket } from "./schema";

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

if (!COINGECKO_API_KEY) {
  throw new Error("COINGECKO_API_KEY is not set");
}

/**
 * Single shared client. Holds no per-request state, so reusing one instance
 * across cron ticks (and the cold-start refresh) is safe.
 */
const coingecko = new Coingecko({
  demoAPIKey: COINGECKO_API_KEY,
  environment: "demo",
});

/**
 * CoinGecko's typed `MarketGetResponseItem` is conservative — it omits
 * fields like `price_change_percentage_1h_in_currency` (which only appears
 * when the `price_change_percentage` query param is sent). Extend the
 * upstream type locally so the row mapper can read those without `any`.
 */
type CoingeckoMarket =
  Coingecko.Coins.MarketGetResponse.MarketGetResponseItem & {
    price_change_percentage_1h_in_currency?: number | null;
  };

/**
 * Map a CoinGecko market row onto our schema. We keep the full upstream
 * row on `raw` so any field we forgot to flatten (or that CoinGecko adds
 * later) is still recoverable without re-fetching.
 */
function toRow(m: CoingeckoMarket): NewMarket | null {
  if (!m.id || !m.symbol || !m.name) return null;
  return {
    coinId: m.id,
    symbol: m.symbol,
    name: m.name,
    image: m.image ?? null,
    currentPrice: m.current_price ?? null,
    marketCap: m.market_cap ?? null,
    marketCapRank: m.market_cap_rank ?? null,
    fullyDilutedValuation: m.fully_diluted_valuation ?? null,
    totalVolume: m.total_volume ?? null,
    high24h: m.high_24h ?? null,
    low24h: m.low_24h ?? null,
    priceChange24h: m.price_change_24h ?? null,
    priceChangePercentage24h: m.price_change_percentage_24h ?? null,
    marketCapChange24h: m.market_cap_change_24h ?? null,
    marketCapChangePercentage24h: m.market_cap_change_percentage_24h ?? null,
    priceChangePercentage1hInCurrency:
      m.price_change_percentage_1h_in_currency ?? null,
    circulatingSupply: m.circulating_supply ?? null,
    totalSupply: m.total_supply ?? null,
    maxSupply: m.max_supply ?? null,
    ath: m.ath ?? null,
    athChangePercentage: m.ath_change_percentage ?? null,
    athDate: m.ath_date ?? null,
    atl: m.atl ?? null,
    atlChangePercentage: m.atl_change_percentage ?? null,
    atlDate: m.atl_date ?? null,
    roi: m.roi ?? null,
    lastUpdated: m.last_updated ?? null,
    raw: m as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
}

export abstract class MarketsService {
  /**
   * Pull the curated coin list from CoinGecko and upsert into SQLite.
   *
   * CoinGecko's `/coins/markets` accepts a comma-separated `ids` param
   * and returns up to 250 rows in one call. Our curated list is well
   * below that, so a single call covers the whole set. If the list ever
   * grows past 250, this needs to chunk.
   */
  static async refreshMarkets(): Promise<{
    fetched: number;
    written: number;
  }> {
    if (marketsConfig.coinIds.length === 0) {
      return { fetched: 0, written: 0 };
    }

    if (marketsConfig.coinIds.length > 250) {
      throw new Error(
        `marketsConfig.coinIds has ${marketsConfig.coinIds.length} entries; ` +
          `/coins/markets caps at 250 per call — split into pages.`
      );
    }

    const data = await coingecko.coins.markets.get({
      vs_currency: "usd",
      ids: marketsConfig.coinIds.join(","),
      per_page: 250,
      page: 1,
      order: "market_cap_desc",
      // Adds `price_change_percentage_1h_in_currency` to each row. Other
      // timeframes (`24h,7d,30d,…`) can be appended later — the schema's
      // `raw` column already preserves any extra fields verbatim.
      price_change_percentage: "1h",
    });

    const rows = data.map(toRow).filter((r): r is NewMarket => r !== null);
    if (rows.length === 0) return { fetched: data.length, written: 0 };

    // One upsert per row, all inside a single transaction so a partial
    // failure mid-batch leaves the table in its previous coherent state.
    db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(markets)
          .values(row)
          .onConflictDoUpdate({
            target: markets.coinId,
            set: {
              symbol: row.symbol,
              name: row.name,
              image: row.image,
              currentPrice: row.currentPrice,
              marketCap: row.marketCap,
              marketCapRank: row.marketCapRank,
              fullyDilutedValuation: row.fullyDilutedValuation,
              totalVolume: row.totalVolume,
              high24h: row.high24h,
              low24h: row.low24h,
              priceChange24h: row.priceChange24h,
              priceChangePercentage24h: row.priceChangePercentage24h,
              marketCapChange24h: row.marketCapChange24h,
              marketCapChangePercentage24h: row.marketCapChangePercentage24h,
              priceChangePercentage1hInCurrency:
                row.priceChangePercentage1hInCurrency,
              circulatingSupply: row.circulatingSupply,
              totalSupply: row.totalSupply,
              maxSupply: row.maxSupply,
              ath: row.ath,
              athChangePercentage: row.athChangePercentage,
              athDate: row.athDate,
              atl: row.atl,
              atlChangePercentage: row.atlChangePercentage,
              atlDate: row.atlDate,
              roi: row.roi,
              lastUpdated: row.lastUpdated,
              raw: row.raw,
              updatedAt: row.updatedAt,
            },
          })
          .run();
      }
    });

    return { fetched: data.length, written: rows.length };
  }

  /**
   * Read the cached market snapshot, ordered by market-cap rank ascending
   * (highest-cap first). Rows with no rank fall to the end via the
   * `nullsLast` ordering in SQLite (which is the default for ASC).
   */
  static getMarkets() {
    return db.select().from(markets).orderBy(asc(markets.marketCapRank)).all();
  }
}
