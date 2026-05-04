/**
 * PricesService
 * -------------
 * Fetches USD-denominated prices for every token in the local token list
 * from the CheckTheChain on-chain price oracle.
 *
 *   CheckTheChain: https://etherscan.io/address/0x0000000000cDC1F8d393415455E382c30FBc0a84
 *
 * One `checkPrice(address)` eth_call per token would be ~1 RPC round-trip
 * per token (373 at the time of writing). Instead we use viem's multicall,
 * which batches all of them into a single call to Multicall3 and returns
 * per-call success/failure. One request, one response, resilient to
 * individual token failures (e.g. a pool without a Uniswap V3 pair).
 *
 * The service does not cache, log, or persist anything — each HTTP hit
 * triggers a fresh on-chain read.
 */

import { createPublicClient, http, type Address } from "viem";
import { mainnet } from "viem/chains";
import { CHECK_THE_CHAIN_CONTRACT_ADDRESS } from "../../lib/constants";
import tokenList from "../../data/token-list.json";
import type { PricesResponse } from "../../types/prices";

/**
 * Minimal ABI containing only the `checkPrice(address)` overload.
 *
 * The full CheckTheChain ABI declares two `checkPrice` functions —
 * `checkPrice(address)` and `checkPrice(string)` — and viem refuses to
 * encode calls against such ambiguous ABIs at runtime (address and string
 * are indistinguishable on the wire). Narrowing to just the address
 * overload here resolves the ambiguity for this specific call site.
 */
const CHECK_PRICE_ABI = [
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "checkPrice",
    outputs: [
      { internalType: "uint256", name: "price", type: "uint256" },
      { internalType: "string", name: "priceStr", type: "string" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;

if (!ETHEREUM_RPC_URL) {
  throw new Error("ETHEREUM_RPC_URL is not set");
}

/**
 * The token list represents native ETH with the zero address (Uniswap
 * convention). CheckTheChain cannot price the zero address, so we
 * substitute WETH — which trades 1:1 with ETH — only for the price call.
 * The response still reports the original zero address to the client.
 */
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const WETH_ADDRESS: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/**
 * Stablecoins we treat as worth exactly $1, bypassing the on-chain price
 * read entirely. Real-world depeg events are rare enough — and the
 * downstream UX cost of showing "0.9994" for USDC is high enough — that
 * pinning to "1" gives users a more useful answer than the oracle does.
 * Lowercased so address comparisons are case-insensitive.
 */
const STABLECOIN_ADDRESSES: ReadonlySet<string> = new Set(
  [
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  ].map((a) => a.toLowerCase())
);

/**
 * viem public client, created once and reused across requests. `http()`
 * is a keep-alive HTTP transport. Each call to `publicClient.multicall`
 * automatically routes through the Multicall3 contract deployed at the
 * same address on every major chain.
 */
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(ETHEREUM_RPC_URL),
});

type TokenListEntry = {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
};

/**
 * Filter the bundled token list down to Ethereum mainnet tokens. The
 * current list is 100% chainId=1, but this guards against accidental
 * cross-chain entries in future edits.
 */
const ETHEREUM_TOKENS: TokenListEntry[] = (
  tokenList as { tokens: TokenListEntry[] }
).tokens.filter((t) => t.chainId === 1);

export abstract class PricesService {
  /**
   * Fetch prices for every token in the Ethereum token list via a single
   * multicall. Tokens whose price call reverts come back with `price: null`
   * rather than failing the entire response.
   *
   * Response is deliberately minimal (`chainId`, `address`, `price`) — the
   * frontend already has the full token list (name/symbol/logo/decimals)
   * and only needs the price keyed by (chainId, address).
   */
  static async getEthereumPrices(): Promise<PricesResponse> {
    // Build the list of addresses to send to CheckTheChain, substituting
    // WETH for the native-ETH placeholder (zero address).
    const priceAddresses: Address[] = ETHEREUM_TOKENS.map((t) =>
      t.address === ZERO_ADDRESS
        ? WETH_ADDRESS
        : (t.address as Address)
    );

    // One `checkPrice(address)` call per token, all bundled into a single
    // multicall. `allowFailure: true` means a reverting token call returns
    // `{ status: "failure" }` instead of throwing and killing the batch.
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: priceAddresses.map(
        (addr) =>
          ({
            address: CHECK_THE_CHAIN_CONTRACT_ADDRESS as Address,
            abi: CHECK_PRICE_ABI,
            functionName: "checkPrice",
            args: [addr],
          }) as const
      ),
    });

    // Zip the multicall results back onto the original token list.
    // `result.result` is `[price: bigint, priceStr: string]`; we return
    // the string form so the frontend gets a decimal USD value ready to
    // display (no bigint → decimal conversion needed client-side).
    return ETHEREUM_TOKENS.map((token, i) => {
      if (STABLECOIN_ADDRESSES.has(token.address.toLowerCase())) {
        return { chainId: token.chainId, address: token.address, price: "1" };
      }
      const result = results[i];
      return {
        chainId: token.chainId,
        address: token.address,
        price: result.status === "success" ? result.result[1] : null,
      };
    });
  }
}
