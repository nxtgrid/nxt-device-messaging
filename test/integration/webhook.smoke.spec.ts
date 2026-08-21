/**
 * Opt-in smoke: base emit → Redis webhook keys → drain POST (needs Valkey).
 *
 *   docker compose up -d valkey
 *   RUN_REDIS_SMOKE=1 pnpm exec vitest run test/integration/webhook.smoke.spec.ts
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { deviceMessagingConfigSchema } from '#src/config/schema.js';
import { createBaseService } from '#src/engine/base.js';
import { createWebhookService } from '#src/engine/webhook/service.js';
import {
  createWebhookStore,
  parseWebhookStoredRecord,
} from '#src/engine/webhook/store.js';
import { webhookRedisKeys } from '#src/engine/webhook/keys.js';
import { createMessageStore } from '#src/lib/redis-repository/message-store.js';
import { createStageStore } from '#src/lib/redis-repository/stage-store.js';
import { STUB_PUSH_ID } from '#src/plugins/stub/index.js';
import { noopMetrics } from '../helpers/noop-metrics.js';

const shouldRun = process.env.RUN_REDIS_SMOKE === '1';
const delivery = deviceMessagingConfigSchema.parse({ $schemaVersion: '1' }).delivery;

const WEBHOOK_CONFIG = {
  url: 'https://consumer.example/hooks/device-messages',
  maxAttempts: 6,
  baseDelayMs: 2000,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
  requestTimeoutMs: 10_000,
  deadLetterTtlSeconds: 604_800,
} as const;

describe.skipIf(!shouldRun)('webhook emit → Redis → POST', () => {
  let redis: typeof import('../../src/lib/redis-repository/client.js').redis;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  it('storeAndEmit via base drains and POSTs the WebhookEvent', async () => {
    ({ redis } = await import('../../src/lib/redis-repository/client.js'));

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const metrics = noopMetrics;
    const store = createWebhookStore({ client: redis });
    const webhookService = createWebhookService({
      config: WEBHOOK_CONFIG,
      store,
      metrics,
    });
    const baseService = createBaseService({
      delivery,
      webhook: webhookService,
      messageStore: createMessageStore({ client: redis }),
      stageStore: createStageStore({ client: redis }),
      metrics,
    });

    const correlationId = `webhook-smoke-${ Date.now() }`;
    const ownedEventIds = new Set<string>();

    try {
      await baseService.emitDeliveryEvent({
        pluginId: STUB_PUSH_ID,
        deliveryStatus: 'SENT_TO_NS',
        correlationId,
        device: {
          type: 'ELECTRICITY_METER',
          externalReference: 'smoke-meter',
        },
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const firstCall = fetchMock.mock.calls[0] as unknown as [
        string,
        { body?: string },
      ];
      expect(firstCall[0]).toBe(WEBHOOK_CONFIG.url);
      const body = JSON.parse(String(firstCall[1]?.body)) as {
        eventId: string;
        pluginId: string;
        message: { correlationId?: string; deliveryStatus: string };
      };
      ownedEventIds.add(body.eventId);
      expect(body.pluginId).toBe(STUB_PUSH_ID);
      expect(body.message.correlationId).toBe(correlationId);
      expect(body.message.deliveryStatus).toBe('SENT_TO_NS');

      await vi.waitFor(async () => {
        expect(
          await redis.zscore(webhookRedisKeys.pending(), body.eventId),
        ).toBeNull();
      });
    }
    finally {
      // Catch leftovers if POST never ran (emit enqueued but drain failed).
      const pendingIds = await redis.zrange(webhookRedisKeys.pending(), 0, -1);
      for (const eventId of pendingIds) {
        const raw = await redis.get(webhookRedisKeys.payload(eventId));
        const record = parseWebhookStoredRecord(raw);
        if (record?.event.message.correlationId === correlationId) {
          ownedEventIds.add(eventId);
        }
      }

      if (ownedEventIds.size > 0) {
        const multi = redis.multi();
        for (const eventId of ownedEventIds) {
          multi.zrem(webhookRedisKeys.pending(), eventId);
          multi.del(webhookRedisKeys.payload(eventId));
          multi.del(webhookRedisKeys.deadLetter(eventId));
        }
        await multi.exec();
      }
    }
  });
});
