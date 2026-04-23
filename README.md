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

---

## TODO — Billing endpoint

Not yet implemented. This section captures the design decisions reached so far so we can pick up where we left off. Code has **not** been written.

### Model

**Credits are the universal currency.** Every paid endpoint consumes N credits per call, where N is defined in a per-endpoint config file. Two funding sources feed the same credit ledger:

```
Stripe subscription  ──┐
                       ├──► credit ledger  ◄── request pipeline (deducts per call)
Crypto top-up        ──┘
```

- **Crypto (primary, privacy-preserving)**: pay-as-you-go top-ups. Customer sends USDC via a payment smart contract and gets credits added to their balance. This is the default path, aligned with the rest of the app's no-logging / no-PII posture.
- **Stripe (secondary, for premium features)**: recurring subscription. On each successful renewal, a fixed monthly credit allowance is granted. Explicitly non-private — a customer choosing this path has already accepted being identified (Stripe holds their name, email, card). Used for premium features that crypto users may not need.

One customer maps to one funding source. A Stripe customer and a crypto customer are separate account rows, never merged.

### Privacy stance

Goal: the server cannot link a customer's wallet address to their IP, and does not hold identifying information for crypto customers.

- **IP ↔ API key link is transient.** On every request the server sees both the peer IP and the `Authorization: Bearer` key. This correlation exists in memory only for the duration of request handling; it is never logged or persisted. Rate-limit store (hashed IP) and credit store (hashed API key) are strictly separate tables with no joining column. A full DB dump gives an attacker no linkage.
- **Wallet ↔ API key link is broken at topup.** At the moment of funding the server verifies the on-chain deposit event and credits the key's balance. The wallet address is **never** written to the database. See "Crypto payment architecture" below.
- **Stripe path is a different trust zone.** Customers using Stripe are explicitly identified. This is surfaced in the product copy, not hidden.
- **No access logs, no APM tracing with request attributes.** Same posture as the rest of the app.

Accepted residual risk: a compromised server can correlate IP-to-key in real time by watching live traffic. Defending against this requires Tor hidden service / mixnet-level infra and is out of scope.

### Identity & auth flow

- **API keys**: random bytes, stored as `sha256(key)` in the DB. The key itself is given to the customer once at issuance and cannot be recovered.
- **Request authentication**: `Authorization: Bearer <key>` header on every billable request.
- **Key issuance**:
  - Crypto path: wallet connect + SIWE-style signature proves ownership of the wallet, server mints an API key and binds the first deposit. No email, no account recovery — lose the key, lose access.
  - Stripe path: Stripe Checkout flow establishes an email; server mints an API key bound to the `stripe_customer_id`. Key recovery possible via email.

### Crypto payment architecture

**Payment contract with commitment pattern.** Customer calls `deposit(bytes32 keyCommitment)` on a small custom contract, transferring USDC. The contract emits `Deposited(keyCommitment, amount)`. The `keyCommitment` is `sha256(api_key)` so the event does not reveal the key itself.

Why this shape:
- The event is keyed by commitment, not by wallet. Anyone watching the contract sees `(commitment, amount)` pairs, not `(wallet, commitment)`.
- The server only reads event logs (never `eth_getTransactionReceipt`), so the wallet address (`receipt.from`) never enters the server process. A DB dump contains no wallet addresses.
- The transaction sender is still public on-chain — we are not hiding the wallet from observers, only from our own server state.

### Detection — deposit poller

**Chain poller, not client-submitted tx hashes.** The frontend may POST the tx hash for snappier UX, but the server's source of truth is the poller; the POST is just a nudge.

Decisions:

| Choice                  | Value                                            | Rationale                                                                 |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Scheduler               | `@elysiajs/cron` plugin                          | Lifecycle-integrated with Elysia; named jobs; room to add more tasks.     |
| Interval                | 30 seconds (`Patterns.EVERY_30_SECONDS`)         | Trivial RPC cost; user-perceived latency ~30–60s worst case.              |
| Confirmation depth      | 12 blocks (~2.4 min post-Merge mainnet)          | Acceptable residual reorg risk for small-amount USDC top-ups.             |
| Range query             | `eth_getLogs` over `[lastProcessed+1, head-12]`  | One RPC call per tick, covers all new blocks at once.                     |
| Backfill chunk size     | ~5,000 blocks                                    | Below most providers' `eth_getLogs` range caps (Alchemy: 10k).            |
| Overlap prevention      | `running` flag inside `run()` callback           | Croner (underlying lib) does not protect against overlapping runs.        |
| Error handling          | Swallow, don't advance pointer, retry next tick  | Self-heals transient failures; no identifying log output.                 |
| Startup seed            | `last_processed_block = contract_deploy_block`   | Avoid scanning Ethereum history from genesis on first run.                |

Shutdown is handled by the plugin automatically when the Elysia app stops.

### Storage — SQLite via `bun:sqlite`

Zero-ops, single file, sufficient throughput for v1. Swap to Postgres later if multi-instance scaling is needed.

Tables (rough sketch):

