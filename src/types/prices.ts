/**
 * Response shapes for the /prices/* endpoints.
 *
 * Kept deliberately minimal: the frontend is expected to already hold the
 * full token list (name, symbol, decimals, logoURI) and just needs the
 * price keyed by (chainId, address).
 */

/**
 * A single priced token. `price` is the human-readable decimal string
 * returned by CheckTheChain (e.g. "2346.264564") so the frontend can
 * display it as-is without bigint arithmetic. `null` means the on-chain
 * price call failed for this token (no pool, reverted, etc.).
 */
export type TokenPrice = {
  chainId: number;
  address: string;
  price: string | null;
};

/**
 * Full response shape of `GET /prices/ethereum` — an array of token
 * prices in the same order as the bundled token list.
 */
export type PricesResponse = TokenPrice[];
