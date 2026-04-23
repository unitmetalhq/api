/**
 * Client identification for rate limiting
 * ---------------------------------------
 * Turns a raw client IP into an opaque identifier that rate-limit stores
 * can bucket on without keeping IPs in memory.
 *
 * The salt is generated once per process and never persisted. Restart =
 * new salt, so cached hashes from a previous run cannot be correlated.
 * The LRU/rate-limit store only ever sees the hex digest.
 */

import { createHash, randomBytes } from "node:crypto";

const IP_HASH_SALT = randomBytes(32);

/**
 * SHA-256(salt || ip) as a hex string. Salt is prepended for domain
 * separation (output cannot be confused with a plain SHA-256(ip) lookup
 * against a precomputed table of known IPs).
 */
export const hashClientIp = (ip: string): string =>
  createHash("sha256").update(IP_HASH_SALT).update(ip).digest("hex");
