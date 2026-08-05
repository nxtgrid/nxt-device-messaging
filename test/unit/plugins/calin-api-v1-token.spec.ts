import { describe, expect, it, vi } from 'vitest';

import type { CalinApiV1Client } from '#src/plugins/calin-api-v1/lib/repo.js';
import { createCalinApiV1Token } from '#src/plugins/calin-api-v1/token.js';

const tokenSecrets = {
  companyName: 'Acme',
  posUsername: 'pos',
  posPassword: 'pos-secret',
  maintenanceUsername: 'maint',
  maintenancePassword: 'maint-secret',
} as const;

const shared = {
  issueDateString: '2026-08-05',
  device: { externalReference: 'm-1' },
} as const;

function mockClient(
  sendRequest: CalinApiV1Client['sendRequest'],
): CalinApiV1Client {
  return { sendRequest };
}

describe('createCalinApiV1Token', () => {
  it('TOP_UP_KWH posts POS_Purchase with POS creds and amount', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      result_code: 0,
      reason: 'OK',
      result: { token: 'tok-topup' },
    });
    const token = createCalinApiV1Token({
      secrets: tokenSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      token.generate({
        ...shared,
        type: 'TOP_UP_KWH',
        payload: { kwh: 10 },
      }),
    ).resolves.toBe('tok-topup');

    expect(sendRequest).toHaveBeenCalledWith('/POS_Purchase', {
      company_name: 'Acme',
      user_name: 'pos',
      password: 'pos-secret',
      password_vend: 'pos-secret',
      is_vend_by_unit: true,
      meter_number: 'm-1',
      amount: 10,
    });
  });

  it('SET_POWER_LIMIT posts Maintenance_SetMaxPower', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      result_code: 0,
      reason: 'OK',
      result: 'tok-limit',
    });
    const token = createCalinApiV1Token({
      secrets: tokenSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      token.generate({
        ...shared,
        type: 'SET_POWER_LIMIT',
        payload: { powerLimit: 5000 },
      }),
    ).resolves.toBe('tok-limit');

    expect(sendRequest).toHaveBeenCalledWith('/Maintenance_SetMaxPower', {
      company_name: 'Acme',
      user_name: 'maint',
      password: 'maint-secret',
      meter_number: 'm-1',
      max_power: 5000,
    });
  });

  it('CLEAR_TAMPER posts Maintenance_ClearTamper', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      result_code: 0,
      reason: 'OK',
      result: 'tok-tamper',
    });
    const token = createCalinApiV1Token({
      secrets: tokenSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      token.generate({ ...shared, type: 'CLEAR_TAMPER' }),
    ).resolves.toBe('tok-tamper');

    expect(sendRequest).toHaveBeenCalledWith(
      '/Maintenance_ClearTamper',
      expect.objectContaining({
        user_name: 'maint',
        meter_number: 'm-1',
      }),
    );
  });

  it('CLEAR_CREDIT posts Maintenance_ClearCredit', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      result_code: 0,
      reason: 'OK',
      result: 'tok-clear',
    });
    const token = createCalinApiV1Token({
      secrets: tokenSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      token.generate({ ...shared, type: 'CLEAR_CREDIT' }),
    ).resolves.toBe('tok-clear');

    expect(sendRequest).toHaveBeenCalledWith(
      '/Maintenance_ClearCredit',
      expect.objectContaining({ meter_number: 'm-1' }),
    );
  });

  it('throws when the vendor returns no token, including failure reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = createCalinApiV1Token({
      secrets: tokenSecrets,
      client: mockClient(vi.fn().mockResolvedValue({
        result_code: 1,
        reason: 'Insufficient credit',
      })),
    });

    await expect(
      token.generate({
        ...shared,
        type: 'TOP_UP_KWH',
        payload: { kwh: 1 },
      }),
    ).rejects.toThrow(
      '[CALIN API-V1 TOKEN SERVICE] Got an empty response because: Insufficient credit',
    );
  });

  it('throws a generic empty-response message when the vendor omits reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = createCalinApiV1Token({
      secrets: tokenSecrets,
      client: mockClient(vi.fn().mockResolvedValue({
        result_code: 0,
      })),
    });

    await expect(
      token.generate({
        ...shared,
        type: 'TOP_UP_KWH',
        payload: { kwh: 1 },
      }),
    ).rejects.toThrow('[CALIN API-V1 TOKEN SERVICE] Got an empty response');
  });
});
