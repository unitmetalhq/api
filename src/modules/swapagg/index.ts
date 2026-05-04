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
 * Tighter limit than `/rpc` because each call here makes two upstream
 * requests to KyberSwap's aggregator. 10 per minute lets a typical user
 * iterate on their swap (re-quote on input change) without burning the
 * partner client-id quota.
 */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_DURATION_MS = 60_000;

/**
 * Query-string validator for `GET /swapagg/{chain}`. Query params arrive as
 * strings, so numeric/boolean fields use `t.Numeric` / `t.BooleanString`,
 * which coerce `"50"` → `50` and `"true"` → `true` during validation.
 */
const SwapAggQuery = t.Object({
  tokenIn: t.String({ minLength: 1 }),
  tokenOut: t.String({ minLength: 1 }),
  amountIn: t.String({ minLength: 1 }),
  sender: t.String({ minLength: 1 }),
  recipient: t.String({ minLength: 1 }),
  slippageTolerance: t.Optional(t.Numeric({ minimum: 0, maximum: 2000 })),
  deadline: t.Optional(t.Numeric({ minimum: 0 })),
  origin: t.Optional(t.String()),
  source: t.Optional(t.String()),
  referral: t.Optional(t.String()),
  enableGasEstimation: t.Optional(t.BooleanString()),
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
  // GET /swapagg/ethereum — get the best route AND its calldata in one
  // round-trip. Returns { routeSummary, routerAddress, build }, where
  // `build.data` is the calldata to submit to `build.routerAddress` and
  // `build.transactionValue` is the `msg.value` to attach.
  //
  // Quotes are time-sensitive (gas/price/slippage), so the response is
  // marked uncacheable to prevent stale quotes from intermediaries.
  .get(
    "/ethereum",
    async ({ query, set }) => {
      set.headers["cache-control"] = "no-store";
      try {
        return await SwapAggService.getSwap("ethereum", query);
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
    { query: SwapAggQuery }
  );
