/**
 * Prices Module (controller)
 * --------------------------
 * Exposes `/prices/*` endpoints that return on-chain price data for
 * curated token lists. Currently serves only Ethereum mainnet.
 *
 * Privacy posture mirrors the rpc module: CORS open, per-client rate
 * limiting keyed on a salted hash of the IP (raw IPs never touch the
 * rate-limit store), and no request logging.
 */

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { rateLimit } from "elysia-rate-limit";
import { hashClientIp } from "../../lib/client-id";
import { PricesService } from "./service";

// --- Configuration ---------------------------------------------------------

/**
 * Rate-limit tunables for the prices endpoints. Prices update only as
 * fast as blocks (~12s on Ethereum), so 20 req/min per client is plenty
 * — a frontend realistically wants one poll every 10–30s.
 */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_DURATION_MS = 60_000;

// --- Controller ------------------------------------------------------------

export const prices = new Elysia({ prefix: "/prices" })
  // CORS first so OPTIONS preflights are short-circuited before they
  // consume a client's rate-limit budget.
  .use(cors({ origin: true, credentials: false }))
  .use(
    rateLimit({
      max: RATE_LIMIT_MAX,
      duration: RATE_LIMIT_DURATION_MS,
      // Confine to this module — don't leak the limiter onto other routes.
      scoping: "scoped",
      // Include failed requests in the count to prevent abuse via
      // deliberately-erroring calls.
      countFailedRequest: true,
      // Same salted-hash identifier used by the rpc module (see
      // src/lib/client-id.ts). The LRU store sees opaque digests only.
      generator: (request, server) => {
        const ip = server?.requestIP(request)?.address;
        return ip ? hashClientIp(ip) : "";
      },
    })
  )
  // GET /prices/ethereum — returns an array of { address, symbol, name,
  // decimals, logoURI, price } for every Ethereum-mainnet token in the
  // bundled token list. `price` is the human-readable USD string from
  // CheckTheChain, or null if that token's on-chain call failed.
  .get("/ethereum", () => PricesService.getEthereumPrices());
