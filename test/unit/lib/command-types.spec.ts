import { describe, expect, it } from 'vitest';

import {
  COMMAND_TYPES,
  ENQUEUEABLE_COMMAND_TYPES,
  GENERATE_TOKEN_TYPES,
  isEnqueueableCommand,
  isGenerateTokenType,
  isUnsolicitedCommand,
  UNSOLICITED_COMMAND_TYPES,
} from '#src/lib/device-message/command-types.js';
import {
  createDeviceMessageSchema,
  generateTokenSchema,
} from '#src/lib/device-message/schemas.js';

describe('command-types vocabulary', () => {
  it('keeps unsolicited out of enqueueable and generate-token sets', () => {
    for (const type of UNSOLICITED_COMMAND_TYPES) {
      expect(ENQUEUEABLE_COMMAND_TYPES).not.toContain(type);
      expect(GENERATE_TOKEN_TYPES).not.toContain(type);
      expect(isUnsolicitedCommand(type)).toBe(true);
      expect(isEnqueueableCommand(type)).toBe(false);
    }
    expect(COMMAND_TYPES).toEqual(expect.arrayContaining([ ...UNSOLICITED_COMMAND_TYPES ]));
  });

  it('keeps DELIVER_PREEXISTING_TOKEN enqueueable but not a generate type', () => {
    expect(ENQUEUEABLE_COMMAND_TYPES).toContain('DELIVER_PREEXISTING_TOKEN');
    expect(GENERATE_TOKEN_TYPES).not.toContain('DELIVER_PREEXISTING_TOKEN');
    expect(isGenerateTokenType('DELIVER_PREEXISTING_TOKEN')).toBe(false);
  });

  it('rejects unsolicited and unknown strings on create schema', () => {
    const base = {
      priority: 1,
      pluginId: 'stub-push',
      networkId: 1,
      device: { type: 'ELECTRICITY_METER' as const, externalReference: 'm-1' },
    };

    expect(createDeviceMessageSchema.safeParse({
      ...base,
      commandType: 'READ_REPORT',
    }).success).toBe(false);

    expect(createDeviceMessageSchema.safeParse({
      ...base,
      commandType: 'NOT_A_COMMAND',
    }).success).toBe(false);

    expect(createDeviceMessageSchema.safeParse({
      ...base,
      commandType: 'READ_CREDIT',
    }).success).toBe(true);
  });

  it('rejects unknown token generate types on body schema', () => {
    const base = {
      pluginId: 'stub-push',
      issueDateString: '2026-08-03',
      device: { externalReference: 'm-1' },
    };

    expect(generateTokenSchema.safeParse({
      ...base,
      type: 'DELIVER_PREEXISTING_TOKEN',
    }).success).toBe(false);
  });

  it('requires per-type payload on generateTokenSchema', () => {
    const base = {
      pluginId: 'stub-push',
      issueDateString: '2026-08-03',
      device: { externalReference: 'm-1' },
    };

    expect(generateTokenSchema.safeParse({
      ...base,
      type: 'TOP_UP_KWH',
    }).success).toBe(false);
    expect(generateTokenSchema.safeParse({
      ...base,
      type: 'TOP_UP_KWH',
      payload: { kwh: 10 },
    }).success).toBe(true);

    expect(generateTokenSchema.safeParse({
      ...base,
      type: 'SET_POWER_LIMIT',
    }).success).toBe(false);
    expect(generateTokenSchema.safeParse({
      ...base,
      type: 'SET_POWER_LIMIT',
      payload: { powerLimit: 5000 },
    }).success).toBe(true);

    expect(generateTokenSchema.safeParse({
      ...base,
      type: 'CLEAR_TAMPER',
    }).success).toBe(true);
    expect(generateTokenSchema.safeParse({
      ...base,
      type: 'CLEAR_TAMPER',
      payload: { kwh: 1 },
    }).success).toBe(false);
  });
});
