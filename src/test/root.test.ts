/**
 * Tests for the root `/` endpoint.
 *
 * We reconstruct the app instead of importing `src/index.ts` because the
 * latter calls `.listen(8000)` at import time, which would bind the port
 * during the test run.
 */

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

const app = new Elysia().get("/", () => "Hello, World!");

describe("GET /", () => {
  test("returns Hello, World! with 200", async () => {
    const res = await app.handle(new Request("http://localhost/"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Hello, World!");
  });

  test("unknown route returns 404", async () => {
    const res = await app.handle(new Request("http://localhost/does-not-exist"));

    expect(res.status).toBe(404);
  });
});
