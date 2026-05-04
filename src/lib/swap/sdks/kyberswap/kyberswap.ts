/**
 * KyberSwap Aggregator API client
 * --------------------------------
 * Thin, typed wrapper over the three KyberSwap Aggregator endpoints
 * documented in `KyberSwapAggregator_EVMAPIs_v2.12.1.yaml`:
 *
 *   GET  /{chain}/route/encode         — legacy single-shot route + encode
 *   GET  /{chain}/api/v1/routes        — V1 route preview (with RFQ)
 *   POST /{chain}/api/v1/route/build   — V1 build calldata from a route
 *
 * Typical V1 flow:
 *   const route = await client.getRoute({ tokenIn, tokenOut, amountIn });
 *   const tx    = await client.buildRoute({
 *     routeSummary: route.routeSummary,
 *     sender, recipient,
 *     slippageTolerance: 50, // 0.5%
 *   });
 *   // submit tx.data to tx.routerAddress with value = tx.transactionValue
 */

// --- Constants -------------------------------------------------------------

/**
 * KyberSwap's sentinel address for the chain's native token (ETH, BNB, ...).
 * Use this for `tokenIn` or `tokenOut` instead of the wrapped address when
 * you want to swap from/to the native asset directly.
 */
export const KYBER_NATIVE_TOKEN_ADDRESS =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/**
 * The frontend convention (Uniswap-style) is to represent the native token
 * with the zero address; KyberSwap uses the `0xEeee…EeeE` sentinel above.
 * Anywhere a caller hands us a token address, we translate the zero address
 * to KyberSwap's sentinel transparently so the frontend doesn't have to know.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function normalizeNativeAddress(address: string): string {
  return address.toLowerCase() === ZERO_ADDRESS
    ? KYBER_NATIVE_TOKEN_ADDRESS
    : address;
}

const KYBER_NATIVE_LOWER = KYBER_NATIVE_TOKEN_ADDRESS.toLowerCase();

/**
 * Reverse of `normalizeNativeAddress`: rewrites KyberSwap's native sentinel
 * back to the zero address so frontends keep seeing their preferred form.
 * Applied to every token-address field on returned response shapes.
 */
function denormalizeNativeAddress(address: string): string {
  return address.toLowerCase() === KYBER_NATIVE_LOWER ? ZERO_ADDRESS : address;
}

function denormalizeSwapSequence(seq: SwapSequence): SwapSequence {
  return {
    ...seq,
    tokenIn: denormalizeNativeAddress(seq.tokenIn),
    tokenOut: denormalizeNativeAddress(seq.tokenOut),
  };
}

function denormalizeRouteSummary(rs: RouteSummary): RouteSummary {
  return {
    ...rs,
    tokenIn: denormalizeNativeAddress(rs.tokenIn),
    tokenOut: denormalizeNativeAddress(rs.tokenOut),
    route: rs.route.map((hops) => hops.map(denormalizeSwapSequence)),
  };
}

function denormalizeTokenMap(
  tokens: Record<string, SwapTokenInfo> | undefined
): Record<string, SwapTokenInfo> | undefined {
  if (!tokens) return tokens;
  // The map is keyed by address, so we need to rewrite both the key and the
  // `address` field on the value.
  const out: Record<string, SwapTokenInfo> = {};
  for (const [key, info] of Object.entries(tokens)) {
    const newKey = denormalizeNativeAddress(key);
    out[newKey] = { ...info, address: denormalizeNativeAddress(info.address) };
  }
  return out;
}

const DEFAULT_BASE_URL = "https://aggregator-api.kyberswap.com";

// --- Chain identifiers -----------------------------------------------------

/**
 * Chain slugs accepted in the `{chain}` path segment. The string union covers
 * the chains listed in KyberSwap's docs at the time of writing; falling back
 * to `(string & {})` keeps autocomplete while still letting callers pass new
 * slugs as KyberSwap adds support without an SDK update.
 */
export type KyberSwapChain =
  | "ethereum"
  | "bsc"
  | "polygon"
  | "polygon-zkevm"
  | "arbitrum"
  | "optimism"
  | "avalanche"
  | "base"
  | "fantom"
  | "cronos"
  | "scroll"
  | "linea"
  | "blast"
  | "mantle"
  | "zksync"
  | "berachain"
  | "sonic"
  | "ronin"
  // deno-lint-ignore ban-types
  | (string & {});

