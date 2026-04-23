# UnitMetal API

An [Elysia](https://elysiajs.com) / [Bun](https://bun.sh) backend that exposes two public endpoints for a crypto frontend:

- **`POST /rpc/ethereum`** — a privacy-preserving JSON-RPC proxy to the upstream Ethereum provider.
- **`GET /prices/ethereum`** — on-chain USD prices for every token in the bundled token list, fetched in a single multicall.

Both endpoints are designed to be called directly from a browser: open CORS, per-client rate limiting, zero logging, and no persistence of client data.

## Getting Started

```bash
bun install
cp .env.example .env.local   # then fill in ETHEREUM_RPC_URL
bun run dev
```

Open http://localhost:8000/ with your browser to see the result.

## Scripts

| Command          | What it does                                                  |
| ---------------- | ------------------------------------------------------------- |
| `bun run dev`    | Start the dev server on `:8000` with file-watch reload.       |
| `bun run test`   | Run the Bun test suite (`src/test/**/*.test.ts`).             |

`bun run test` loads `.env.local` explicitly via `--env-file`, because `bun test` deliberately ignores `.env.local` by default.

## Project Structure

```
src/
├── index.ts                    # Root Elysia app — mounts feature modules, listens on :8000
├── data/
│   └── token-list.json         # Uniswap-format token list (Ethereum mainnet)
├── lib/
│   ├── abis/
│   │   └── check-the-chain-abi.ts   # CheckTheChain contract ABI
│   ├── client-id.ts            # Salted SHA-256 hash of client IP (shared by rate limiters)
│   └── constants.ts            # CHECK_THE_CHAIN_CONTRACT_ADDRESS
├── modules/
│   ├── rpc/
│   │   ├── index.ts            # Controller: CORS + rate limit + route wiring
│   │   └── service.ts          # RpcService: header-sanitizing request forwarder
│   └── prices/
│       ├── index.ts            # Controller: CORS + rate limit + route wiring
│       └── service.ts          # PricesService: viem multicall against CheckTheChain
├── test/
│   ├── root.test.ts            # Covers GET /
│   ├── rpc.test.ts             # Mocks fetch; asserts header stripping + CORS + passthrough
│   └── prices.test.ts          # Hits real upstream; asserts response shape
└── types/
    └── prices.ts               # TokenPrice, PricesResponse
```

### Architecture

The app follows Elysia's recommended **feature-based module** pattern ([MVC guide](https://elysiajs.com/patterns/mvc.html)): each feature lives under `src/modules/<feature>/` with a controller (`index.ts`) and a service (`service.ts`).

- **Controller (`index.ts`)** — an Elysia instance that owns the prefix, mounts plugins (`@elysiajs/cors`, `elysia-rate-limit`), and registers routes. Route handlers are thin wrappers that delegate to the service.
- **Service (`service.ts`)** — an abstract class of static methods with no Elysia dependency. All business logic (proxying bytes, calling viem) lives here, which makes the service trivial to unit-test without spinning up an HTTP server.
- **Root app (`src/index.ts`)** — imports each module and mounts it via `.use(module)`. Adding a new feature = add a new folder under `modules/` and one `.use()` call.

**Privacy primitives are deliberately shared, not duplicated.** `src/lib/client-id.ts` exports `hashClientIp(ip)`: a SHA-256 over a process-lifetime random salt plus the IP. Both rate limiters call it, so the in-memory LRU stores only opaque hex digests. The salt never leaves the process, so a memory dump of the rate-limit cache cannot be reversed back to IPs without also capturing the salt at the same moment.

## Endpoints

### `POST /rpc/ethereum` — Ethereum RPC proxy

Drop-in replacement for `ETHEREUM_RPC_URL` in a browser frontend. Forwards the request body byte-for-byte to the upstream and streams the response back.

**Usage:**
```
http://localhost:8000/rpc/ethereum
```
Point viem / ethers / web3.js at that URL instead of your Alchemy/Infura/etc. URL.

**What the upstream provider sees:**
- This server's IP (not the end-user's).
- A fixed `User-Agent: unitmetal-api/1.0` — every request looks identical, so customers cannot be distinguished by browser fingerprint.
- `content-type: application/json` and `accept` from the client; everything else (`user-agent`, `accept-language`, `sec-ch-ua-*`, `sec-fetch-*`, `referer`, `origin`, `cookie`, `x-forwarded-*`, `dnt`, etc.) is stripped by `RpcService.proxy`.

**CORS:** `Access-Control-Allow-Origin: *`, credentials off. `OPTIONS` preflights are short-circuited by `@elysiajs/cors` and never proxied upstream.

### `GET /prices/ethereum` — bulk token prices

Returns USD prices for every Ethereum-mainnet token in `src/data/token-list.json` in a single batched on-chain call.

**Example response (trimmed):**
```json
[
  { "chainId": 1, "address": "0x0000000000000000000000000000000000000000", "price": "2345.086344" },
  { "chainId": 1, "address": "0x111111111117dC0aa78b770fA6A738034120C302", "price": "0.09563" },
  { "chainId": 1, "address": "0x3E5A19c91266aD8cE2477B91585d1856B84062dF", "price": null },
  ...
]
```

