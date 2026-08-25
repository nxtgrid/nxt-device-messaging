import { describe, expect, it, vi } from 'vitest';

import type { ChirpstackClient } from '#src/plugins/_shared/chirpstack-repository/index.js';
import { createCalinChirpstackProvisioning } from '#src/plugins/calin-chirpstack/provisioning.js';

function mockClient(
  overrides: Partial<Pick<ChirpstackClient, 'registerDevice' | 'setApplicationKeyForDevice'>>,
): ChirpstackClient {
  return {
    registerDevice: vi.fn(),
    setApplicationKeyForDevice: vi.fn(),
    ...overrides,
  } as unknown as ChirpstackClient;
}

describe('createCalinChirpstackProvisioning', () => {
  it('registerDevice calls client.registerDevice', async () => {
    const registerDevice = vi.fn().mockResolvedValue({ isNewRegistration: true });
    const provisioning = createCalinChirpstackProvisioning({
      client: mockClient({ registerDevice }),
    });

    await expect(provisioning.execute({
      operation: 'registerDevice',
      payload: { devEui: '0000000000000001', deviceName: 'meter-1' },
    })).resolves.toEqual({ isNewRegistration: true });

    expect(registerDevice).toHaveBeenCalledWith('0000000000000001', 'meter-1');
  });

  it('setApplicationKey calls client.setApplicationKeyForDevice', async () => {
    const setApplicationKeyForDevice = vi.fn().mockResolvedValue({ success: true });
    const provisioning = createCalinChirpstackProvisioning({
      client: mockClient({ setApplicationKeyForDevice }),
    });

    await expect(provisioning.execute({
      operation: 'setApplicationKey',
      payload: { devEui: '0000000000000001' },
    })).resolves.toEqual({ success: true });

    expect(setApplicationKeyForDevice).toHaveBeenCalledWith('0000000000000001');
  });

  it('rejects unknown operations', async () => {
    const provisioning = createCalinChirpstackProvisioning({ client: mockClient({}) });

    await expect(provisioning.execute({
      operation: 'deleteDevice',
      payload: {},
    })).rejects.toMatchObject({
      name: 'InvalidProvisioningError',
      pluginId: 'calin-chirpstack',
    });
  });

  it('rejects malformed registerDevice payload', async () => {
    const provisioning = createCalinChirpstackProvisioning({ client: mockClient({}) });

    await expect(provisioning.execute({
      operation: 'registerDevice',
      payload: { devEui: '1' },
    })).rejects.toMatchObject({
      name: 'InvalidProvisioningError',
    });
  });
});
