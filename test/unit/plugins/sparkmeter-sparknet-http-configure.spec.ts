import { describe, expect, it } from 'vitest';

import { buildConfigureMeterBody } from '#src/plugins/sparkmeter-sparknet-http/lib/configure-body.js';
import type { SparkmeterMeterConfiguration } from '#src/plugins/sparkmeter-sparknet-http/lib/settings.js';

const fleet: SparkmeterMeterConfiguration = {
  currentLimit: 200,
  startupDelay: 0,
  throttleOnTime: 5,
  throttleOffTime: 10,
  throttleCountLimit: 5,
};

const zeros: SparkmeterMeterConfiguration = {
  currentLimit: 0,
  startupDelay: 0,
  throttleOnTime: 0,
  throttleOffTime: 0,
  throttleCountLimit: 0,
};

describe('buildConfigureMeterBody', () => {
  it('maps TURN_ON to Enable and copies a zero power limit', () => {
    expect(buildConfigureMeterBody({
      commandType: 'TURN_ON',
      requestData: { deviceState: { powerLimit: 0 } },
    }, zeros)).toEqual({
      command: 'ElectricalMeterCommandEnable',
      configuration: {
        power_limit: 0,
        current_limit: 0,
        startup_delay: 0,
        throttle_on_time: 0,
        throttle_off_time: 0,
        throttle_count_limit: 0,
      },
    });
  });

  it('maps TURN_OFF to Disable and the fleet fields to snake_case', () => {
    expect(buildConfigureMeterBody({
      commandType: 'TURN_OFF',
      requestData: { deviceState: { powerLimit: 1000 } },
    }, fleet)).toEqual({
      command: 'ElectricalMeterCommandDisable',
      configuration: {
        power_limit: 1000,
        current_limit: 200,
        startup_delay: 0,
        throttle_on_time: 5,
        throttle_off_time: 10,
        throttle_count_limit: 5,
      },
    });
  });

  it('maps SET_POWER_LIMIT from payload.powerLimit and deviceState.relay', () => {
    expect(buildConfigureMeterBody({
      commandType: 'SET_POWER_LIMIT',
      requestData: {
        payload: { powerLimit: 0 },
        deviceState: { relay: 'ON' },
      },
    }, fleet).command).toBe('ElectricalMeterCommandEnable');

    expect(buildConfigureMeterBody({
      commandType: 'SET_POWER_LIMIT',
      requestData: {
        payload: { powerLimit: 1200 },
        deviceState: { relay: 'OFF' },
      },
    }, fleet)).toMatchObject({
      command: 'ElectricalMeterCommandDisable',
      configuration: { power_limit: 1200 },
    });
  });
});
