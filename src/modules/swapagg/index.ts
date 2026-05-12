/**
 * Swap Aggregator Module (controller)
 * -----------------------------------
 * Exposes `/swapagg/*` endpoints that wrap KyberSwap's two-step
 * route + build flow into a single server-side call. Same privacy and
 * rate-limit posture as the rpc/prices modules: open CORS, salted-hash
 * client identity, no request logging.
 */

import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { rateLimit } from "elysia-rate-limit";
import { hashClientIp } from "../../lib/client-id";
import { SwapAggService } from "./service";
import { KyberSwapError } from "../../lib/swap/sdks/kyberswap/kyberswap";

// --- Configuration ---------------------------------------------------------

/**
 * Aggregator credentials. Read once at module load from `.env.local`
 * (Bun auto-loads it). Each is required so the process refuses to start
 * without all three — failing fast here is better than returning 500s at
 * runtime when a particular aggregator's path is hit.
 *
 * `0x_API_KEY` starts with a digit so we access it via the `process.env`
 * indexer and bind it to a TS-legal identifier.
 */
const KYBERSWAP_CLIENT_ID = process.env.KYBERSWAP_CLIENT_ID;
const UNISWAP_API_KEY = process.env.UNISWAP_API_KEY;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;

if (!KYBERSWAP_CLIENT_ID) {
  throw new Error("KYBERSWAP_CLIENT_ID is not set");
}
if (!UNISWAP_API_KEY) {
  throw new Error("UNISWAP_API_KEY is not set");
}
if (!ZEROX_API_KEY) {
  throw new Error("ZEROX_API_KEY is not set");
}

/**
 * Tighter limit than `/rpc` because each call here makes two upstream
 * requests to KyberSwap's aggregator. 10 per minute lets a typical user
 * iterate on their swap (re-quote on input change) without burning the
 * partner client-id quota.
 */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_DURATION_MS = 60_000;

/**
 * JSON body validator for `POST /swapagg/{chain}`. We use POST (not GET)
 * so wallet addresses and token amounts travel in the request body, where
 * they don't end up in access logs or leak via the Referer header. Body is
 * JSON, so numeric/boolean fields use plain `t.Number` / `t.Boolean`.
 */
const SwapAggBody = t.Object({
  tokenIn: t.String({ minLength: 1 }),
  tokenOut: t.String({ minLength: 1 }),
  amountIn: t.String({ minLength: 1 }),
  sender: t.String({ minLength: 1 }),
  recipient: t.String({ minLength: 1 }),
  slippageTolerance: t.Optional(t.Number({ minimum: 0, maximum: 2000 })),
  deadline: t.Optional(t.Number({ minimum: 0 })),
  origin: t.Optional(t.String()),
  source: t.Optional(t.String()),
  referral: t.Optional(t.String()),
  enableGasEstimation: t.Optional(t.Boolean()),
});

// --- Controller ------------------------------------------------------------

export const swapagg = new Elysia({ prefix: "/swapagg" })
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
  // POST /swapagg/ethereum — get the best route AND its calldata in one
  // round-trip. Returns the shared `SwapAggResult` envelope:
  //   { id, timestamp, routes: { kyberswap: { …slim view, raw } }, meta, status }
  // Each entry in `routes` holds the fields the frontend needs to broadcast
  // (`routerAddress`, `data`, `transactionValue`, …) and a `raw` field with
  // the untouched upstream payload, kept for future DB persistence.
  //
  // POST (not GET) so wallet addresses and amounts stay out of access logs
  // and Referer headers. Quotes are time-sensitive (gas/price/slippage),
  // so the response is marked uncacheable as well.
  .post(
    "/ethereum",
    async ({ body, set }) => {
      set.headers["cache-control"] = "no-store";
      try {
        return await SwapAggService.getSwap("ethereum", body);
      } catch (err) {
        // Translate KyberSwap's documented error codes into appropriate
        // HTTP statuses so the frontend can branch on them.
        if (err instanceof KyberSwapError) {
          set.status = err.status >= 400 && err.status < 600 ? err.status : 502;
          return {
            code: err.code,
            message: err.message,
            requestId: err.requestId,
          };
        }
        throw err;
      }
    },
    { body: SwapAggBody }
  );
