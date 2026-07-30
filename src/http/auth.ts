/**
 * @fileoverview Command-API Bearer auth (ADR-003 §5).
 *
 * When `apiKey` is unset/empty, the hook is a no-op (local skeleton). Production
 * must set `DEVICE_MESSAGING_API_KEY`.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Returns an `onRequest` hook that requires `Authorization: Bearer <apiKey>`
 * when a key is configured.
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
