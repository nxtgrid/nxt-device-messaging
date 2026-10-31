/**
 * @fileoverview Spec configure body for `sparkmeter-sparknet-http`.
 *
 * CamelCase on our wire and in settings becomes the meter's snake_case
 * fields. `node_id` stays in the URL, not in this body.
 */

import { isNil } from 'ramda';

import type { DeviceMessage } from '../../../lib/device-message/types.js';
import { SparkmeterSparknetHttpError } from './error.js';
import type { SparkmeterMeterConfiguration } from './settings.js';
import { isPowerLimitPayload } from './validate-enqueue.js';

type ConfigureMessage = Pick<DeviceMessage, 'commandType' | 'requestData'>;

type MeterCommand = 'ElectricalMeterCommandEnable' | 'ElectricalMeterCommandDisable';

/**
 * Spec command and the caller's power limit. `TURN_ON` / `TURN_OFF` keep
 * `deviceState.powerLimit`. `SET_POWER_LIMIT` changes that limit and keeps
 * the relay.
 */
function commandAndPowerLimit(message: ConfigureMessage): {
  command: MeterCommand;
  powerLimit: number;
} {
  if (message.commandType === 'TURN_ON' || message.commandType === 'TURN_OFF') {
    const powerLimit = message.requestData?.deviceState?.powerLimit;
    if (isNil(powerLimit)) {
      throw new SparkmeterSparknetHttpError(
        `${ message.commandType } requires deviceState.powerLimit`,
        { skipRetry: true },
      );
    }
    return {
      command: message.commandType === 'TURN_ON'
        ? 'ElectricalMeterCommandEnable'
        : 'ElectricalMeterCommandDisable',
      powerLimit,
    };
  }

  if (message.commandType === 'SET_POWER_LIMIT') {
    const relay = message.requestData?.deviceState?.relay;
    const payload = message.requestData?.payload;
    if (relay !== 'ON' && relay !== 'OFF') {
      throw new SparkmeterSparknetHttpError(
        'SET_POWER_LIMIT requires deviceState.relay',
        { skipRetry: true },
      );
    }
    if (!isPowerLimitPayload(payload)) {
      throw new SparkmeterSparknetHttpError(
        'SET_POWER_LIMIT requires requestData.payload.powerLimit',
        { skipRetry: true },
      );
    }
    return {
      command: relay === 'ON'
        ? 'ElectricalMeterCommandEnable'
        : 'ElectricalMeterCommandDisable',
      powerLimit: payload.powerLimit,
    };
  }

  throw new SparkmeterSparknetHttpError(
    `${ message.commandType } is not a configure command`,
    { skipRetry: true },
  );
}

/**
 * Assemble the six-field spec body from the caller and fleet settings.
 *
 * `TURN_ON` / `TURN_OFF` take `deviceState.powerLimit`. `SET_POWER_LIMIT`
 * takes `payload.powerLimit` and `deviceState.relay`. A missing field throws
 * {@link SparkmeterSparknetHttpError} with `skipRetry`.
 *
 * @param message - In-flight command
 * @param meterConfiguration - Fleet constants, with `currentLimit` already filled in
 */
export function buildConfigureMeterBody(
  message: ConfigureMessage,
  meterConfiguration: SparkmeterMeterConfiguration,
) {
  const { command, powerLimit } = commandAndPowerLimit(message);
  return {
    command,
    configuration: {
      power_limit: powerLimit,
      current_limit: meterConfiguration.currentLimit,
      startup_delay: meterConfiguration.startupDelay,
      throttle_on_time: meterConfiguration.throttleOnTime,
      throttle_off_time: meterConfiguration.throttleOffTime,
      throttle_count_limit: meterConfiguration.throttleCountLimit,
    },
  };
}
