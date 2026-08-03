import { buildApp } from './app.js';
import { createBaseService } from './engine/base.js';
import { createIncomingService } from './engine/incoming.js';
import { createOutgoingService } from './engine/outgoing.js';
import { createTokenService } from './engine/token.js';
import { config, pluginRegistry } from './runtime.js';

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
 * Composition root — runtime already booted; wire peer services, then Fastify.
 */
const baseService = createBaseService({
  registry: pluginRegistry,
  delivery: config.delivery,
});
const outgoingService = createOutgoingService({
  registry: pluginRegistry,
  delivery: config.delivery,
  baseService,
});
const incomingService = createIncomingService({
  registry: pluginRegistry,
  delivery: config.delivery,
  baseService,
});
const tokenService = createTokenService({
  registry: pluginRegistry,
});

const app = await buildApp({
  outgoingService,
  incomingService,
  tokenService,
  registry: pluginRegistry,
  apiKey: process.env.DEVICE_MESSAGING_API_KEY,
});
const port = resolvePort();

await app.listen({ port, host: '0.0.0.0' });
const pluginIds = pluginRegistry.getAll().map(plugin => plugin.id).join(',') || '(none)';
console.info(
  `nxt-device-messaging listening on :${ port } (engine.enabled=${ config.engine.enabled }, plugins=${ pluginIds })`,
);
