/**
 * @fileoverview Process pino logger (ADR-005 §7). Import {@link logger} and
 * pass `module` (plus any other fields) on the call. Extra sinks deferred.
 *
 * Pretty stdout from the first import (the documented default). Boot calls
 * {@link configureLogger} so `"json"` replaces it. `lib/` must not import
 * `runtime`.
 */

import pino, { type Logger } from 'pino';

import type { LoggingConfig } from './config/schema.js';

export type { Logger };

function buildLogger(logging: LoggingConfig): Logger {
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

/** Process logger. Pretty from import; {@link configureLogger} applies json. */
export let logger: Logger = buildLogger({ stdout: 'pretty' });

/** Apply `config.logging`. No-op when stdout is already pretty. */
export function configureLogger(logging: LoggingConfig): void {
  if (logging.stdout === 'pretty') {
    return;
  }
  logger = buildLogger(logging);
}
