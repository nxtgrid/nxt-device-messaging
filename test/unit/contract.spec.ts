import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createDeviceMessageSchema,
  deviceStateSchema,
  errorBodySchema,
  powerLimitPayloadSchema,
  type CancelOneBody,
  type CommandType,
  type CreateDeviceMessage,
  type DeviceMessageResponse,
  type DeviceState,
  type EnqueueableCommandType,
  type ErrorBody,
  type GenerateTokenResponse,
  type PluginProvisioningRequest,
  type PluginProvisioningResponse,
  type PowerLimitPayload,
  type WebhookEvent,
  type WebhookMessage,
} from '../../packages/contract/src/index.js';

describe('contract barrel', () => {
  it('exposes enqueue and response wire types', () => {
    expectTypeOf<CreateDeviceMessage['commandType']>().toEqualTypeOf<EnqueueableCommandType>();
    expectTypeOf<DeviceMessageResponse>().toHaveProperty('deliveryStatus');
    expectTypeOf<DeviceMessageResponse['commandType']>().toEqualTypeOf<CommandType>();
    expectTypeOf<CancelOneBody>().toEqualTypeOf<{ correlationId: string }>();
    expectTypeOf<GenerateTokenResponse>().toEqualTypeOf<{ token: string }>();
    expectTypeOf<PluginProvisioningRequest>().toMatchTypeOf<{
      pluginId: string;
      operation: string;
      payload: unknown;
    }>();
    expectTypeOf<PluginProvisioningResponse>().toEqualTypeOf<{ result: unknown }>();
    expectTypeOf<WebhookEvent>().toHaveProperty('eventId');
    expectTypeOf<WebhookMessage>().toHaveProperty('deliveryStatus');
    expectTypeOf<ErrorBody>().toHaveProperty('error');
  });

  it('exposes API schemas', () => {
    expect(createDeviceMessageSchema.parse).toBeTypeOf('function');
    expect(errorBodySchema.parse).toBeTypeOf('function');
    expect(powerLimitPayloadSchema.parse).toBeTypeOf('function');
    expect(deviceStateSchema.parse).toBeTypeOf('function');
  });

  it('exports the shared power-limit payload and device state', () => {
    expectTypeOf<PowerLimitPayload>().toEqualTypeOf<{ powerLimit: number }>();
    expectTypeOf<DeviceState>().toEqualTypeOf<{
      powerLimit?: number;
      relay?: 'ON' | 'OFF';
    }>();
    expect(powerLimitPayloadSchema.parse({ powerLimit: 0 })).toEqual({ powerLimit: 0 });
    expect(deviceStateSchema.parse({ relay: 'OFF' })).toEqual({ relay: 'OFF' });
  });
});
