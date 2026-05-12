/**
 * Tests for the /swapagg/ethereum endpoint.
 *
 * Like `prices.test.ts`, this test hits real upstreams — in this case
 * KyberSwap's aggregator API — using `KYBERSWAP_CLIENT_ID` from .env.local.
 * Mocking would require hand-crafting two layers of envelope responses
 * (route + build) and is too fragile to be worth maintaining; the value of
 * this test is verifying that a real ETH→USDC quote round-trips correctly
 * and produces broadcastable calldata.
 *
 * The full request is made once in `beforeAll` so we only consume a single
 * unit of the rate-limit budget (max 10/min) and one round-trip of latency.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { swapagg } from "../modules/swapagg";
import type { SwapAggRequest, SwapAggResult } from "../types/swapagg";

// Native ETH is encoded as the zero address by the KyberSwap client.
const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
// Canonical USDC on Ethereum mainnet (6 decimals).
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// Public well-known address used as sender/recipient. Tests don't broadcast,
// so any non-zero EOA works — vitalik.eth is convenient and well-known.
const TEST_WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
// 0.01 ETH in wei — small enough to keep price impact tiny on a deep pair.
const AMOUNT_IN = "10000000000000000";

const REQUEST_BODY: SwapAggRequest = {
  tokenIn: NATIVE_ETH,
  tokenOut: USDC,
  amountIn: AMOUNT_IN,
  sender: TEST_WALLET,
  recipient: TEST_WALLET,
  slippageTolerance: 50,
};

describe("POST /swapagg/ethereum (real ETH→USDC quote)", () => {
  let status: number;
  let body: SwapAggResult;

  beforeAll(async () => {
    const res = await swapagg.handle(
      new Request("http://localhost/swapagg/ethereum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
      })
    );
    status = res.status;
    body = (await res.json()) as SwapAggResult;
  }, 30_000);

  test("responds 200", () => {
    expect(status).toBe(200);
  });

  test("envelope has id, timestamp, routes, meta, status", () => {
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(typeof body.timestamp).toBe("number");
    expect(body.timestamp).toBeGreaterThan(0);
    expect(body.status).toBe("success");
    expect(body.routes).toBeDefined();
    expect(body.meta).toBeDefined();
  });

  test("meta echoes the request and chain", () => {
    expect(body.meta.chain).toBe("ethereum");
    expect(body.meta.request.tokenIn).toBe(NATIVE_ETH);
    expect(body.meta.request.tokenOut).toBe(USDC);
    expect(body.meta.request.amountIn).toBe(AMOUNT_IN);
    expect(body.meta.request.sender).toBe(TEST_WALLET);
    expect(body.meta.request.recipient).toBe(TEST_WALLET);
  });

  test("kyberswap route is present", () => {
    expect(body.routes.kyberswap).toBeDefined();
    expect(body.routes.kyberswap.name).toBe("kyberswap");
  });

  test("route carries broadcastable calldata", () => {
    const r = body.routes.kyberswap;
    expect(r.routerAddress.startsWith("0x")).toBe(true);
    expect(r.routerAddress.length).toBe(42);
    expect(r.data.startsWith("0x")).toBe(true);
    // Real swap calldata is hundreds of bytes — anything trivially short
    // would mean we got an empty/malformed build.
    expect(r.data.length).toBeGreaterThan(10);
    // ETH→ERC20 swap: msg.value must equal amountIn (string compare is fine
    // since both come back as decimal-wei strings).
    expect(r.transactionValue).toBe(AMOUNT_IN);
  });

  test("route quote fields reflect the input swap", () => {
    const r = body.routes.kyberswap;
    expect(r.tokenIn).toBe(NATIVE_ETH);
    expect(r.tokenOut).toBe(USDC);
    expect(r.amountIn).toBe(AMOUNT_IN);
    // amountOut is a positive integer string in USDC base units (6 decimals).
    expect(/^\d+$/.test(r.amountOut)).toBe(true);
    expect(BigInt(r.amountOut)).toBeGreaterThan(0n);
  });

  test("priceImpactBps is a non-negative number when USD reference is present", () => {
    const r = body.routes.kyberswap;
    if (r.amountInUsd && r.amountOutUsd && Number(r.amountInUsd) > 0) {
      expect(typeof r.priceImpactBps).toBe("number");
      expect(r.priceImpactBps).toBeGreaterThanOrEqual(0);
      // 0.01 ETH on a deep pair like ETH/USDC should be well under 1%.
      expect(r.priceImpactBps).toBeLessThan(100);
    }
  });

  test("raw upstream payload is preserved on the route", () => {
    const r = body.routes.kyberswap;
    expect(r.raw).toBeDefined();
    expect(typeof r.raw).toBe("object");
    // We don't enforce a deep shape on `raw` — the contract is "kept verbatim
    // for DB persistence", so just verify it carries the build/route data
    // a downstream consumer would need.
    const raw = r.raw as Record<string, unknown>;
    expect(raw.routeSummary).toBeDefined();
    expect(raw.routerAddress).toBeDefined();
    expect(raw.build).toBeDefined();
  });

  test("response is marked uncacheable", async () => {
    const res = await swapagg.handle(
      new Request("http://localhost/swapagg/ethereum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
      })
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 30_000);
});

describe("POST /swapagg/ethereum body validation", () => {
  test("rejects requests missing required fields", async () => {
    const res = await swapagg.handle(
      new Request("http://localhost/swapagg/ethereum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenIn: NATIVE_ETH }),
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("rejects GET (the route is POST-only)", async () => {
    const res = await swapagg.handle(
      new Request("http://localhost/swapagg/ethereum")
    );
    // Elysia returns 404 for an unhandled method on a known path.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
