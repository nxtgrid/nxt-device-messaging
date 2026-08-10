import { describe, expect, it } from 'vitest';

import { parseWebhookStoredRecord } from '#src/engine/webhook/store.js';
import type { WebhookStoredRecord } from '#src/engine/webhook/types.js';

const SAMPLE: WebhookStoredRecord = {
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
    },
  },
  attemptCount: 0,
};

describe('parseWebhookStoredRecord', () => {
  it('round-trips a valid record', () => {
    expect(parseWebhookStoredRecord(JSON.stringify(SAMPLE))).toEqual(SAMPLE);
  });

  it('returns null for missing or malformed input', () => {
    expect(parseWebhookStoredRecord(null)).toBeNull();
    expect(parseWebhookStoredRecord('')).toBeNull();
    expect(parseWebhookStoredRecord('not-json')).toBeNull();
    expect(parseWebhookStoredRecord(JSON.stringify({ attemptCount: 1 }))).toBeNull();
    expect(parseWebhookStoredRecord(JSON.stringify({ envelope: SAMPLE.event, attemptCount: 0 })))
      .toBeNull();
  });
});
