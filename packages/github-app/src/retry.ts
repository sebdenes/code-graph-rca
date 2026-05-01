/**
 * Retry an Octokit-shaped async call on transient failures.
 *
 * Background: GitHub's API occasionally returns 5xx / 429 or drops the
 * connection mid-write (EPIPE / ECONNRESET). The PR-review action ran into
 * exactly this on `GET /repos/.../issues/3/comments` — a 500 from the API,
 * which led to an EPIPE during fetch's response read. Without retry, the
 * whole action exits 1 and the PR never gets a comment, even though the
 * underlying repo state is fine and a second attempt would succeed.
 *
 * Behavior:
 * - Retries on Octokit `RequestError` with `status` 429 or 5xx.
 * - Retries on network-class errors (EPIPE, ECONNRESET, ECONNREFUSED,
 *   ETIMEDOUT, EAI_AGAIN) regardless of how they bubble up.
 * - 4xx other than 429 raises immediately — those are real, not transient.
 * - Final failure after `maxRetries+1` attempts re-raises the last error
 *   so the action still surfaces a real outage rather than silently
 *   succeeding on bad data.
 * - Honors `Retry-After` for 429 / secondary rate-limit responses, capped
 *   at 60s so a misbehaving header doesn't stall a CI job for an hour.
 */

import { setTimeout as sleep } from "node:timers/promises";

const TRANSIENT_NET_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

interface RetryOpts {
  name: string;
  maxRetries?: number;
  backoffBase?: number;
}

interface MaybeOctokitError {
  status?: number;
  code?: string;
  cause?: { code?: string };
  response?: { headers?: Record<string, string> };
}

function isTransientStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

function networkErrorCode(err: unknown): string | null {
  const e = err as MaybeOctokitError;
  if (e.code && TRANSIENT_NET_CODES.has(e.code)) return e.code;
  if (e.cause?.code && TRANSIENT_NET_CODES.has(e.cause.code)) return e.cause.code;
  // Octokit wraps fetch errors; sometimes the original code is in the message.
  const msg = (err as { message?: string }).message ?? "";
  for (const code of TRANSIENT_NET_CODES) {
    if (msg.includes(code)) return code;
  }
  return null;
}

function retryAfterSeconds(err: unknown, fallback: number): number {
  const e = err as MaybeOctokitError;
  const raw = e.response?.headers?.["retry-after"];
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 60);
  }
  return Math.min(fallback, 60);
}

export async function withRetry<T>(
  factory: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const backoffBase = opts.backoffBase ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await factory();
    } catch (err) {
      lastErr = err;
      const e = err as MaybeOctokitError;
      const status = e.status;
      const netCode = networkErrorCode(err);
      const transient = isTransientStatus(status) || netCode !== null;
      if (!transient || attempt === maxRetries) {
        throw err;
      }
      const exp = backoffBase * 2 ** attempt;
      const delay = status === 429
        ? retryAfterSeconds(err, exp)
        : exp;
      // eslint-disable-next-line no-console
      console.warn(
        `[cgrca-pr-review] ${opts.name} transient ${status ?? netCode ?? "error"} on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${delay.toFixed(1)}s`,
      );
      await sleep(delay * 1000);
    }
  }
  throw lastErr;
}
