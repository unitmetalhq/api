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

export interface SwapAggResponse {
  routeSummary: RouteSummary;
  routerAddress: string;
  build: BuildRouteData;
}

export abstract class SwapAggService {
  static async getSwap(
    chain: KyberSwapChain,
    req: SwapAggRequest
  ): Promise<SwapAggResponse> {
    const route = await kyberSwapClient.getRoute(
      {
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        // Pass the user's wallet through as `origin` if they didn't supply
        // one — gives access to RFQ liquidity and avoids the limiter that
        // KyberSwap applies per-`sender`.
        origin: req.origin ?? req.sender,
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

    return {
      routeSummary: route.routeSummary,
      routerAddress: route.routerAddress,
      build,
    };
  }
}
