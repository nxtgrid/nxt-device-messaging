import { describe, expect, it, vi } from 'vitest';

import type { CalinApiV2Client } from '#src/plugins/calin-api-v2/lib/repo.js';
import { createCalinApiV2Provisioning } from '#src/plugins/calin-api-v2/provisioning.js';

describe('createCalinApiV2Provisioning', () => {
  it('sendRequest posts an allowlisted path', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ code: 0, reason: 'success' });
    const provisioning = createCalinApiV2Provisioning({
      client: { sendRequest } as CalinApiV2Client,
    });

    await expect(provisioning.execute({
      operation: 'sendRequest',
      payload: {
        path: '/API/ConcentratorFile/Read',
        body: { meterId: 'm-1', concentratorId: 'dcu-1', company: 'NXT' },
      },
    })).resolves.toEqual({ code: 0, reason: 'success' });

    expect(sendRequest).toHaveBeenCalledWith(
      '/API/ConcentratorFile/Read',
      { meterId: 'm-1', concentratorId: 'dcu-1', company: 'NXT' },
    );
  });

  it('rejects a path that is not allowlisted', async () => {
    const sendRequest = vi.fn();
    const provisioning = createCalinApiV2Provisioning({
      client: { sendRequest } as CalinApiV2Client,
    });

    await expect(provisioning.execute({
      operation: 'sendRequest',
      payload: { path: '/API/RemoteMeterTask/CreateReadingTask', body: {} },
    })).rejects.toMatchObject({
      name: 'InvalidProvisioningError',
      pluginId: 'calin-api-v2',
    });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('rejects unknown operations', async () => {
    const provisioning = createCalinApiV2Provisioning({
      client: { sendRequest: vi.fn() } as unknown as CalinApiV2Client,
    });

    await expect(provisioning.execute({
      operation: 'deregister',
      payload: {},
    })).rejects.toMatchObject({
      name: 'InvalidProvisioningError',
    });
  });
});
