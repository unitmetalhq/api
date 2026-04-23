/**
 * Tests for the /prices/ethereum endpoint.
 *
 * This test hits the real upstream RPC (`ETHEREUM_RPC_URL` from .env.local)
 * via viem's multicall. Mocking viem at the wire level would require
 * hand-encoding Multicall3 aggregate3 responses, which is fragile and
 * low-value — the endpoint's core job IS making that real on-chain call,
 * so we test it end-to-end with a single shared fetch via `beforeAll`.
 *
 * If your network or RPC is flaky, individual assertions here may fail.
 * The shape assertions are the load-bearing ones; specific values
 * (e.g. ETH having a non-null price) depend on upstream liveness.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { prices } from "../modules/prices";
import type { PricesResponse } from "../types/prices";

describe("GET /prices/ethereum", () => {
  let status: number;
  let body: PricesResponse;

  beforeAll(async () => {
    const res = await prices.handle(
      new Request("http://localhost/prices/ethereum")
    );
    status = res.status;
    body = (await res.json()) as PricesResponse;
  }, 30_000); // allow up to 30s for the on-chain multicall

  test("responds 200 with a non-empty array", () => {
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test("every entry has exactly { chainId, address, price }", () => {
    for (const entry of body) {
      expect(Object.keys(entry).sort()).toEqual([
        "address",
        "chainId",
        "price",
      ]);
      expect(typeof entry.chainId).toBe("number");
      expect(typeof entry.address).toBe("string");
      expect(entry.address.startsWith("0x")).toBe(true);
      // price is either a decimal string or null
      expect(entry.price === null || typeof entry.price === "string").toBe(
        true
      );
    }
  });

  test("every entry is on Ethereum mainnet (chainId 1)", () => {
    for (const entry of body) {
      expect(entry.chainId).toBe(1);
    }
  });

  test("native ETH appears at the zero address", () => {
    const eth = body.find(
      (t) => t.address === "0x0000000000000000000000000000000000000000"
    );
    expect(eth).toBeDefined();
    expect(eth!.chainId).toBe(1);
    // ETH should price via the WETH substitution — null would indicate
    // the substitution logic is broken or the upstream is down.
    expect(typeof eth!.price).toBe("string");
  });

  test("at least some tokens return a priced result", () => {
    const priced = body.filter((t) => t.price !== null);
    expect(priced.length).toBeGreaterThan(0);
  });

  test("response carries CORS headers", async () => {
    const res = await prices.handle(
      new Request("http://localhost/prices/ethereum", {
        headers: { origin: "https://app.example.com" },
      })
    );
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  }, 30_000);
});
