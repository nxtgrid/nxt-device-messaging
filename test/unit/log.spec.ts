import { describe, expect, it } from 'vitest';

import { configureLogger, logger } from '#src/log.js';

describe('logger', () => {
  it('starts pretty (the documented default)', () => {
    expect(logger.bindings().name).toBe('device-messaging');
    expect(typeof logger.info).toBe('function');
  });
});

describe('configureLogger', () => {
  it('json stdout replaces the process logger', () => {
    configureLogger({ stdout: 'json' });
    expect(logger.bindings().name).toBe('device-messaging');
    logger.info({ module: 'log.spec', probe: true }, 'json-logger-ok');
  });
});
