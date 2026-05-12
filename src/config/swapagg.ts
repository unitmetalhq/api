/**
 * Server-side defaults for the swap-aggregator fan-out layer.
 *
 * `SwapAggService.getSwap` calls every configured aggregator (KyberSwap,
 * 1inch, etc.) in parallel via `Promise.allSettled`. Aggregators that don't
 * resolve within `timeoutMs` are dropped from the response — their slot in
 * `routes` is marked `failed` and the overall `status` becomes `"partial"`
 * (or `"failed"` if every aggregator timed out / errored).
 */
export const swapaggConfig = {
  /**
   * Per-aggregator wall-clock budget in milliseconds.
   *
   * Tuned for DEX aggregator latency: most return in 300–800ms, RFQ-heavy
   * ones can hit ~1.5s. Past 2s a quote is usually stale (gas/price ticks)
   * so dropping is safer than waiting longer. The frontend always sees a
   * response within this bound, regardless of the slowest aggregator.
   */
  timeoutMs: 2000,
};
