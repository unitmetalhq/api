/**
 * RpcService
 * ----------
 * Stateless helper that forwards an inbound HTTP request to an upstream URL
 * and returns the upstream's response. Used by the /rpc/* controllers to
 * implement an IP-obfuscating JSON-RPC proxy.
 *
 * Design goals:
 *   1. The upstream provider sees only this server's IP and a generic
 *      User-Agent — nothing that fingerprints the end-user's browser.
 *   2. The request/response body is forwarded byte-for-byte so the proxy
 *      is a transparent drop-in for the upstream RPC URL.
 *   3. Nothing about the customer is logged or persisted.
 */

/**
 * Allowlist of request headers that are safe to forward upstream.
 *
 * We use an allowlist (not a denylist) so any *new* identifying header a
 * browser starts sending (client hints, fetch metadata, etc.) is blocked
 * by default rather than leaking until we remember to add it to a blocklist.
 *
 * For Ethereum JSON-RPC, `content-type: application/json` is the only
 * strictly required header; `accept` is kept because some providers use
 * it for content negotiation.
 */
const FORWARD_HEADERS = new Set(["content-type", "accept"]);

/**
 * Fixed User-Agent sent upstream for every request, overwriting whatever
 * the browser sent. This makes all outbound traffic look identical to the
 * provider — they cannot distinguish one of our customers from another.
 */
const PROXY_USER_AGENT = "unitmetal-api/1.0";

export abstract class RpcService {
  /**
   * Forward `request` to `upstream` and return the upstream's response.
   *
   * The function does not inspect or mutate the body — it streams bytes
   * through in both directions. No logging occurs at any step.
   */
  static async proxy(request: Request, upstream: string): Promise<Response> {
    // Build the outbound header set from scratch. Anything not in
    // FORWARD_HEADERS (user-agent, accept-language, sec-ch-ua-*,
    // sec-fetch-*, referer, origin, cookie, x-forwarded-*, etc.) is
    // silently dropped, which is the whole point of the proxy.
    const outboundHeaders = new Headers();
    for (const [key, value] of request.headers) {
      if (FORWARD_HEADERS.has(key.toLowerCase())) {
        outboundHeaders.set(key, value);
      }
    }

    // Overwrite User-Agent with a fixed value. Set *after* the loop so
    // it always wins even if `user-agent` were ever added to the allowlist.
    outboundHeaders.set("user-agent", PROXY_USER_AGENT);

    const init: RequestInit = {
      method: request.method,
      headers: outboundHeaders,
      // Follow redirects transparently so the client sees the final
      // response, not a 3xx it cannot act on (upstream URL may change).
      redirect: "follow",
    };

    // GET/HEAD must not carry a body per the fetch spec; reading
    // `.arrayBuffer()` on a bodyless request would still succeed but
    // attaching it to the RequestInit would throw.
    if (request.method !== "GET" && request.method !== "HEAD") {
      // `arrayBuffer()` buffers the full body in memory. This is fine for
      // JSON-RPC payloads (kilobytes at most). The buffer is held only for
      // the duration of the outbound fetch, then garbage-collected.
      init.body = await request.arrayBuffer();
    }

    const response = await fetch(upstream, init);

    // Copy the upstream's response headers, but strip hop-by-hop / encoding
    // headers that describe the *upstream's* wire format. Bun's fetch has
    // already decompressed the body for us, so forwarding `content-encoding`
    // would make the browser try to decode again and fail. Similarly
    // `content-length` / `transfer-encoding` no longer reflect what we're
    // about to send.
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");

    // Stream the response body straight through (no buffering). Status
    // code and statusText are preserved so JSON-RPC error responses
    // (which use HTTP 200 with an error object, but also provider-level
    // 4xx/5xx) reach the client unchanged.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }
}
