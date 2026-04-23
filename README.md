# Elysia with Bun runtime

## Getting Started
To get started with this template, simply paste this command into your terminal:
```bash
bun create elysia ./elysia-example
```

## Development
To start the development server run:
```bash
bun run dev
```

Open http://localhost:8000/ with your browser to see the result.

## Ethereum RPC Proxy

`POST /rpc/ethereum` proxies JSON-RPC requests to the upstream provider configured via `ETHEREUM_RPC_URL`. Designed as a drop-in replacement for an Ethereum RPC URL in a browser frontend.

### Setup
Copy `.env.example` to `.env.local` and fill in your provider URL:
```
ETHEREUM_RPC_URL=https://...
```

### Usage
Point your wallet / web3 library at the proxy instead of the upstream:
```
http://localhost:8000/rpc/ethereum
```

### What it does
- Forwards the request body unchanged to `ETHEREUM_RPC_URL`.
- The upstream provider sees only the server's IP and a fixed `User-Agent: unitmetal-api/1.0` — not the end-user's browser.
- Only `content-type` and `accept` are forwarded from the client; identifying headers (`user-agent`, `accept-language`, `sec-ch-ua-*`, `sec-fetch-*`, `referer`, `origin`, `cookie`, `x-forwarded-*`, etc.) are dropped.
- CORS is enabled for all origins (`*`, credentials off) so any frontend can call it; `OPTIONS` preflights are handled locally and not proxied upstream.
- No request, response, or client data is logged or persisted.

### Rate limiting
Per-client rate limit is enforced via `elysia-rate-limit` with values at the top of `src/modules/rpc/index.ts`:
```ts
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_DURATION_MS = 60_000;
```
Clients are identified by a SHA-256 hash of `salt + socket IP`, where the salt is a random 32 bytes generated at process start. The in-memory LRU only ever sees opaque hashes; raw IPs are never stored. Failed requests count toward the limit.

### Deployment note
Client identification uses the direct TCP peer IP. If you deploy behind a load balancer or CDN, all clients will share the LB's IP — update the rate-limit `generator` in `src/modules/rpc/index.ts` to read from `x-forwarded-for` before the header is stripped for the outbound request.
