/**
 * @fileoverview Compose engine peers the way `src/main.ts` does, for specs that
 * drive the stage table through {@link LifecycleRunner.tick}.
 */

import type { DeliveryConfig } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import {
  createInFlightSends,
  type InFlightSends,
} from '#src/engine/in-flight-sends.js';
import { createIncomingService, type IncomingService } from '#src/engine/incoming.js';
import { createStageActions } from '#src/engine/lifecycle/actions.js';
import { createStageMoves } from '#src/engine/lifecycle/moves.js';
import {
  createLifecycleRunner,
  type LifecycleRunner,
} from '#src/engine/lifecycle/runner.js';
import { createOutgoingService, type OutgoingService } from '#src/engine/outgoing.js';
import type { WebhookService } from '#src/engine/webhook/service.js';
import type { MetricsRecorder } from '#src/metrics/index.js';
import type { PluginRegistry } from '#src/plugins/registry.js';
import { noopMetrics } from './noop-metrics.js';

/** Engine peers plus the runner that replaces the old cycle / poll entry points. */
export type EngineHarness = {
  readonly outgoing: OutgoingService;
  readonly incoming: IncomingService;
  readonly runner: LifecycleRunner;
  /** Shared with the runner's `ns` row. */
  readonly inFlightSends: InFlightSends;
};

/** Dependencies for {@link createEngineHarness}. */
export type CreateEngineHarnessOptions = {
  readonly registry: PluginRegistry;
  readonly delivery: DeliveryConfig;
  readonly metrics?: MetricsRecorder;
  /** Pass as `webhook` to {@link createBaseService}. */
  readonly webhook?: Pick<WebhookService, 'storeAndEmit'>;
  /**
   * Defaults to **false**, unlike production: a spec almost always wants the message to
   * stay `QUEUED` until it drives distribution itself. Pass true to exercise the kick.
   */
  readonly engineEnabled?: boolean;
  /** Shared with outgoing and the runner's `ns` row; omit for a fresh instance. */
  readonly inFlightSends?: InFlightSends;
};

/**
 * Wire base, outgoing, incoming, stage moves/actions, and the lifecycle runner
 * exactly as `src/main.ts` does.
 *
   * @param options - Registry, delivery knobs, optional webhook / metrics / engine gate
 */
export function createEngineHarness(
  options: CreateEngineHarnessOptions,
): EngineHarness {
  const metrics = options.metrics ?? noopMetrics;
  const inFlightSends = options.inFlightSends ?? createInFlightSends();

  const baseService = createBaseService({
    delivery: options.delivery,
    webhook: options.webhook,
    metrics,
  });
  const outgoing = createOutgoingService({
    registry: options.registry,
    delivery: options.delivery,
    baseService,
    inFlightSends,
    metrics,
    engineEnabled: options.engineEnabled ?? false,
  });
  const incoming = createIncomingService({
    delivery: options.delivery,
    baseService,
    metrics,
  });
  const moves = createStageMoves({ delivery: options.delivery, metrics });
  const actions = createStageActions({
    baseService,
    incomingService: incoming,
    moves,
    inFlightSends,
    delivery: options.delivery,
    metrics,
  });
  const runner = createLifecycleRunner({
    registry: options.registry,
    actions,
    moves,
    distribute: outgoing.distributeToNetworkServers,
  });

  return { outgoing, incoming, runner, inFlightSends };
}
