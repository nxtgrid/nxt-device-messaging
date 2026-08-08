import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceError } from '@grpc/grpc-js';

import { CHIRPSTACK_ENV_KEYS } from '#src/plugins/_shared/chirpstack-repository/secrets.js';

const grpcStub = vi.hoisted(() => ({
  enqueue: vi.fn(),
  create: vi.fn(),
  createKeys: vi.fn(),
  getQueue: vi.fn(),
}));

vi.mock('@chirpstack/chirpstack-api/api/device_grpc_pb.js', () => ({
  default: {
    DeviceServiceClient: vi.fn(function DeviceServiceClient() {
      return grpcStub;
    }),
  },
}));

// Import after mock so the factory sees the stubbed DeviceServiceClient.
const { createChirpstackClient } = await import(
  '#src/plugins/_shared/chirpstack-repository/index.js'
);

function stubValidChirpstackEnv(): void {
  for (const key of CHIRPSTACK_ENV_KEYS) {
    vi.stubEnv(key, `test-${ key }`);
  }
}

beforeEach(() => {
  stubValidChirpstackEnv();
  grpcStub.enqueue.mockReset();
  grpcStub.create.mockReset();
  grpcStub.createKeys.mockReset();
  grpcStub.getQueue.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createChirpstackClient', () => {
  it('throws MISSING when CHIRPSTACK_* env is blank', () => {
    for (const key of CHIRPSTACK_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    expect(() => createChirpstackClient()).toThrow(
      /MISSING env for plugin "chirpstack"/,
    );
  });

  it('enqueueDeviceRequest returns the queue item id', async () => {
    grpcStub.enqueue.mockImplementation((_req, _meta, _opts, cb) => {
      cb(null, { getId: () => 'queue-item-1' });
    });

    const client = createChirpstackClient();
    await expect(client.enqueueDeviceRequest('0000000000000001', [ 0x01, 0x02 ]))
      .resolves.toBe('queue-item-1');
    expect(grpcStub.enqueue).toHaveBeenCalledOnce();
    expect(grpcStub.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ deadline: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('enqueueDeviceRequest rejects on gRPC error', async () => {
    const grpcErr = { code: 5, details: 'not found' } as ServiceError;
    grpcStub.enqueue.mockImplementation((_req, _meta, _opts, cb) => {
      cb(grpcErr, null);
    });

    const client = createChirpstackClient();
    await expect(client.enqueueDeviceRequest('0000000000000001', [ 0x01 ]))
      .rejects.toBe(grpcErr);
  });

  it('registerDevice resolves isNewRegistration false when create fails', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    grpcStub.create.mockImplementation((_req, _meta, _opts, cb) => {
      cb({ code: 6, details: 'already exists' } as ServiceError, null);
    });

    const client = createChirpstackClient();
    await expect(client.registerDevice('0000000000000001', 'meter-1'))
      .resolves.toEqual({ isNewRegistration: false });
    expect(infoSpy).toHaveBeenCalledWith(
      '[CHIRPSTACK REPO] Device create failed; treating as non-new registration',
      { devEui: '0000000000000001', code: 6, details: 'already exists' },
    );
  });

  it('registerDevice resolves isNewRegistration true on success', async () => {
    grpcStub.create.mockImplementation((_req, _meta, _opts, cb) => {
      cb(null, {});
    });

    const client = createChirpstackClient();
    await expect(client.registerDevice('0000000000000001', 'meter-1'))
      .resolves.toEqual({ isNewRegistration: true });
  });

  it('setApplicationKeyForDevice maps errors to success false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    grpcStub.createKeys.mockImplementation((_req, _meta, _opts, cb) => {
      cb({ details: 'keys failed' } as ServiceError, null);
    });

    const client = createChirpstackClient();
    await expect(client.setApplicationKeyForDevice('0000000000000001'))
      .resolves.toEqual({ success: false });
  });

  it('getDeviceQueue returns camelCase deliveryQueueId list', async () => {
    grpcStub.getQueue.mockImplementation((_req, _meta, _opts, cb) => {
      cb(null, {
        getResultList: () => [
          { getId: () => 'q-1' },
          { getId: () => 'q-2' },
        ],
      });
    });

    const client = createChirpstackClient();
    await expect(client.getDeviceQueue('0000000000000001')).resolves.toEqual([
      { deliveryQueueId: 'q-1' },
      { deliveryQueueId: 'q-2' },
    ]);
    expect(grpcStub.getQueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ deadline: expect.any(Number) }),
      expect.any(Function),
    );
  });
});
