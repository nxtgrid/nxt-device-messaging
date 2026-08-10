import { buildApp } from './app.js';
import { createBaseService } from './engine/base.js';
import { createIncomingService } from './engine/incoming.js';
import { createOutgoingService } from './engine/outgoing.js';
import { startEngineTimers } from './engine/timers.js';
import { createTokenService } from './engine/token.js';
import { createWebhookService } from './engine/webhook/service.js';
import { createWebhookStore } from './engine/webhook/store.js';
import { redisRepo } from './lib/redis-repository/index.js';
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
const webhookSigningSecret = process.env.DEVICE_MESSAGING_WEBHOOK_SECRET;

if (config.eventWebhook && (webhookSigningSecret === undefined || webhookSigningSecret === '')) {
  console.warn(
    '[webhook] eventWebhook.url is set but DEVICE_MESSAGING_WEBHOOK_SECRET is unset — POSTs will be unsigned',
  );
}

const webhookService = config.eventWebhook
  ? createWebhookService({
    config: config.eventWebhook,
    store: createWebhookStore({ client: redisRepo.client }),
    signingSecret: webhookSigningSecret,
  })
  : undefined;

const baseService = createBaseService({
  registry: pluginRegistry,
  delivery: config.delivery,
  webhook: webhookService,
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

startEngineTimers({
  enabled: config.engine.enabled,
  outgoingService,
  incomingService,
});

/** Webhook drain is independent of `engine.enabled` (ingress can still emit). */
if (webhookService) {
  webhookService.startTimers();
}

const port = resolvePort();

await app.listen({ port, host: '0.0.0.0' });
const pluginIds = `[${ pluginRegistry.getAll().map(plugin => plugin.id).join(', ') }]`;
const webhookLabel = config.eventWebhook ? 'on' : 'off';
console.info(
  `nxt-device-messaging listening on :${ port } (engine.enabled=${ config.engine.enabled }, eventWebhook=${ webhookLabel }, plugins=${ pluginIds })`,
);
