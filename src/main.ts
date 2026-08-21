import { config, logger, pluginRegistry } from './runtime.js';

import { buildApp } from './app.js';
import { createBaseService } from './engine/base.js';
import { createInFlightSends } from './engine/in-flight-sends.js';
import { createIncomingService } from './engine/incoming.js';
import { createStageActions } from './engine/lifecycle/actions.js';
import { createStageMoves } from './engine/lifecycle/moves.js';
import { createLifecycleRunner } from './engine/lifecycle/runner.js';
import { createOutgoingService } from './engine/outgoing.js';
import { startEngineTimers } from './engine/timers.js';
import { createTokenService } from './engine/token.js';
import { createWebhookService } from './engine/webhook/service.js';
import { createWebhookStore } from './engine/webhook/store.js';
import { createAdmissionStore } from './lib/redis-repository/admission-store.js';
import { redisRepo } from './lib/redis-repository/index.js';
import { createMetrics } from './metrics/index.js';

/** One connection for the process; webhook store and metrics share it. */
const redis = redisRepo.client;

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
  logger.warn(
    'eventWebhook.url is set but DEVICE_MESSAGING_WEBHOOK_SECRET is unset — POSTs will be unsigned',
  );
}

const metrics = createMetrics({
  redis,
  pullPluginIds: pluginRegistry.getByDeliveryPattern('PULL').map(plugin => plugin.id),
});

const webhookService = config.eventWebhook
  ? createWebhookService({
    config: config.eventWebhook,
    store: createWebhookStore({ client: redis }),
    signingSecret: webhookSigningSecret,
    metrics,
  })
  : undefined;

const baseService = createBaseService({
  delivery: config.delivery,
  webhook: webhookService,
  metrics,
});
/** One per process: the sender registers here, the `ns` stage row consults it (ADR-008 §8). */
const inFlightSends = createInFlightSends();
const admissionStore = createAdmissionStore({ client: redis });

const outgoingService = createOutgoingService({
  registry: pluginRegistry,
  delivery: config.delivery,
  baseService,
  inFlightSends,
  engineEnabled: config.engine.enabled,
  admissionStore,
  metrics,
});
const incomingService = createIncomingService({
  delivery: config.delivery,
  baseService,
  metrics,
});

/** The stage table's runtime half: what to do per stage, and the loop that drives it. */
const stageMoves = createStageMoves({ delivery: config.delivery, metrics });
const stageActions = createStageActions({
  baseService,
  incomingService,
  moves: stageMoves,
  inFlightSends,
  delivery: config.delivery,
  metrics,
});
const lifecycleRunner = createLifecycleRunner({
  registry: pluginRegistry,
  actions: stageActions,
  moves: stageMoves,
  distribute: outgoingService.distributeToNetworkServers,
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
  metrics,
});

const engineTimers = startEngineTimers({
  enabled: config.engine.enabled,
  runner: lifecycleRunner,
});

/** Webhook drain is independent of `engine.enabled` (ingress can still emit). */
const webhookTimers = webhookService?.startTimers();

const port = resolvePort();

await app.listen({ port, host: '0.0.0.0' });
logger.info({
  port,
  engineEnabled: config.engine.enabled,
  eventWebhook: config.eventWebhook ? 'on' : 'off',
  plugins: pluginRegistry.getAll().map(plugin => plugin.id),
}, 'listening');

/** Stop timers → close HTTP → quit Redis. Does not await in-flight ticks (v1). */
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info({ signal }, 'shutdown — stopping timers, Fastify, Redis');

  engineTimers.stop();
  webhookTimers?.stop();

  try {
    await app.close();
  }
  catch (err) {
    logger.error({ err }, 'Fastify close failed');
  }

  try {
    await redis.quit();
  }
  catch (err) {
    logger.error({ err }, 'Redis quit failed');
  }

  process.exit(0);
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
