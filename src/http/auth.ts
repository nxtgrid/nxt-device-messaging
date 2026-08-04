/**
 * @fileoverview Command-API Bearer auth (ADR-003 §5) — opt-in.
 *
 * When `apiKey` is set, require `Authorization: Bearer <apiKey>`. When unset/empty,
 * the hook is a no-op (local / quick-start, or operator choice — private network,
 * reverse-proxy auth, etc.).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

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

    const header = request.headers.authorization;
    if (header !== `Bearer ${ apiKey }`) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };
}
