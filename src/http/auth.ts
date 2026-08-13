/**
 * @fileoverview Command-API Bearer auth (ADR-003 §5) — opt-in.
 *
 * When `apiKey` is set, require `Authorization: Bearer <apiKey>`. When unset/empty,
 * the hook is a no-op (local / quick-start, or operator choice — private network,
 * reverse-proxy auth, etc.).
 *
 * Comparison is timing-safe (`crypto.timingSafeEqual`) so rejection time does not
 * leak the first mismatch offset. Length mismatch still returns early (same as
 * webhook signature verify).
 */

import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

const UNAUTHORIZED_BODY = { error: 'Unauthorized' } as const;
const BEARER_PREFIX = 'bearer ';

/**
 * Returns an `onRequest` hook that enforces Bearer auth only when `apiKey` is configured.
 */
export function createApiKeyHook(
  apiKey: string | undefined,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    if (apiKey === undefined || apiKey === '') {
      return;
    }

    const presented = presentedBearerToken(request.headers.authorization);
    if (presented === undefined || !timingSafeEqualUtf8(presented, apiKey)) {
      return reply.code(401).send(UNAUTHORIZED_BODY);
    }
  };
}

/**
 * Extract the token after a case-insensitive `Bearer ` scheme.
 * Extra spaces in the scheme separator are not accepted.
 */
function presentedBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string' || header.length <= BEARER_PREFIX.length) {
    return undefined;
  }
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return undefined;
  }
  return header.slice(BEARER_PREFIX.length);
}

/** Constant-time equality for equal-length utf8 strings; `false` on length mismatch. */
function timingSafeEqualUtf8(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, 'utf8');
  const rightBuf = Buffer.from(right, 'utf8');
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}