// --- Shared schemas --------------------------------------------------------

export type ChargeFeeBy = "currency_in" | "currency_out";

/** One hop in a swap path. */
export interface SwapSequence {
  pool: string;
  tokenIn: string;
  tokenOut: string;
  swapAmount: string;
  amountOut: string;
  exchange: string;
  poolType: string;
  poolExtra: Record<string, unknown> | null;
  extra: Record<string, unknown> | null;
}

export interface ExtraFee {
  feeAmount: string;
  chargeFeeBy?: ChargeFeeBy;
  isInBps?: boolean;
  feeReceiver?: string;
}

/**
 * Token metadata returned alongside some swap responses (not in the formal
 * schema but observed in `SampleResponseSwap`). Address-keyed.
 */
export interface SwapTokenInfo {
  address: string;
  symbol: string;
  name: string;
  price: number;
  decimals: number;
}

// --- /{chain}/route/encode -------------------------------------------------

export interface RouteEncodeParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  /** Recipient of the output token. */
  to: string;
  /** Comma-separated DEX IDs to restrict routing to. */
  dexes?: string;
  onlyScalableSources?: boolean;
  gasInclude?: boolean;
  /** Custom gas price in wei. Omit to use `eth_gasPrice`. */
  gasPrice?: string;
  /** Slippage tolerance in bps (10 = 0.1%, range 0–2000). */
  slippageTolerance?: number;
  chargeFeeBy?: ChargeFeeBy;
  feeReceiver?: string;
  isInBps?: boolean;
  feeAmount?: string;
  /** Unix epoch seconds. Default: now + 20 minutes. */
  deadline?: string;
  clientData?: string;
  referral?: string;
  permit?: string;
  /** Bypass the slippage cap. Use with caution. */
  ignoreCappedSlippage?: boolean;
}

export interface RouteEncodeResult {
  inputAmount: string;
  outputAmount: string;
  totalGas: number;
  gasPriceGwei?: string;
  gasUsd: number;
  amountInUsd: number;
  amountOutUsd: number;
  receivedUsd: number;
  swaps: SwapSequence[][];
  encodedSwapData: string;
  routerAddress: string;
  /** Address-keyed token metadata. Present in observed responses. */
  tokens?: Record<string, SwapTokenInfo>;
}

// --- /{chain}/api/v1/routes ------------------------------------------------

export interface GetRouteParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  /** Comma-separated DEX IDs to include. */
  includedSources?: string;
  /** Comma-separated DEX IDs to exclude. */
  excludedSources?: string;
  excludeRFQSources?: boolean;
  onlyScalableSources?: boolean;
  onlyDirectPools?: boolean;
  onlySinglePath?: boolean;
  /** Defaults to `true` server-side. */
  gasInclude?: boolean;
  gasPrice?: string;
  /** Single value, or comma-separated for multi-receiver. */
  feeAmount?: string;
  chargeFeeBy?: ChargeFeeBy;
  isInBps?: boolean;
  /** Single address, or comma-separated for multi-receiver. */
  feeReceiver?: string;
  /** End-user wallet — unlocks RFQ liquidity and avoids per-sender rate limits. */
  origin?: string;
}

export interface RouteSummary {
  tokenIn: string;
  amountIn: string;
  amountInUsd: string;
  tokenOut: string;
  amountOut: string;
  amountOutUsd: string;
  gas: string;
  gasPrice: string;
  gasUsd: string;
  l1FeeUsd?: string;
  extraFee?: ExtraFee;
  route: SwapSequence[][];
  routeID: string;
  checksum: string;
  /** ISO string or Unix epoch — the API returns numbers in practice. */
  timestamp: string | number;
}

export interface GetRouteData {
  routeSummary: RouteSummary;
  routerAddress: string;
}

// --- /{chain}/api/v1/route/build -------------------------------------------

export interface BuildRouteParams {
  /** Pass through the `routeSummary` object exactly as returned by `getRoute`. */
  routeSummary: RouteSummary;
  /** Address the input tokens will be transferred from. */
  sender: string;
  /** Address that receives the output tokens. */
  recipient: string;
  origin?: string;
  permit?: string;
  /** Unix seconds. Default: now + 20 minutes. */
  deadline?: number;
  /** Slippage tolerance in bps (10 = 0.1%, range 0–2000). */
  slippageTolerance?: number;
  ignoreCappedSlippage?: boolean;
  enableGasEstimation?: boolean;
  source?: string;
  referral?: string;
}

