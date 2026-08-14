import { describe, expect, it } from 'vitest';

import { createRootLogger } from '#src/log.js';

describe('createRootLogger', () => {
  it('returns a pino logger named device-messaging', () => {
    const logger = createRootLogger({ stdout: 'json' });
    expect(logger.bindings().name).toBe('device-messaging');
    logger.info({ probe: true }, 'json-logger-ok');
  });

  it('accepts pretty stdout without throwing', () => {
    const logger = createRootLogger({ stdout: 'pretty' });
    expect(typeof logger.info).toBe('function');
  });
});
