import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CalinApiV2Client } from '#src/plugins/calin-api-v2/lib/repo.js';
import { createCalinApiV2Token } from '#src/plugins/calin-api-v2/token.js';

const tokenSecrets = {
  companyName: 'Acme',
  posPassword: 'pos-secret',
} as const;

const shared = {
  issueDateString: '2026-08-05',
  device: { externalReference: 'm-1' },
} as const;

function mockClient(
  sendRequest: CalinApiV2Client['sendRequest'],
): CalinApiV2Client {
  return { sendRequest };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCalinApiV2Token', () => {
  it('TOP_UP_KWH posts CreditToken/Generate with POS password and serialNumber', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      code: 0,
      reason: 'success',
      result: { token: 'tok-topup' },
    });
    const token = createCalinApiV2Token({
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

    expect(sendRequest).toHaveBeenCalledWith('/API/Token/CreditToken/Generate', {
      meterId: 'm-1',
      amount: 10,
      company: 'Acme',
      authorizationPassword: 'pos-secret',
      isPreview: false,
      isVendByTotalPaid: false,
      serialNumber: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ),
    });
  });

  it('SET_POWER_LIMIT posts SetMaximumPowerLimitToken/Generate', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      code: 0,
      reason: 'success',
      result: { token: 'tok-limit' },
    });
    const token = createCalinApiV2Token({
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

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/Token/SetMaximumPowerLimitToken/Generate',
      {
        meterId: 'm-1',
        maximumPower: 5000,
        company: 'Acme',
      },
    );
  });

  it('CLEAR_TAMPER posts ClearTamperToken/Generate', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      code: 0,
      reason: 'success',
      result: { token: 'tok-tamper' },
    });
    const token = createCalinApiV2Token({
      secrets: tokenSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      token.generate({ ...shared, type: 'CLEAR_TAMPER' }),
    ).resolves.toBe('tok-tamper');

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/Token/ClearTamperToken/Generate',
      {
        meterId: 'm-1',
        company: 'Acme',
      },
    );
  });

  it('CLEAR_CREDIT posts ClearCreditToken/Generate', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      code: 0,
      reason: 'success',
      result: { token: 'tok-clear' },
    });
    const token = createCalinApiV2Token({
      secrets: tokenSecrets,
      client: mockClient(sendRequest),
    });

    await expect(
      token.generate({ ...shared, type: 'CLEAR_CREDIT' }),
    ).resolves.toBe('tok-clear');

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/Token/ClearCreditToken/Generate',
      {
        meterId: 'm-1',
        company: 'Acme',
      },
    );
  });

  it('throws when the vendor returns no token, including failure reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = createCalinApiV2Token({
      secrets: tokenSecrets,
      client: mockClient(vi.fn().mockResolvedValue({
        code: 1,
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
      '[CALIN API-V2 TOKEN SERVICE] Got an empty response because: Insufficient credit',
    );
  });

  it('throws a generic empty-response message when the vendor omits reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = createCalinApiV2Token({
      secrets: tokenSecrets,
      client: mockClient(vi.fn().mockResolvedValue({
        code: 0,
      })),
    });

    await expect(
      token.generate({
        ...shared,
        type: 'TOP_UP_KWH',
        payload: { kwh: 1 },
      }),
    ).rejects.toThrow('[CALIN API-V2 TOKEN SERVICE] Got an empty response');
  });
});
