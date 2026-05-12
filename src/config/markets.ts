/**
 * Curated list of CoinGecko coin ids that the price/markets API will expose.
 *
 * Anything not in this list is ignored when fetching from `/coins/markets`.
 * Ids must match CoinGecko's `id` field exactly (see /coins/list).
 */
export const marketsConfig = {
  coinIds: [
    "bitcoin",
    "ethereum",
    "tether",
    "usd-coin",
    "dai",
  ] as string[],
};