**Response shape** — see `src/types/prices.ts`:
```ts
type TokenPrice = {
  chainId: number;
  address: string;
  price: string | null;   // decimal USD string from CheckTheChain, or null if the call failed
};
type PricesResponse = TokenPrice[];
```

The response is deliberately minimal: the frontend is expected to already hold the full token list (name, symbol, decimals, logoURI) and only needs the price keyed by `(chainId, address)`. One entry per token, same order as `token-list.json`.

**Native ETH** is reported at the zero address (Uniswap convention). Internally `PricesService` substitutes WETH (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) for the price lookup, since CheckTheChain cannot price the zero address — the client still receives `address: "0x0000…0000"`.

**How it works:**
- `PricesService.getEthereumPrices()` builds one `checkPrice(address)` call per token and sends them all through `publicClient.multicall` (viem), which aggregates them into a single `eth_call` to [Multicall3](https://www.multicall3.com/).
- `allowFailure: true` so a token without a reachable Uniswap pool returns `price: null` instead of killing the whole batch.
- [CheckTheChain](https://etherscan.io/address/0x0000000000cDC1F8d393415455E382c30FBc0a84) is the on-chain price oracle that quotes each token against USDC via Uniswap V3.
- Nothing is cached server-side — each HTTP hit triggers a fresh on-chain read. (The frontend should debounce and cache as appropriate.)

**ABI note:** `src/modules/prices/service.ts` ships a minimal single-overload ABI for `checkPrice`. The full CheckTheChain ABI in `src/lib/abis/check-the-chain-abi.ts` declares both `checkPrice(address)` and `checkPrice(string)`, which viem refuses to encode because they are indistinguishable on the wire.

## Rate limiting

Both modules use [`elysia-rate-limit`](https://github.com/rayriffy/elysia-rate-limit) with identical configuration, tuned separately per endpoint at the top of each controller:

```ts
// src/modules/rpc/index.ts
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_DURATION_MS = 60_000;

// src/modules/prices/index.ts
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_DURATION_MS = 60_000;
```

- **Independent buckets** — a client gets 20 req/min on `/rpc/*` *and* 20 req/min on `/prices/*`. Exhausting one does not throttle the other.
- **`countFailedRequest: true`** — 4xx/5xx responses still consume the budget, so an attacker cannot spam deliberately-erroring calls for free.
- **`scoping: "scoped"`** — the limiter's hooks apply only to the module they live in; `/` is never throttled.
- **Client key** — the custom generator (see `src/lib/client-id.ts`) returns `sha256(salt || ip)` as a hex string. The plugin's default LRU stores that digest, not the IP. Unidentifiable clients (no peer IP available) share one bucket under the empty-string key.

## Privacy posture

The goal across the whole app is: **the upstream RPC provider cannot distinguish customers, and this server never stores customer information.** Concretely:

- **No logging.** Neither module calls `console.log`, no access logs, no request/response bodies written anywhere. The only log is a single startup line in `src/index.ts`.
- **No persistence.** There is no database, no disk writes, no cookies issued.
- **IPs are not stored in plaintext.** The rate-limit LRU stores salted hashes only; the salt is in-process memory and dies with the process.
- **Customer headers are dropped, not passed through.** `RpcService.proxy` uses an allowlist (not a denylist), so new browser fingerprinting headers are blocked by default.
- **User-Agent is overwritten.** Every outbound request carries `unitmetal-api/1.0` regardless of what the customer sent.

## Deployment note — reverse proxies

The rate-limit generator uses `server.requestIP(request)`, which returns the direct TCP peer. If you deploy behind a load balancer, CDN, or any reverse proxy, every customer will share the LB's IP and be bucketed together.

When that happens, update the `generator` in both `src/modules/rpc/index.ts` and `src/modules/prices/index.ts` to read the real client IP from `x-forwarded-for` (and trust it only from the LB — not from arbitrary clients). Do it in the generator *before* `RpcService.proxy` strips that header for the outbound request.

## Testing

```bash
bun run test
```

- `src/test/root.test.ts` — smoke tests for the root route.
- `src/test/rpc.test.ts` — replaces `globalThis.fetch` with a capturing mock and asserts that outbound requests have their identifying headers stripped, the fixed `User-Agent` set, the body forwarded byte-for-byte, and CORS headers on the response; also confirms `OPTIONS` preflights never reach the upstream.
- `src/test/prices.test.ts` — hits the real upstream RPC (via the env-configured URL) and asserts the response is an array of `{ chainId, address, price }` entries, every entry has `chainId === 1`, ETH is present at the zero address with a non-null price (validates the WETH substitution), and CORS headers are present.

The prices test is effectively an integration test and depends on upstream liveness. Mocking viem at the wire level was considered and rejected as fragile (Multicall3 responses are ABI-encoded per-call).
