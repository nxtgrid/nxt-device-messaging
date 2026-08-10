import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWebhookService,
  isRetryableWebhookStatus,
  WEBHOOK_DRAIN_INTERVAL_MS,
} from '#src/engine/webhook/service.js';
import type { WebhookStore } from '#src/engine/webhook/store.js';
import type { WebhookStoredRecord } from '#src/engine/webhook/types.js';

const CONFIG = {
  url: 'https://consumer.example/hooks',
  maxAttempts: 6,
  baseDelayMs: 2000,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
  deadLetterTtlSeconds: 604_800,
} as const;

function sampleRecord(overrides: Partial<WebhookStoredRecord> = {}): WebhookStoredRecord {
  return {
    event: {
      eventId: '01EVENT',
      occurredAt: '2026-08-10T12:00:00.000Z',
      pluginId: 'stub-push',
      message: {
        deliveryStatus: 'SENT_TO_NS',
        device: {
          type: 'ELECTRICITY_METER',
          externalReference: 'm-1',
        },
        correlationId: 'corr-1',
      },
    },
    attemptCount: 0,
    ...overrides,
  };
}

function createMemoryStore(seed: WebhookStoredRecord[] = []): WebhookStore & {
  readonly pending: Map<string, number>;
  readonly payloads: Map<string, WebhookStoredRecord>;
  readonly dlq: Map<string, WebhookStoredRecord>;
} {
  const pending = new Map<string, number>();
  const payloads = new Map<string, WebhookStoredRecord>();
  const dlq = new Map<string, WebhookStoredRecord>();

  for (const record of seed) {
    payloads.set(record.event.eventId, record);
    pending.set(record.event.eventId, 0);
  }

  return {
    pending,
    payloads,
    dlq,
    async enqueue(record, nextAttemptAtMs) {
      payloads.set(record.event.eventId, record);
      pending.set(record.event.eventId, nextAttemptAtMs);
    },
    async listDueEventIds(nowMs) {
      return [ ...pending.entries() ]
        .filter(entry => entry[1] <= nowMs)
        .sort((left, right) => left[1] - right[1])
        .map(entry => entry[0]);
    },
    async getRecord(eventId) {
      return payloads.get(eventId) ?? null;
    },
    async reschedule(record, nextAttemptAtMs) {
      payloads.set(record.event.eventId, record);
      pending.set(record.event.eventId, nextAttemptAtMs);
    },
    async complete(eventId) {
      pending.delete(eventId);
      payloads.delete(eventId);
    },
    async deadLetter(record) {
      dlq.set(record.event.eventId, record);
      pending.delete(record.event.eventId);
      payloads.delete(record.event.eventId);
    },
  };
}

/** Drive the private drain via one timer tick (public surface has no drainDue). */
async function tickDrain(
  service: ReturnType<typeof createWebhookService>,
  fetchMock: ReturnType<typeof vi.fn>,
  expectedCalls = 1,
): Promise<{ stop(): void }> {
  const timers = service.startTimers({ intervalMs: WEBHOOK_DRAIN_INTERVAL_MS });
  await vi.advanceTimersByTimeAsync(WEBHOOK_DRAIN_INTERVAL_MS);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(expectedCalls));
  return timers;
}

describe('isRetryableWebhookStatus', () => {
  it('retries 408, 429, and 5xx only', () => {
    expect(isRetryableWebhookStatus(408)).toBe(true);
    expect(isRetryableWebhookStatus(429)).toBe(true);
    expect(isRetryableWebhookStatus(500)).toBe(true);
    expect(isRetryableWebhookStatus(503)).toBe(true);
    expect(isRetryableWebhookStatus(400)).toBe(false);
    expect(isRetryableWebhookStatus(404)).toBe(false);
    expect(isRetryableWebhookStatus(200)).toBe(false);
  });
});

describe('createWebhookService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('storeAndEmit enqueues and kicks drain; completes on 2xx', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = createMemoryStore();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createWebhookService({ config: CONFIG, store });

    service.storeAndEmit({
      pluginId: 'stub-push',
      deliveryStatus: 'DELIVERY_SUCCESSFUL',
      device: { type: 'ELECTRICITY_METER', externalReference: 'm-1' },
      correlationId: 'corr-1',
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledWith(
      CONFIG.url,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
    const firstCall = fetchMock.mock.calls[0] as unknown as [
      string,
      { body?: string },
    ];
    const body = JSON.parse(String(firstCall[1]?.body)) as {
      eventId: string;
      message: { correlationId?: string };
    };
    expect(body.message.correlationId).toBe('corr-1');
    expect(store.payloads.size).toBe(0);
    expect(store.pending.size).toBe(0);
  });

  it('dead-letters when retries are exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = createMemoryStore([ sampleRecord({ attemptCount: 5 }) ]);
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createWebhookService({
      config: { ...CONFIG, maxAttempts: 6 },
      store,
    });
    const timers = await tickDrain(service, fetchMock);

    expect(store.dlq.get('01EVENT')?.attemptCount).toBe(6);
    expect(store.dlq.get('01EVENT')?.lastError).toBe('HTTP 503');
    expect(store.pending.size).toBe(0);
    timers.stop();
  });

  it('dead-letters non-retryable 4xx without further attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = createMemoryStore([ sampleRecord() ]);
    const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createWebhookService({ config: CONFIG, store });
    const timers = await tickDrain(service, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.dlq.get('01EVENT')?.lastError).toBe('HTTP 400');
    expect(store.pending.size).toBe(0);
    timers.stop();
  });

  it('reschedules with backoff after a retryable failure', async () => {
    vi.useFakeTimers();
    const nowMs = 100_000;
    vi.setSystemTime(nowMs);
    const store = createMemoryStore([ sampleRecord({ attemptCount: 0 }) ]);
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createWebhookService({ config: CONFIG, store });
    const timers = await tickDrain(service, fetchMock);

    expect(store.dlq.size).toBe(0);
    expect(store.payloads.get('01EVENT')?.attemptCount).toBe(1);
    // Timer tick advances fake `Date.now` by the drain interval before backoff is applied.
    expect(store.pending.get('01EVENT')).toBe(nowMs + WEBHOOK_DRAIN_INTERVAL_MS + 2000);
    timers.stop();
  });

  it('startTimers drains due items on the interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = createMemoryStore([ sampleRecord() ]);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = createWebhookService({ config: CONFIG, store });
    const timers = service.startTimers({ intervalMs: WEBHOOK_DRAIN_INTERVAL_MS });
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WEBHOOK_DRAIN_INTERVAL_MS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(store.payloads.size).toBe(0);

    timers.stop();
  });
});
