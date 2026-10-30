/**
 * @fileoverview `sparkmeter-sparknet-http` outgoing facet.
 *
 * Posts `POST /v1/nodes/{node_id}/configure-meter`. No auth header.
 * A 202 returns `{pluginId}:{nodeId}`. A 4xx does not retry. A 5xx, a
 * timeout, or a network error does.
 */

import { isNil } from 'ramda';

import type { DeviceMessage, FailureContext } from '../../lib/device-message/types.js';
import { logger } from '../../log.js';
import { CLIENT_SAFETY_DEADLINE_MS } from '../_shared/client-safety-deadline.js';
import type { PushPlugin } from '../plugin.interface.js';
import { buildConfigureMeterBody } from './lib/configure-body.js';
import { SparkmeterSparknetHttpError } from './lib/error.js';
import type { SparkmeterSparknetHttpSettings } from './lib/settings.js';

function isTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { name?: string }).name === 'TimeoutError') return true;
  const cause = (err as { cause?: { name?: string } }).cause;
  return cause?.name === 'TimeoutError';
}

/**
 * Build `sendOne` and `parseError` for one plugin instance.
 *
 * @param deps - Loaded settings, and this plugin's id for the delivery id
 */
export function createSparkmeterSparknetHttpOutgoing(deps: {
  readonly settings: SparkmeterSparknetHttpSettings;
  readonly pluginId: string;
}): PushPlugin['outgoing'] {
  const { settings, pluginId } = deps;
  const baseUrlById = new Map(
    settings.basestations.map(basestation => [ basestation.id, basestation.baseUrl ]),
  );

  const sendOne = async (message: DeviceMessage): Promise<string> => {
    const relayNodeId = message.device.relayNode?.id;
    const baseUrl = isNil(relayNodeId) ? undefined : baseUrlById.get(relayNodeId);
    if (baseUrl === undefined) {
      throw new SparkmeterSparknetHttpError(
        'device.relayNode.id is not a configured basestation',
        { skipRetry: true },
      );
    }

    const body = buildConfigureMeterBody(message, settings.meterConfiguration);
    const nodeId = message.device.externalReference;
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const url = `${ base }/v1/nodes/${ encodeURIComponent(nodeId) }/configure-meter`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CLIENT_SAFETY_DEADLINE_MS),
      });
    }
    catch (err) {
      if (isTimeout(err)) {
        logger.warn({ module: 'sparkmeter-sparknet-http.outgoing', url }, 'configure timed out');
        throw new SparkmeterSparknetHttpError('configure-meter timed out');
      }
      logger.warn({ module: 'sparkmeter-sparknet-http.outgoing', url, err }, 'configure unreachable');
      throw new SparkmeterSparknetHttpError('configure-meter could not be reached');
    }

    await response.body?.cancel();
    if (response.status !== 202) {
      const skipRetry = response.status >= 400 && response.status < 500;
      logger.warn({
        module: 'sparkmeter-sparknet-http.outgoing',
        url,
        status: response.status,
      }, 'configure-meter rejected');
      throw new SparkmeterSparknetHttpError(
        `configure-meter answered HTTP ${ response.status }`,
        { status: response.status, skipRetry },
      );
    }

    return `${ pluginId }:${ nodeId }`;
  };

  const parseError = (err: unknown): FailureContext => {
    if (err instanceof SparkmeterSparknetHttpError) {
      return {
        reason: err.message,
        ...(err.status === undefined ? {} : { errorCode: err.status }),
        skipRetry: err.skipRetry,
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { reason };
  };

  return { sendOne, parseError };
}
