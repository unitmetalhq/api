/**
 * Request and response shapes for the /swapagg/* endpoints.
 *
 * Standalone — no server-only imports — so this file can be copy-pasted
 * verbatim into the frontend repo. Keep in sync with the runtime source of
 * truth in `src/modules/swapagg/service.ts`.
 */

/**
 * Chain slug accepted on the path of `POST /swapagg/{chain}`. The trailing
 * `(string & {})` member preserves autocomplete for the named chains while
 * still accepting any future slug without a type bump.
 */
export type SwapAggChain =
  | "ethereum"
  | "bsc"
  | "polygon"
  | "polygon-zkevm"
  | "arbitrum"
  | "optimism"
  | "avalanche"
  | "base"
  | "fantom"
  | "cronos"
  | "scroll"
  | "linea"
  | "blast"
  | "mantle"
  | "zksync"
  | "berachain"
  | "sonic"
  | "ronin"
  // deno-lint-ignore ban-types
  | (string & {});

/**
 * JSON body for `POST /swapagg/{chain}`. Send as `Content-Type: application/json`.
 * POST (not GET) is used so wallet addresses and amounts don't end up in
 * access logs or the Referer header.
 */
export type SwapAggRequest = {
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
  /** Unix epoch seconds. Default: aggregator-side, typically now + 20 minutes. */
  deadline?: number;
  /** End-user wallet — unlocks RFQ liquidity if `sender` is a fixed router. */
  origin?: string;
  /** Tag recorded on-chain in the swap event. */
  source?: string;
  referral?: string;
  /** Have the aggregator simulate via eth_estimateGas before returning. */
  enableGasEstimation?: boolean;
};

/**
 * Per-aggregator slim view. Carries only the fields the frontend needs to
 * display the quote and broadcast the transaction. `raw` is opaque (the
 * untouched upstream payload) and is not meant to be consumed by the UI —
 * it exists so the server can persist it for support / analytics later.
 */
export type SwapAggRoute = {
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
   * or zero. Independent of `gas`/`gasUsd` — wallets override gas anyway,
   * so present them as separate signals in the UI.
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
  /** Untouched upstream aggregator payload. Opaque; do not depend on shape. */
  raw: unknown;
};

/**
 * Aggregate outcome across all aggregators in a single request:
 *   - "success": every aggregator returned a route.
 *   - "partial": at least one aggregator returned a route, others failed/timed out.
 *   - "failed":  no aggregator returned a usable route.
 */
export type SwapAggStatus = "success" | "partial" | "failed";

/**
 * Full response shape of `POST /swapagg/{chain}`. `routes` is keyed by
 * aggregator name (e.g. `"kyberswap"`, `"oneInch"`) so the frontend can
 * render each side-by-side or pick the server-sorted top result.
 */
export type SwapAggResult = {
  /** Unique id for this quote attempt. */
  id: string;
  /** Unix epoch ms when the response was assembled. */
  timestamp: number;
  /** Aggregator-name → slim route. Keys present depend on which aggregators succeeded. */
  routes: Record<string, SwapAggRoute>;
  meta: {
    chain: SwapAggChain;
    request: SwapAggRequest;
  };
  status: SwapAggStatus;
};
