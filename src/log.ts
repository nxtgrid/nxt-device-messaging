/**
 * @fileoverview Process root pino logger (ADR-005 §7). One instance; Fastify
 * and domain code share it. Extra sinks (Loki, Datadog) are deferred.
 */

import pino, { type Logger } from 'pino';

import type { LoggingConfig } from './config/schema.js';

export type { Logger };

/**
 * Builds the process logger from `config.logging`.
 * Pretty stdout is the default; `"json"` is the aggregator opt-in.
 */
export function createRootLogger(logging: LoggingConfig): Logger {
  const base = {
    name: 'device-messaging',
    level: 'info',
  } as const;

  if (logging.stdout === 'json') {
    return pino(base);
  }

  return pino({
    ...base,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: process.stdout.isTTY === true,
        ignore: 'pid,hostname',
        translateTime: 'SYS:standard',
      },
    },
  });
}
