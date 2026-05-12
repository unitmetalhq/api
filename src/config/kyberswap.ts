import type { ChargeFeeBy } from "../lib/swap/sdks/kyberswap/kyberswap";
import { UNITMETAL_TREASURY_ADDRESS } from "../lib/constants";

/**
 * Server-side defaults for KyberSwap aggregator calls.
 *
 * These fields are NOT accepted from the frontend — they are appended to the
 * `getRoute` request inside `SwapAggService.getSwap` so the fee policy is
 * controlled by the backend and cannot be tampered with by the client.
 */
export const kyberswapConfig = {
  /**
   * Fee amount to collect per swap.
   *
   * Interpretation depends on `isInBps`:
   *   - `isInBps: true`  → bps with base 10000. "10" = 0.10%.
   *   - `isInBps: false` → absolute token wei. "10" = 10 wei of the fee token.
   *
   * KyberSwap also accepts a comma-separated list (e.g. "10,20") to split the
   * fee across multiple receivers in `feeReceiver`. We use a single value.
   */
  feeAmount: "10",

  /**
   * Which side of the swap the fee is taken from.
   *   - "currency_in"  → fee deducted from the input token before routing.
   *   - "currency_out" → fee deducted from the output token after routing.
   *
   * Leaving this unset on the request would disable fee collection entirely,
   * so this field is required for fees to actually be charged.
   */
  chargeFeeBy: "currency_out" as ChargeFeeBy,

  /**
   * Whether `feeAmount` is interpreted as basis points (true) or as a raw
   * wei amount of the fee token (false). See `feeAmount` above.
   */
  isInBps: true,

  /**
   * Wallet that receives the collected fee. Mirrors `feeAmount` shape: a
   * single address, or a comma-separated list when splitting across multiple
   * receivers. Pinned to the Unitmetal treasury.
   */
  feeReceiver: UNITMETAL_TREASURY_ADDRESS,
};
