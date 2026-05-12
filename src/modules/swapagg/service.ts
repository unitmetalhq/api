/**
 * SwapAggService
 * --------------
 * Two-step KyberSwap orchestration: fetch the best route preview, then
 * build the calldata, returning both to the caller in a single response.
 *
 *   1. GET  /{chain}/api/v1/routes        — picks the route, returns routeSummary
 *   2. POST /{chain}/api/v1/route/build   — encodes calldata for that route
 *
 * Doing both server-side hides KyberSwap's two-step flow from the frontend
 * and keeps the `X-Client-Id` (and the rate-limit budget tied to it) on the
 * server. The frontend submits one request and receives everything it needs
 * to broadcast the swap transaction.
 */

import {
  KyberSwapClient,
  type BuildRouteData,
  type KyberSwapChain,
  type RouteSummary,
} from "../../lib/swap/sdks/kyberswap/kyberswap";
import { kyberswapConfig } from "../../config/kyberswap";

const KYBERSWAP_CLIENT_ID = process.env.KYBERSWAP_CLIENT_ID;

if (!KYBERSWAP_CLIENT_ID) {
  throw new Error("KYBERSWAP_CLIENT_ID is not set");
}

/**
 * Single shared client. The wrapper holds no per-request state, so reusing
 * one instance across requests is safe and avoids re-allocating fetch state.
 */
const kyberSwapClient = new KyberSwapClient({
  clientId: KYBERSWAP_CLIENT_ID,
});

export interface SwapAggRequest {
  /** Input token address. Zero address = native ETH (auto-translated). */
  tokenIn: string;
  /** Output token address. Zero address = native ETH (auto-translated). */
  tokenOut: string;
  /** Input amount in token base units (wei). */
  amountIn: string;
  /** Address the input tokens will be transferred from. */
  sender: string;
  /** Address that will receive the output tokens. */
  recipient: string;
  /** Slippage tolerance in bps (10 = 0.1%, range 0–2000). */
  slippageTolerance?: number;
  /** Unix epoch seconds. Default: KyberSwap uses now + 20 minutes. */
  deadline?: number;
  /** End-user wallet — unlocks RFQ liquidity if `sender` is a fixed router. */
  origin?: string;
  /** Tag recorded on-chain in the swap event. */
  source?: string;
  referral?: string;
  /** Have KyberSwap simulate the tx via eth_estimateGas before returning. */
  enableGasEstimation?: boolean;
}

/**
 * Per-aggregator slim view returned to the frontend. Carries only what a
 * client needs to display the quote and broadcast the transaction. The full
 * upstream response is preserved on `raw` so we can persist it later for
 * support / analytics without changing the public shape.
 */
export interface SwapAggRoute {
  /** Aggregator identifier, e.g. "kyberswap". */
  name: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  amountInUsd?: string;
  amountOutUsd?: string;
  /**
   * Price impact in basis points: `round((1 - amountOutUsd / amountInUsd) * 10000)`,
   * clamped at 0. Undefined when the aggregator's USD reference is missing
   * or zero. Independent from `gas`/`gasUsd` — wallets override gas anyway,
   * so the frontend should present them as separate signals.
   */
  priceImpactBps?: number;
  gas?: string;
  gasUsd?: string;
  /** Contract to send the swap transaction to. */
  routerAddress: string;
  /** Encoded calldata to submit to `routerAddress`. */
  data: string;
  /** `msg.value` to attach (non-zero only for native-token swaps). */
  transactionValue: string;
  /** Full upstream response — kept verbatim for later DB persistence. */
  raw: unknown;
}

export type SwapAggStatus = "success" | "partial" | "failed";

/**
 * Shared envelope for any swap-aggregator response. `routes` is keyed by
 * aggregator name so the frontend (and future scoring logic) can compare
 * quotes from different sources.
 */
export interface SwapAggResult {
  /** Unique id for this quote attempt. */
  id: string;
  /** Unix epoch ms when the response was assembled. */
  timestamp: number;
  /** Aggregator-name → slim route. Currently only "kyberswap". */
  routes: Record<string, SwapAggRoute>;
  meta: {
    chain: KyberSwapChain;
    request: SwapAggRequest;
  };
  /**
   * Aggregate outcome:
   *   - "success": at least one route succeeded.
   *   - "partial": some aggregators failed but others returned a route.
   *   - "failed":  no aggregator returned a usable route.
   */
  status: SwapAggStatus;
}

/** Raw KyberSwap payload retained on `route.raw` for future persistence. */
interface KyberSwapRaw {
  routeSummary: RouteSummary;
  routerAddress: string;
  build: BuildRouteData;
}

/**
 * Price impact in bps from the aggregator's USD-denominated input/output.
 * Returns `undefined` when the USD reference is missing or zero (e.g. exotic
 * tokens with no oracle). Negative values (output worth more than input,
 * possible from arbitrage routes or oracle drift) are clamped to 0 so the
 * frontend can treat the field as a non-negative "loss to depth" signal.
 */
function computePriceImpactBps(
  amountInUsd: string | undefined,
  amountOutUsd: string | undefined
): number | undefined {
  const inUsd = Number(amountInUsd);
  const outUsd = Number(amountOutUsd);
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd <= 0) {
    return undefined;
  }
  return Math.max(0, Math.round((1 - outUsd / inUsd) * 10_000));
}

export abstract class SwapAggService {
  static async getSwap(
    chain: KyberSwapChain,
    req: SwapAggRequest
  ): Promise<SwapAggResult> {
    const route = await kyberSwapClient.getRoute(
      {
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        // Pass the user's wallet through as `origin` if they didn't supply
        // one — gives access to RFQ liquidity and avoids the limiter that
        // KyberSwap applies per-`sender`.
        origin: req.origin ?? req.sender,
        feeAmount: kyberswapConfig.feeAmount,
        chargeFeeBy: kyberswapConfig.chargeFeeBy,
        isInBps: kyberswapConfig.isInBps,
        feeReceiver: kyberswapConfig.feeReceiver,
      },
      { chain }
    );

    const build = await kyberSwapClient.buildRoute(
      {
        routeSummary: route.routeSummary,
        sender: req.sender,
        recipient: req.recipient,
        origin: req.origin,
        deadline: req.deadline,
        slippageTolerance: req.slippageTolerance,
        source: req.source,
        referral: req.referral,
        enableGasEstimation: req.enableGasEstimation,
      },
      { chain }
    );

    const kyberRaw: KyberSwapRaw = {
      routeSummary: route.routeSummary,
      routerAddress: route.routerAddress,
      build,
    };

    const kyberRoute: SwapAggRoute = {
      name: "kyberswap",
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: build.amountIn,
      amountOut: build.amountOut,
      amountInUsd: build.amountInUsd,
      amountOutUsd: build.amountOutUsd,
      priceImpactBps: computePriceImpactBps(build.amountInUsd, build.amountOutUsd),
      gas: build.gas,
      gasUsd: build.gasUsd,
      routerAddress: build.routerAddress,
      data: build.data,
      transactionValue: build.transactionValue,
      raw: kyberRaw,
    };

    return {
      id: Bun.randomUUIDv7(),
      timestamp: Date.now(),
      routes: { kyberswap: kyberRoute },
      meta: { chain, request: req },
      status: "success",
    };
  }
}
