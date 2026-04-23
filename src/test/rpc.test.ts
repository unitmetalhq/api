/**
 * Tests for the /rpc/ethereum proxy endpoint.
 *
 * These tests replace `globalThis.fetch` with a mock that captures the
 * outbound request. That lets us assert privacy behaviour (stripped
 * headers, fixed User-Agent, byte-exact body passthrough) without making
 * real network calls.
 *
 * `afterEach` restores the original fetch so the mock cannot leak into
 * other test files (Bun may run test files in separate workers, but we
 * don't rely on that).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { rpc } from "../modules/rpc";

type FetchArgs = { url: string; init: RequestInit | undefined };

const UPSTREAM_RESPONSE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: "0x1234",
});

describe("POST /rpc/ethereum", () => {
  const originalFetch = globalThis.fetch;
  let lastCall: FetchArgs | null;
  let mockStatus: number;

  beforeEach(() => {
    lastCall = null;
    mockStatus = 200;

    // Replace fetch with a capturing mock. We accept the loose `any` here
    // because we're intentionally narrowing to the 2-arg form the proxy
    // actually uses.
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      lastCall = {
        url: typeof input === "string" ? input : input.toString(),
        init,
      };
      return new Response(UPSTREAM_RESPONSE_BODY, {
        status: mockStatus,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("forwards POST body byte-for-byte to upstream", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: 1,
    });

    const res = await rpc.handle(
      new Request("http://localhost/rpc/ethereum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_RESPONSE_BODY);

    // Verify the upstream received the exact same bytes.
    expect(lastCall).not.toBeNull();
    const forwardedBody = new TextDecoder().decode(
      lastCall!.init!.body as ArrayBuffer
    );
    expect(forwardedBody).toBe(body);
  });

  test("strips identifying headers from the outbound request", async () => {
    await rpc.handle(
      new Request("http://localhost/rpc/ethereum", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "EvilBrowser/6.6 (Linux)",
          "accept-language": "en-US",
          referer: "https://customer.example.com/page",
          origin: "https://customer.example.com",
          cookie: "session=deadbeef",
          "x-forwarded-for": "203.0.113.42",
          "sec-ch-ua": '"Chromium";v="130"',
        },
        body: "{}",
      })
    );

    const fwd = new Headers(lastCall!.init!.headers as HeadersInit);

    // User-Agent is overridden to the fixed proxy value.
    expect(fwd.get("user-agent")).toBe("unitmetal-api/1.0");

    // All identifying headers are dropped.
    expect(fwd.get("accept-language")).toBeNull();
    expect(fwd.get("referer")).toBeNull();
    expect(fwd.get("origin")).toBeNull();
    expect(fwd.get("cookie")).toBeNull();
    expect(fwd.get("x-forwarded-for")).toBeNull();
    expect(fwd.get("sec-ch-ua")).toBeNull();

    // Allowed headers pass through.
    expect(fwd.get("content-type")).toBe("application/json");
  });

  test("preserves the upstream HTTP status code", async () => {
    mockStatus = 503;

    const res = await rpc.handle(
      new Request("http://localhost/rpc/ethereum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );

    expect(res.status).toBe(503);
  });

  test("response carries CORS headers for cross-origin callers", async () => {
    const res = await rpc.handle(
      new Request("http://localhost/rpc/ethereum", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.com",
        },
        body: "{}",
      })
    );

    // With `origin: true, credentials: false` the plugin sets `*`.
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  test("OPTIONS preflight is handled locally (not proxied upstream)", async () => {
    const res = await rpc.handle(
      new Request("http://localhost/rpc/ethereum", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      })
    );

    // CORS plugin responded — no upstream call was made.
    expect(lastCall).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});
