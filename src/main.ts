import { buildApp } from './app.js';
import { loadConfig, getConfig } from './config/index.js';

/** Default listen port (ADR-005 §3); overridable via `PORT`. */
const DEFAULT_PORT = 3100;

function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid PORT "${ raw }"; expected a positive integer`);
  }
  return parsed;
}

/**
 * Composition root — loads config, builds the Fastify shell, listens.
 */
await loadConfig();
const config = getConfig();
const app = await buildApp();
const port = resolvePort();

await app.listen({ port, host: '0.0.0.0' });
console.info(
  `nxt-device-messaging listening on :${ port } (engine.enabled=${ config.engine.enabled }, plugins=${ config.plugins.length })`,
);
