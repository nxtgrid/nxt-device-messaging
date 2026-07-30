import Fastify, { type FastifyInstance } from 'fastify';

import {
  messageRoutes,
  type MessageRoutesOpts,
} from './http/message-routes.js';
import { createMessageStore } from './http/message-store.js';

export type BuildAppOptions = {
  readonly pluginRegistry: MessageRoutesOpts['pluginRegistry'];
  /** When set, command routes require Bearer auth (ADR-003 §5). */
  readonly apiKey?: string;
  /** Defaults to a fresh in-memory store (I2; Redis in I3). */
  readonly messageStore?: MessageRoutesOpts['messageStore'];
};

/**
 * Builds the HTTP application (ADR-001). Ops probes stay unauthenticated (ADR-005 §5).
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.get('/healthz', async () => {
    return { ok: true as const };
  });

  await app.register(messageRoutes, {
    pluginRegistry: options.pluginRegistry,
    messageStore: options.messageStore ?? createMessageStore(),
    apiKey: options.apiKey,
  });

  return app;
}