- `customers(id, stripe_customer_id NULL, created_at)` — one row per account; either `stripe_customer_id` is set (Stripe path) or it isn't (crypto path). No wallet address stored.
- `api_keys(key_hash PRIMARY KEY, customer_id, created_at, revoked_at NULL)` — SHA-256 of the key; one customer may hold multiple keys.
- `credit_balances(customer_id PRIMARY KEY, balance)` — atomic decrement via `UPDATE ... SET balance = balance - ? WHERE customer_id = ? AND balance >= ?` and checking `changes()`.
- `processed_deposits(tx_hash PRIMARY KEY, commitment, amount, block_number, processed_at)` — `UNIQUE(tx_hash)` is the idempotency guard; re-seeing the same event is a no-op.
- `indexer_state(key PRIMARY KEY, value)` — single row for `last_processed_block`. Updated in the same transaction that credits balances, so a crash mid-batch leaves the pointer unmoved.
- `stripe_events(event_id PRIMARY KEY, processed_at)` — webhook idempotency.

### Enforcement middleware

A new middleware sits on billable routes:

1. Read `Authorization: Bearer <key>` from the request.
2. `sha256(key)` → look up `api_keys` row → resolve `customer_id`.
3. Read per-endpoint cost from the config file.
4. Atomic decrement on `credit_balances`; if zero rows affected, return `402 Payment Required`.
5. Run the handler.
6. (TBD) Refund the credit if the handler failed due to an upstream / server-side issue.

Middleware order: rate limit first (cheap, in-memory LRU) → credit check (DB hit) → handler.

### Subscription (Stripe) flow

- Customer creates subscription via Stripe Checkout (hosted page). Server stores only `stripe_customer_id`.
- `invoice.paid` webhook → look up customer → grant the tier's monthly credit allowance to `credit_balances`.
- Signature verification on every webhook; `stripe_events.event_id` dedupes replays.
- Subscription lapse (`customer.subscription.deleted`): customer's monthly grants stop; any unconsumed credits remain spendable until gone (or until the rollover policy says otherwise — see open questions).

### Module structure (planned)

```
src/
├── modules/
│   ├── deposits/
│   │   ├── index.ts          # @elysiajs/cron registration + HTTP endpoints
│   │   ├── service.ts        # DepositsService: eth_getLogs, parse, credit
│   │   └── poller.ts         # Tick function with overlap guard
│   └── billing/
│       ├── index.ts          # Stripe webhook endpoint, signature verification
│       └── service.ts        # BillingService: subscription state, credit grants
├── lib/
│   ├── db.ts                 # bun:sqlite handle + schema init
│   ├── credits.ts            # Atomic decrement / refund / grant helpers
│   └── auth.ts               # API key hashing + lookup
└── config/
    └── pricing.ts            # Per-endpoint credit cost map
```

Endpoints tentatively:

- `POST /deposits/notify` — client nudges the server with a tx hash (optional; poller is source of truth).
- `GET /deposits/:tx_hash/status` — polled by the frontend to flip the UI from "pending" to "credited".
- `POST /billing/stripe/webhook` — Stripe webhook sink.
- Future: account management endpoints (key rotation, balance query, etc.).

### Open questions (still to decide)

- **Rollover policy for subscription credits.** Expire monthly (simple, customer-hostile), roll over uncapped (customer-friendly, builds financial liability), or roll over capped (typical). Affects the schema — may need a separate `subscription_credits` column with an expiration timestamp.
- **Single vs split bucket.** When a Stripe subscriber also tops up with crypto, are those one balance or two? Leaning split (spend subscription credits first; they may expire; top-up credits never do), but open to debate.
- **Refund semantics on request failure.** Upstream times out → refund? Upstream returns a valid JSON-RPC error response → charge (server did the work)? Customer sent malformed input → charge? Tentative rule: "refund only when the server itself failed, not when the upstream returned an answer we proxied."
- **Credit pricing.** How much is 1 credit in USDC? Flat rate, bulk discount, tier-based?
- **Subscription tier structure.** One tier or several? Maps to Stripe Prices.
- **Frontend auth specifics.** SIWE message format, session token lifetime, key storage (localStorage vs HTTP-only cookie set after SIWE).
- **Reverse-proxy IP handling.** Existing rate-limit deployment note applies here too: if we ever sit behind an LB/CDN, the generator must read `x-forwarded-for` before stripping it.
- **Observability.** Aggregate metrics (total calls per endpoint, deposits/day, revenue) are fine. Per-customer metrics require an authenticated account view; none are written to third-party APM tools.

### What's locked in

- Model: credits as universal currency; Stripe = monthly grant, crypto = top-up.
- Two separate account types, never merged.
- Payment contract with commitment pattern; wallet address never persisted server-side.
- Poller: `@elysiajs/cron`, 30s interval, 12 block depth, `eth_getLogs` per tick, overlap guard flag.
- Poller reads event logs only, never transaction receipts.
- Storage: SQLite via `bun:sqlite`; in-process poller for v1.
- Atomic decrement with row-affected check for credit deduction.
- API keys stored as SHA-256 hashes; `Authorization: Bearer` header.
- Idempotency: `UNIQUE(tx_hash)` for deposits, Stripe event IDs for webhooks.
