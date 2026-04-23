/**
 * RPC Module (controller)
 * -----------------------
 * Exposes public `/rpc/*` endpoints that proxy JSON-RPC requests to
 * blockchain providers. Currently only Ethereum is wired up.
 *
 * This file is the Elysia "controller" for the feature: it wires together
 * CORS, per-client rate limiting, and the RpcService (which does the actual
 * request forwarding). The Elysia instance is exported so the root app can
 * mount it via `.use(rpc)`.
 */

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { rateLimit } from "elysia-rate-limit";
import { hashClientIp } from "../../lib/client-id";
import { RpcService } from "./service";

// --- Configuration ---------------------------------------------------------

/**
 * Upstream Ethereum JSON-RPC endpoint. Read once at module load from
 * `.env.local` (Bun auto-loads it). The process refuses to start without
 * it — failing fast here is better than returning 500s at runtime.
 */
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;

if (!ETHEREUM_RPC_URL) {
  throw new Error("ETHEREUM_RPC_URL is not set");
}

/**
 * Rate-limit tunables. Adjust these to change per-client throughput.
 *
 *   RATE_LIMIT_MAX          — requests allowed inside the window
 *   RATE_LIMIT_DURATION_MS  — window length in milliseconds
 *
 * The current setting (20 per 60s per client) is chosen to absorb the
 * typical burst of calls a wallet/dapp makes on page load without
 * exhausting the upstream provider quota.
 */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_DURATION_MS = 60_000;

// --- Controller ------------------------------------------------------------

export const rpc = new Elysia({ prefix: "/rpc" })
  // CORS must be registered BEFORE rateLimit. The cors plugin answers
  // `OPTIONS` preflight requests itself (short-circuiting the request
  // pipeline with a 204). Because rateLimit is registered after, its
  // hook never runs on preflights, so preflights do not consume a
  // client's request budget.
  //
  //   origin: true        -> reflects Access-Control-Allow-Origin: *
  //   credentials: false  -> required when origin is `*`; the proxy does
  //                          not use cookies/auth headers anyway.
  .use(cors({ origin: true, credentials: false }))
  .use(
    rateLimit({
      max: RATE_LIMIT_MAX,
      duration: RATE_LIMIT_DURATION_MS,

      // "scoped" confines the limiter to this Elysia instance and its
      // descendants. Without this override the plugin defaults to
      // "global" and would also throttle unrelated routes (e.g. `/`).
      scoping: "scoped",

      // Count 4xx/5xx as well. Otherwise an attacker could spam requests
      // that deliberately trigger upstream errors and get unlimited
      // throughput for free.
      countFailedRequest: true,

      // Custom key generator. Replaces the plugin's default, which:
      //   (a) uses the raw IP as the LRU key (we don't want IPs in RAM), and
      //   (b) emits `console.warn` when IP detection fails (we want zero logs).
      //
      // `server.requestIP(request)` returns the direct TCP peer. If this
      // service is ever deployed behind a load balancer/CDN, every
      // customer will share the LB's IP — at that point, read
      // `x-forwarded-for` here instead (and trust it only from the LB).
      generator: (request, server) => {
        const ip = server?.requestIP(request)?.address;
        // Empty string still works as a key: all unidentifiable clients
        // share one bucket, which is safe (they self-throttle together).
        return ip ? hashClientIp(ip) : "";
      },
    })
  )
  // `.all()` accepts any HTTP method so the endpoint behaves as a
  // drop-in for the upstream RPC URL. Ethereum JSON-RPC is POST in
  // practice, but being permissive costs nothing and avoids surprising
  // library behaviour.
  //
  // The final path is `/rpc/ethereum` (prefix + route).
  .all("/ethereum", ({ request }) =>
    RpcService.proxy(request, ETHEREUM_RPC_URL)
  );
