/**
 * @fileoverview Shared ChirpStack gRPC device client (Unit 10.2).
 *
 * Port of legacy `lib/chirpstack-repository/index.ts`. Secrets load here via
 * {@link loadChirpstackSecrets} (`CHIRPSTACK_*`) — not in manufacturer plugins.
 * First consumer is `calin-chirpstack`; other LoRaWAN brand plugins may reuse this.
 *
 * Uses `@chirpstack/chirpstack-api` + `@grpc/grpc-js` (not HTTP/`fetch`).
 * Default imports are required for ESM↔CJS interop (named imports are undefined).
 * Legacy used insecure credentials; same until TLS is an explicit follow-up.
 *
 * `registerDevice` / `setApplicationKeyForDevice` travel with the port (ledger +
 * meter-installs coupling note). Messaging paths use `enqueueDeviceRequest` and
 * `getDeviceQueue`.
 */

import { Metadata, credentials, type CallOptions } from '@grpc/grpc-js';
import deviceGrpc from '@chirpstack/chirpstack-api/api/device_grpc_pb.js';
import devicePb from '@chirpstack/chirpstack-api/api/device_pb.js';

import { loadChirpstackSecrets } from './secrets.js';

/** LoRaWAN application port used for all CALIN / ChirpStack downlinks today. */
const DEVICE_F_PORT = 1;

/** Ask the meter to ACK confirmed downlinks. */
const CONFIRMED_DOWNLINK = true;

/**
 * Safety deadline for ChirpStack unary RPCs.
 *
 * Caps true never-return hangs without cutting normal NS API latency.
 * Fresh {@link CallOptions} per call so each RPC gets its own wall clock.
 */
const UNARY_RPC_DEADLINE_MS = 60_000;

/** Fresh CallOptions with an absolute deadline for one unary RPC. */
function unaryCallOptions(): CallOptions {
  return { deadline: Date.now() + UNARY_RPC_DEADLINE_MS };
}

/**
 * Build a ChirpStack device client.
 *
 * Reads `CHIRPSTACK_*` from env at init (fail-fast when missing).
 */
export function createChirpstackClient() {
  const secrets = loadChirpstackSecrets();

  const metadata = new Metadata();
  metadata.set('authorization', `Bearer ${ secrets.apiToken }`);

  const deviceClient = new deviceGrpc.DeviceServiceClient(
    secrets.apiUrl,
    credentials.createInsecure(),
  );

  return {
    enqueueDeviceRequest(devEui: string, bytes: number[]): Promise<string> {
      const queueItem = new devicePb.DeviceQueueItem();
      queueItem.setDevEui(devEui);
      queueItem.setFPort(DEVICE_F_PORT);
      queueItem.setConfirmed(CONFIRMED_DOWNLINK);
      queueItem.setData(Uint8Array.from(bytes));

      const enqueueReq = new devicePb.EnqueueDeviceQueueItemRequest();
      enqueueReq.setQueueItem(queueItem);

      return new Promise((resolve, reject) => {
        deviceClient.enqueue(enqueueReq, metadata, unaryCallOptions(), (err, res) => {
          if (err) {
            reject(err);
            return;
          }
          if (!res) {
            reject(new Error('ChirpStack enqueue returned empty response'));
            return;
          }
          resolve(res.getId());
        });
      });
    },

    registerDevice(devEui: string, deviceName: string): Promise<{ isNewRegistration: boolean }> {
      const device = new devicePb.Device();
      device.setDevEui(devEui);
      device.setName(deviceName);
      // @TODO :: This is meter / deployment specific (legacy note).
      device.setApplicationId(secrets.applicationId);
      device.setDeviceProfileId(secrets.profileId);

      const createDeviceRequest = new devicePb.CreateDeviceRequest();
      createDeviceRequest.setDevice(device);

      return new Promise(resolve => {
        deviceClient.create(createDeviceRequest, metadata, unaryCallOptions(), err => {
          if (err) {
            // Legacy: any create failure → non-new so provisioning can continue.
            // Callers skip key setup when false. Log code so we can narrow to
            // ALREADY_EXISTS once that status is observed in the wild.
            console.info(
              '[CHIRPSTACK REPO] Device create failed; treating as non-new registration',
              { devEui, code: err.code, details: err.details },
            );
            // Always resolve — existing devices should not block provisioning.
            // If we can narrow this so real errors can be cause to reject, we will do so.
            // But for now logging and letting pass is all we can do.
            resolve({ isNewRegistration: false });
            return;
          }
          resolve({ isNewRegistration: true });
        });
      });
    },

    setApplicationKeyForDevice(devEui: string): Promise<{ success: boolean }> {
      const deviceKeys = new devicePb.DeviceKeys();
      deviceKeys.setDevEui(devEui);
      deviceKeys.setNwkKey(secrets.appKey);

      const createDeviceKeysRequest = new devicePb.CreateDeviceKeysRequest();
      createDeviceKeysRequest.setDeviceKeys(deviceKeys);

      return new Promise(resolve => {
        deviceClient.createKeys(createDeviceKeysRequest, metadata, unaryCallOptions(), err => {
          if (err) {
            console.error(
              '[CHIRPSTACK REPO] Error generating application key for device',
              devEui,
              err,
            );
            resolve({ success: false });
            return;
          }
          resolve({ success: true });
        });
      });
    },

    getDeviceQueue(devEui: string): Promise<{ deliveryQueueId: string }[]> {
      const request = new devicePb.GetDeviceQueueItemsRequest();
      request.setDevEui(devEui);

      return new Promise((resolve, reject) => {
        deviceClient.getQueue(request, metadata, unaryCallOptions(), (err, res) => {
          if (err) {
            reject(err);
            return;
          }
          if (!res) {
            reject(new Error('ChirpStack getQueue returned empty response'));
            return;
          }
          const parsedItems = res.getResultList().map(item => ({
            deliveryQueueId: item.getId(),
          }));
          resolve(parsedItems);
        });
      });
    },
  };
}

/** Thin gRPC client for ChirpStack ({@link createChirpstackClient}). */
export type ChirpstackClient = ReturnType<typeof createChirpstackClient>;
