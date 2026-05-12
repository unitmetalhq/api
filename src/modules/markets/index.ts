/**
 * Markets Module (controller)
 * ---------------------------
 * Exposes `GET /markets`, a cached CoinGecko snapshot for the curated coin
 * list defined in `src/config/markets.ts`.
 *
 * A `@elysia/cron` job runs every 5 minutes and calls
 * `MarketsService.refreshMarkets()` to upsert into SQLite. The HTTP route
 * only reads from the table — it never touches CoinGecko — so request
 * latency is decoupled from upstream and from CoinGecko's rate limit.
 *
 * Cold start: the cron's first tick fires ~5 min after boot, so
 * `src/index.ts` awaits one `refreshMarkets()` call before `.listen()` to
 * make sure `/markets` returns rows immediately.
 *
 * Privacy posture mirrors the other modules: open CORS, salted-hash
 * client identity in the rate limiter, no request logging.
 */

import { Elysia } from "elysia";
import { cron } from "@elysia/cron";
import { cors } from "@elysiajs/cors";
import { rateLimit } from "elysia-rate-limit";
import { hashClientIp } from "../../lib/client-id";
import { MarketsService } from "./service";

// --- Configuration ---------------------------------------------------------

/**
 * CoinGecko credentials. Read once at module load from `.env.local` (Bun
 * auto-loads it) and asserted here so the process refuses to start
 * without them — failing fast at boot is better than the cron tick
 * silently throwing 5 minutes after the server is "up".
 */
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

if (!COINGECKO_API_KEY) {
  throw new Error("COINGECKO_API_KEY is not set");
}

/**
 * Same per-client budget as `/prices`. The cron writes every 5 minutes so
 * a polling frontend cannot get fresher data by hammering the route — 20
 * req/min is plenty for any realistic UI cadence.
 */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_DURATION_MS = 60_000;

/**
 * Five-minute cron pattern. CoinGecko market data refreshes ~once/minute
 * upstream and the demo tier is ~30 calls/min — going faster costs quota
 * without buying meaningfully fresher prices.
 */
const REFRESH_CRON_PATTERN = "*/5 * * * *";

// --- Controller ------------------------------------------------------------

export const markets = new Elysia({ prefix: "/markets" })
  .use(cors({ origin: true, credentials: false }))
  .use(
    rateLimit({
      max: RATE_LIMIT_MAX,
      duration: RATE_LIMIT_DURATION_MS,
      scoping: "scoped",
      countFailedRequest: true,
      generator: (request, server) => {
        const ip = server?.requestIP(request)?.address;
        return ip ? hashClientIp(ip) : "";
      },
    })
  )
  .use(
    cron({
      name: "refresh-markets",
      pattern: REFRESH_CRON_PATTERN,
      // Swallow errors so a transient CoinGecko hiccup doesn't kill the
      // cron schedule. The next tick will retry on its own; the table
      // keeps serving its last-known-good snapshot in the meantime.
      run: async () => {
        try {
          await MarketsService.refreshMarkets();
        } catch (err) {
          console.error("[markets] refresh failed:", err);
        }
      },
    })
  )
  // GET /markets — returns the cached snapshot ordered by market-cap rank.
  // Reads from SQLite only; never hits CoinGecko on the request path.
  .get("/", () => MarketsService.getMarkets());
