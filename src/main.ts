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
import { createProvisioningService } from './engine/provisioning.js';
import { createTokenService } from './engine/token.js';
import { createWebhookService } from './engine/webhook/service.js';
import { createWebhookStore } from './engine/webhook/store.js';
import { createAdmissionStore } from './lib/redis-repository/admission-store.js';
import { redis } from './lib/redis-repository/client.js';
import { createMessageStore } from './lib/redis-repository/message-store.js';
import { createStageStore } from './lib/redis-repository/stage-store.js';
import { createMetrics } from './metrics/index.js';

/** Default listen port (ADR-005 §3); overridable via `PORT`. */
const DEFAULT_PORT = 3100;

/**
 * How long shutdown waits for in-flight `sendOne`s (ADR-008 §8).
 * Sized for a typical 30 s termination grace — not the 120 s client safety deadline.
 */
const SHUTDOWN_SEND_DRAIN_BUDGET_MS = 20_000;

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

const admissionStore = createAdmissionStore({ client: redis });
const messageStore = createMessageStore({ client: redis });
const stageStore = createStageStore({ client: redis });
const stageMoves = createStageMoves({
  delivery: config.delivery,
  metrics,
  stageStore,
});

const baseService = createBaseService({
  delivery: config.delivery,
  webhook: webhookService,
  messageStore,
  moves: stageMoves,
  metrics,
});
/** One per process: the sender registers here, the `ns` stage row consults it (ADR-008 §8). */
const inFlightSends = createInFlightSends();

const outgoingService = createOutgoingService({
  registry: pluginRegistry,
  delivery: config.delivery,
  baseService,
  inFlightSends,
  engineEnabled: config.engine.enabled,
  admissionStore,
  messageStore,
  moves: stageMoves,
  metrics,
});
const incomingService = createIncomingService({
  baseService,
  messageStore,
  moves: stageMoves,
  metrics,
});

/** The stage table's runtime half: what to do per stage, and the loop that drives it. */
const stageActions = createStageActions({
  baseService,
  incomingService,
  moves: stageMoves,
  inFlightSends,
  metrics,
});
const lifecycleRunner = createLifecycleRunner({
  registry: pluginRegistry,
  actions: stageActions,
  moves: stageMoves,
  messageStore,
  stageStore,
  distribute: outgoingService.distributeToNetworkServers,
});
const tokenService = createTokenService({
  registry: pluginRegistry,
});
const provisioningService = createProvisioningService({
  registry: pluginRegistry,
});

const app = await buildApp({
  outgoingService,
  incomingService,
  tokenService,
  provisioningService,
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

/** Stop timers → stop enqueue-kick → drain in-flight sends (bounded) → close HTTP → quit Redis. */
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info({ signal, budgetMs: SHUTDOWN_SEND_DRAIN_BUDGET_MS }, 'shutdown');

  engineTimers.stop();
  webhookTimers?.stop();
  outgoingService.stopEnqueueKick();

  const abandoned = await outgoingService.drainInFlightSends(SHUTDOWN_SEND_DRAIN_BUDGET_MS);

  if (abandoned > 0) {
    logger.warn({ abandoned }, 'shutdown — abandoned in-flight sends');
  }

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
