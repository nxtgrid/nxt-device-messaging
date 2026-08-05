import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NxtStsClient } from '#src/plugins/nxt-sts/lib/repo.js';
import { NxtStsError } from '#src/plugins/nxt-sts/lib/repo.js';
import { createNxtStsToken } from '#src/plugins/nxt-sts/token.js';

const shared = {
  issueDateString: '2026-08-05',
  device: { externalReference: 'm-1', decoderKey: 'dec-1' },
} as const;

function mockClient(
  sendTokenRequest: NxtStsClient['sendTokenRequest'],
): NxtStsClient {
  return { sendTokenRequest };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createNxtStsToken', () => {
  it('TOP_UP_KWH maps to vendor TOP_UP and posts kwh', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // → randomNumber 6
    const sendTokenRequest = vi.fn().mockResolvedValue({ token: 'tok-topup' });
    const token = createNxtStsToken({ client: mockClient(sendTokenRequest) });

    await expect(
      token.generate({
        ...shared,
        type: 'TOP_UP_KWH',
        payload: { kwh: 10 },
      }),
    ).resolves.toBe('tok-topup');

    expect(sendTokenRequest).toHaveBeenCalledWith({
      decoderKey: 'dec-1',
      randomNumber: 6,
      issueDate: '2026-08-05',
      type: 'TOP_UP',
      kwh: 10,
    });
  });

  it('SET_POWER_LIMIT posts powerLimit', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const sendTokenRequest = vi.fn().mockResolvedValue({ token: 'tok-limit' });
    const token = createNxtStsToken({ client: mockClient(sendTokenRequest) });

    await expect(
      token.generate({
        ...shared,
        type: 'SET_POWER_LIMIT',
        payload: { powerLimit: 5000 },
      }),
    ).resolves.toBe('tok-limit');

    expect(sendTokenRequest).toHaveBeenCalledWith({
      decoderKey: 'dec-1',
      randomNumber: 0,
      issueDate: '2026-08-05',
      type: 'SET_POWER_LIMIT',
      powerLimit: 5000,
    });
  });

  it('CLEAR_TAMPER and CLEAR_CREDIT pass type through without payload fields', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25); // → 3
    const sendTokenRequest = vi.fn()
      .mockResolvedValueOnce({ token: 'tok-tamper' })
      .mockResolvedValueOnce({ token: 'tok-clear' });
    const token = createNxtStsToken({ client: mockClient(sendTokenRequest) });

    await expect(
      token.generate({ ...shared, type: 'CLEAR_TAMPER' }),
    ).resolves.toBe('tok-tamper');
    await expect(
      token.generate({ ...shared, type: 'CLEAR_CREDIT' }),
    ).resolves.toBe('tok-clear');

    expect(sendTokenRequest).toHaveBeenNthCalledWith(1, {
      decoderKey: 'dec-1',
      randomNumber: 3,
      issueDate: '2026-08-05',
      type: 'CLEAR_TAMPER',
    });
    expect(sendTokenRequest).toHaveBeenNthCalledWith(2, {
      decoderKey: 'dec-1',
      randomNumber: 3,
      issueDate: '2026-08-05',
      type: 'CLEAR_CREDIT',
    });
  });

  it('requires device.decoderKey', async () => {
    const token = createNxtStsToken({
      client: mockClient(vi.fn()),
    });

    await expect(
      token.generate({
        issueDateString: '2026-08-05',
        device: { externalReference: 'm-1' },
        type: 'CLEAR_TAMPER',
      }),
    ).rejects.toEqual(
      new NxtStsError('[NXT STS TOKEN SERVICE] device.decoderKey is required'),
    );

    await expect(
      token.generate({
        issueDateString: '2026-08-05',
        device: { externalReference: 'm-1', decoderKey: '   ' },
        type: 'CLEAR_TAMPER',
      }),
    ).rejects.toEqual(
      new NxtStsError('[NXT STS TOKEN SERVICE] device.decoderKey is required'),
    );
  });

  it('throws when the vendor returns no token', async () => {
    const token = createNxtStsToken({
      client: mockClient(vi.fn().mockResolvedValue({})),
    });

    await expect(
      token.generate({ ...shared, type: 'CLEAR_CREDIT' }),
    ).rejects.toEqual(
      new NxtStsError('[NXT STS TOKEN SERVICE] Failed to generate token'),
    );
  });
});
