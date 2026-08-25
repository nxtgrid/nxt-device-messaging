import { describe, expectTypeOf, it } from 'vitest';

import type {
  CancelOneBody,
  CreateDeviceMessage,
  ErrorBody,
  GenerateTokenResponse,
  PluginProvisioningRequest,
  PluginProvisioningResponse,
  WebhookEvent,
} from '#src/contract.js';

describe('contract barrel', () => {
  it('exposes command, token, provisioning, and webhook wire types', () => {
    expectTypeOf<CreateDeviceMessage>().toHaveProperty('commandType');
    expectTypeOf<CancelOneBody>().toEqualTypeOf<{ correlationId: string }>();
    expectTypeOf<GenerateTokenResponse>().toEqualTypeOf<{ token: string }>();
    expectTypeOf<PluginProvisioningRequest>().toMatchTypeOf<{
      pluginId: string;
      operation: string;
      payload: unknown;
    }>();
    expectTypeOf<PluginProvisioningResponse>().toEqualTypeOf<{ result: unknown }>();
    expectTypeOf<WebhookEvent>().toHaveProperty('eventId');
    expectTypeOf<ErrorBody>().toHaveProperty('error');
  });
});
