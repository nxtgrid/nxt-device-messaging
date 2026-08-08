/**
 * @fileoverview `calin-chirpstack` outgoing facet (Unit 10.4).
 *
 * Port of legacy `adapters/calin-lorawan/_outgoing.service.ts`. Encodes CALIN
 * frames, enqueues via the shared ChirpStack gRPC client, and maps gRPC /
 * local encode failures into {@link FailureContext}.
 */

import type {
  DeviceMessage,
  DeviceMessageDeliveryStatus,
  FailureContext,
  SetDatePayload,
  SetTimePayload,
} from '../../lib/device-message/types.js';
import type { ChirpstackClient } from '../_shared/chirpstack-repository/index.js';
import type { DeviceMessagingPlugin } from '../plugin.interface.js';
import { encodeRequestData } from './lib/encode-request-data.js';

/** Options for {@link CalinChirpstackError}. */
export type CalinChirpstackErrorOptions = {
  /** When true, outgoing `parseError` sets `skipRetry` (unrecoverable). */
  readonly skipRetry?: boolean;
};

/**
 * Local / permanent failure for the CALIN-over-ChirpStack plugin.
 * Use `{ skipRetry: true }` for encode/validation failures that must not retry.
 */
export class CalinChirpstackError extends Error {
  readonly skipRetry: boolean;

  constructor(message: string, options: CalinChirpstackErrorOptions = {}) {
    super(message);
    this.name = 'CalinChirpstackError';
    this.skipRetry = options.skipRetry ?? false;
  }
}

/** Loose shape of `@grpc/grpc-js` ServiceError fields we read. */
type GrpcError = {
  code?: number;
  details?: string;
};

/**
 * Build the outgoing facet.
 *
 * @param deps.client - Shared ChirpStack gRPC client
 */
export function createCalinChirpstackOutgoing(deps: {
  readonly client: ChirpstackClient;
}): DeviceMessagingPlugin['outgoing'] {
  const { client } = deps;

  const sendOne = async (message: DeviceMessage): Promise<string> => {
    const { externalReference } = message.device;

    const bytes = encodeRequestData({
      deviceIdentifier: externalReference,
      devicePhase: message.phase ?? 'A',
      requestType: message.commandType,
      token: message.requestData?.token,
      payload: message.requestData?.payload as SetDatePayload | SetTimePayload | undefined,
    });

    if (!bytes) {
      console.error('[LORAWAN CALIN ENCODE REQUEST DATA] Failed to encode', message);
      throw new CalinChirpstackError(
        'Could not encode request data prior to sending to device',
        { skipRetry: true },
      );
    }

    // Ensure 16 hex digits (leading 0s if needed)
    const deviceEui = externalReference.padStart(16, '0');

    return client.enqueueDeviceRequest(deviceEui, bytes);
  };

  const getRemoteStatus = async (
    message: DeviceMessage,
  ): Promise<{ deliveryStatus: DeviceMessageDeliveryStatus }> => {
    const { externalReference } = message.device;
    const deviceEui = externalReference.padStart(16, '0');

    const remoteQueue = await client.getDeviceQueue(deviceEui);
    const messageIsStillQueued = remoteQueue.some(
      ({ deliveryQueueId }) => deliveryQueueId === message.deliveryQueueId,
    );

    return {
      deliveryStatus: messageIsStillQueued
        ? message.deliveryStatus
        : 'DELIVERY_FAILED',
    };
  };

  /**
   * Parse a ChirpStack gRPC (or local) error into retry/fail context.
   * Unregistered-device FK violations and encode failures skip retries.
   */
  const parseError = (err: unknown): FailureContext => {
    if (err instanceof CalinChirpstackError) {
      return {
        reason: err.message,
        skipRetry: err.skipRetry,
      };
    }

    const grpcError = err as GrpcError;
    const errorCode = grpcError.code;
    const details = grpcError.details;
    console.info('[PARSE GRPC ERROR] errorCode', errorCode);
    console.info('[PARSE GRPC ERROR] details', details);

    // Device not registered in ChirpStack (unrecoverable)
    if (details?.includes('device_queue_item_dev_eui_fkey')) {
      return {
        reason: 'Device not registered in Network Server (ChirpStack)',
        errorCode,
        details,
        skipRetry: true,
      };
    }

    return {
      reason: 'Failed to enqueue message at ChirpStack',
      errorCode,
      details,
    };
  };

  return { sendOne, getRemoteStatus, parseError };
}