export interface BuildRouteData {
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutUsd: string;
  gas: string;
  gasUsd: string;
  additionalCostUsd?: string;
  additionalCostMessage?: string;
  /** Calldata to send to `routerAddress`. */
  data: string;
  routerAddress: string;
  /** `msg.value` to attach (non-zero only for native-token swaps). */
  transactionValue: string;
}

// --- Generic envelope ------------------------------------------------------

export interface KyberSwapApiEnvelope<T> {
  code: number;
  message?: string;
  data: T;
  requestId?: string;
}

export interface KyberSwapApiError {
  code: number;
  message: string;
  requestId: string;
  details?: unknown;
}

// --- Error -----------------------------------------------------------------

/**
 * Thrown for any non-2xx response or any 2xx response whose envelope `code`
 * is non-zero. Carries the upstream `code`, `requestId`, and parsed details
 * so callers can branch on the documented error codes (4001, 4008, 4011, ...).
 */
export class KyberSwapError extends Error {
  readonly code: number;
  readonly status: number;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(args: {
    message: string;
    code: number;
    status: number;
    requestId?: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = "KyberSwapError";
    this.code = args.code;
    this.status = args.status;
    this.requestId = args.requestId;
    this.details = args.details;
  }
}

// --- Client options --------------------------------------------------------

export interface KyberSwapClientOptions {
  /**
   * `X-Client-Id` value. Required by KyberSwap to attribute usage and avoid
   * the harsher anonymous rate limit.
   */
  clientId: string;
  /** Override the API host (e.g. for staging). */
  baseUrl?: string;
  /**
   * If set on the client, every method may omit its own `chain` and use
   * this default. Per-call `chain` always wins.
   */
  defaultChain?: KyberSwapChain;
  /** Custom fetch implementation (testing, retries, instrumentation). */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Omit to disable. */
  timeoutMs?: number;
}

export interface CallOptions {
  /** Override the chain for this single call. */
  chain?: KyberSwapChain;
  /** External AbortSignal — composes with `timeoutMs` if both are set. */
  signal?: AbortSignal;
}

// --- Client ----------------------------------------------------------------

export class KyberSwapClient {
  private readonly clientId: string;
  private readonly baseUrl: string;
  private readonly defaultChain?: KyberSwapChain;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(options: KyberSwapClientOptions) {
    if (!options.clientId) {
      throw new Error("KyberSwapClient: clientId is required");
    }
    this.clientId = options.clientId;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.defaultChain = options.defaultChain;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * `GET /{chain}/route/encode` — find a route and return the encoded
   * calldata in a single round-trip. Cannot use RFQ liquidity sources;
   * prefer `getRoute` + `buildRoute` for production swaps.
   */
  async getRouteEncode(
    params: RouteEncodeParams,
    options: CallOptions = {}
  ): Promise<RouteEncodeResult> {
    const chain = this.resolveChain(options.chain);
    const normalized: RouteEncodeParams = {
      ...params,
      tokenIn: normalizeNativeAddress(params.tokenIn),
      tokenOut: normalizeNativeAddress(params.tokenOut),
    };
    const url = `${this.baseUrl}/${chain}/route/encode${toQueryString(normalized)}`;
    const result = await this.request<RouteEncodeResult>(
      "GET",
      url,
      undefined,
      options.signal
    );
    return {
      ...result,
      swaps: result.swaps.map((hops) => hops.map(denormalizeSwapSequence)),
      tokens: denormalizeTokenMap(result.tokens),
    };
  }

  /**
   * `GET /{chain}/api/v1/routes` — get a route preview, including RFQ
   * liquidity. The returned `routeSummary` is meant to be passed verbatim
   * into `buildRoute` once the user confirms the swap.
   */
  async getRoute(
    params: GetRouteParams,
    options: CallOptions = {}
  ): Promise<GetRouteData> {
    const chain = this.resolveChain(options.chain);
    const normalized: GetRouteParams = {
      ...params,
      tokenIn: normalizeNativeAddress(params.tokenIn),
      tokenOut: normalizeNativeAddress(params.tokenOut),
    };
    const url = `${this.baseUrl}/${chain}/api/v1/routes${toQueryString(normalized)}`;
    const envelope = await this.request<KyberSwapApiEnvelope<GetRouteData>>(
      "GET",
      url,
      undefined,
      options.signal
    );
    this.assertOk(envelope);
    return {
      ...envelope.data,
      routeSummary: denormalizeRouteSummary(envelope.data.routeSummary),
    };
  }

  /**
   * `POST /{chain}/api/v1/route/build` — turn a `routeSummary` from
   * `getRoute` into broadcastable calldata. The route's `checksum` field
   * binds the body to the previously-returned route, so do not mutate it.
   */
  async buildRoute(
    body: BuildRouteParams,
    options: CallOptions = {}
  ): Promise<BuildRouteData> {
    const chain = this.resolveChain(options.chain);
    // Defensive: a routeSummary returned from `getRoute` already has the
    // sentinel, but a caller might construct one by hand with zero addresses.
    const normalized: BuildRouteParams = {
      ...body,
      routeSummary: {
        ...body.routeSummary,
        tokenIn: normalizeNativeAddress(body.routeSummary.tokenIn),
        tokenOut: normalizeNativeAddress(body.routeSummary.tokenOut),
      },
    };
    const url = `${this.baseUrl}/${chain}/api/v1/route/build`;
    const envelope = await this.request<KyberSwapApiEnvelope<BuildRouteData>>(
      "POST",
      url,
      normalized,
      options.signal
    );
    this.assertOk(envelope);
    return envelope.data;
  }

  // --- internals -----------------------------------------------------------

  private resolveChain(perCall?: KyberSwapChain): KyberSwapChain {
    const chain = perCall ?? this.defaultChain;
    if (!chain) {
      throw new Error(
        "KyberSwapClient: chain must be supplied either via `defaultChain` " +
          "in the constructor or `options.chain` on the call"
      );
    }
    return chain;
  }

  private assertOk<T>(envelope: KyberSwapApiEnvelope<T>): void {
    // V1 endpoints wrap responses in { code, message, data }. `code === 0`
    // is success; anything else is a failure even if HTTP returned 200.
    if (envelope.code !== 0) {
      throw new KyberSwapError({
        message: envelope.message ?? `KyberSwap error code ${envelope.code}`,
        code: envelope.code,
        status: 200,
        requestId: envelope.requestId,
      });
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    url: string,
    body: unknown,
    externalSignal?: AbortSignal
  ): Promise<T> {
    const headers: Record<string, string> = {
      "X-Client-Id": this.clientId,
      // `x-client-id` is the casing used by `route/build`'s spec; send both
      // to be safe — HTTP headers are case-insensitive but some proxies sniff.
      "x-client-id": this.clientId,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const { signal, cancel } = composeSignals(externalSignal, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } finally {
      cancel();
    }

    const text = await response.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined;

    if (!response.ok) {
      const err = (parsed as Partial<KyberSwapApiError> | undefined) ?? {};
      throw new KyberSwapError({
        message:
          err.message ??
          `KyberSwap HTTP ${response.status} ${response.statusText}`,
        code: err.code ?? response.status,
        status: response.status,
        requestId: err.requestId,
        details: err.details ?? parsed,
      });
    }

    return parsed as T;
  }
}

// --- helpers ---------------------------------------------------------------

/**
 * Build a `?key=value&...` query string from a flat params object. Skips
 * `undefined` and `null`, stringifies booleans as `"true"`/`"false"`, and
 * URL-encodes everything. Returns `""` if the resulting string is empty so
 * callers can concatenate unconditionally.
 */
function toQueryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, typeof value === "boolean" ? String(value) : String(value));
  }
  const s = search.toString();
  return s.length > 0 ? `?${s}` : "";
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Combine an optional external AbortSignal with an optional timeout into a
 * single signal, returning a `cancel()` to clear the timeout once the
 * request settles (so we don't leak timers on success).
 */
function composeSignals(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal | undefined; cancel: () => void } {
  if (!external && !timeoutMs) return { signal: undefined, cancel: () => {} };

  const controller = new AbortController();
  const onAbort = () => controller.abort((external as any)?.reason);
  external?.addEventListener("abort", onAbort, { once: true });

  const timer = timeoutMs
    ? setTimeout(
        () => controller.abort(new Error(`KyberSwap request timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    : undefined;

  return {
    signal: controller.signal,
    cancel: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}
