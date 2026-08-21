/**
 * @fileoverview CALIN API V1 HTTP client (Unit 7.2).
 *
 * Port of legacy `adapters/calin-api-v1/lib/repo.ts` with native `fetch` instead
 * of axios. Base URL comes from secrets (`CALIN_API_V1_URL`); credentials are
 * attached by outgoing / token / incoming (Units 7.3–7.5).
 */

import { logger } from '../../../log.js';
import { CLIENT_SAFETY_DEADLINE_MS } from '../../_shared/client-safety-deadline.js';
import { toSafeNumberOrNull } from '../../_shared/to-safe-number-or-null.js';

/** Options for {@link CalinApiV1Error}. */
export type CalinApiV1ErrorOptions = {
  readonly code?: number | string | null;
  /** When true, outgoing `parseError` sets `skipRetry` (unrecoverable). */
  readonly skipRetry?: boolean;
};

/**
 * Vendor / transport / local failure for CALIN API V1.
 * Use `{ skipRetry: true }` for permanent validation failures (bad payload, etc.).
 * Vendor ResultCode `99` is also treated as skip-retry in outgoing `parseError`.
 */
export class CalinApiV1Error extends Error {
  readonly code?: number | string | null;
  readonly skipRetry: boolean;

  constructor(message: string, options: CalinApiV1ErrorOptions = {}) {
    super(message);
    this.name = 'CalinApiV1Error';
    this.code = options.code;
    this.skipRetry = options.skipRetry ?? false;
  }
}

// @NOTE :: This has overlap with CalinApiV1ReadMap in outgoing
export type CalinApiV1DataItem =
  // Read
  | 'Current Credit Register'
  | 'Voltage' | 'VoltageA' | 'VoltageB' | 'VoltageC'
  | 'Power' /* | 'PowerA' | 'PowerB' | 'PowerC' */
  | 'Current' | 'CurrentA' | 'CurrentB' | 'CurrentC'
  | 'Maximum power threshold'
  | 'Version'
  // Not implemented
  // | 'The number of power down'
  // | 'Special status identifier'

  // Read/Write
  | 'Date'

  // Control
  | 'Switch On'
  | 'Switch Off'

  // Token
  | 'Token'
;

/**
 * COMM task body. Happy path is `ResultCode === '00'` / `Reason === 'OK'`
 * (`'99'` is also common for rejected tokens); the client still returns other
 * values (logs only) so callers must not assume success.
 */
export type CalinApiV1CommResponse = {
  Result?: {
    TaskNo: string;
    Status: 'True' | 'False' | 'unknown' | null;
    DataItem: CalinApiV1DataItem;
    Data: string;
  };
  ResultCode: string;
  Reason: string;
};

/**
 * POS mint body. Happy path is `result_code === 0` / `reason === 'OK'`;
 * same caveat as {@link CalinApiV1CommResponse}.
 */
export type CalinApiV1PosResponse = {
  result?: { token: string; };
  result_code: number;
  reason: string;
};

/**
 * Maintenance mint body. Same `result_code` / `reason` caveat as
 * {@link CalinApiV1PosResponse}.
 */
export type CalinApiV1MaintenanceResponse = {
  result?: string;
  result_code: number;
  reason: string;
};

type CalinApiV1Response =
  | CalinApiV1CommResponse
  | CalinApiV1PosResponse
  | CalinApiV1MaintenanceResponse;

type UnexpectedCodeProbe = {
  readonly result_code?: unknown;
  readonly reason?: unknown;
  readonly ResultCode?: unknown;
  readonly Reason?: unknown;
};

type DownResponseBody = {
  readonly Message?: unknown;
};

/**
 * Read a Node-style errno from a fetch failure (`cause.code` or top-level `code`).
 */
function getNetworkErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const withCode = err as { code?: unknown; cause?: unknown };
  if (typeof withCode.code === 'string') {
    return withCode.code;
  }
  if (typeof withCode.cause === 'object' && withCode.cause !== null) {
    const causeCode = (withCode.cause as { code?: unknown }).code;
    if (typeof causeCode === 'string') {
      return causeCode;
    }
  }
  return undefined;
}

/**
 * Build a CALIN API V1 client closed over `apiBaseUrl`.
 *
 * @param deps - Base URL from {@link loadCalinApiV1Secrets}
 */
export function createCalinApiV1Client(deps: { readonly apiBaseUrl: string }) {
  const { apiBaseUrl } = deps;

  const sendRequest = async <T extends CalinApiV1Response>(
    path: string,
    body: Record<string, string | number | boolean>,
  ): Promise<T> => {
    try {
      const response = await fetch(apiBaseUrl + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CLIENT_SAFETY_DEADLINE_MS),
      });

      const contentType = response.headers.get('content-type') ?? undefined;

      if (contentType?.includes('text/html')) {
        const message = '[CALIN API-V1] responded with a HTML page..';
        const code = toSafeNumberOrNull(response.status);
        logger.error({ module: 'calin-api-v1.repo', path, status: code }, 'HTML response');
        throw new CalinApiV1Error(message, { code });
      }

      if (!response.ok) {
        let responseMessage: unknown;
        try {
          const errBody = await response.json() as DownResponseBody;
          responseMessage = errBody.Message;
        }
        catch {
          responseMessage = undefined;
        }
        const message = `[CALIN API-V1] is down: ${ String(responseMessage) }`;
        const code = toSafeNumberOrNull(response.status);
        logger.error({
          module: 'calin-api-v1.repo',
          path,
          status: code,
          responseMessage,
        }, 'non-OK response');
        throw new CalinApiV1Error(message, { code });
      }

      const data = await response.json() as T & UnexpectedCodeProbe;
      if (
        (data.result_code !== undefined && data.result_code !== 0)
        || (data.reason !== undefined && data.reason !== 'OK')
        || (data.ResultCode !== undefined
          && ![ '00', '99' ].includes(String(data.ResultCode)))
        || (data.Reason !== undefined
          && ![ 'OK', 'other error' ].includes(String(data.Reason)))
      ) {
        logger.info({
          module: 'calin-api-v1.repo',
          path,
          resultCode: data.result_code ?? data.ResultCode,
          reason: data.reason ?? data.Reason,
        }, 'unexpected result code or reason');
      }
      return data;
    }
    catch (err) {
      if (err instanceof CalinApiV1Error) {
        throw err;
      }

      let message: string;
      let code: number | string | null | undefined;
      const networkCode = getNetworkErrorCode(err);

      if (networkCode === 'ECONNREFUSED') {
        logger.error({ module: 'calin-api-v1.repo', path, err }, 'ECONNREFUSED');
        message = '[CALIN API-V1] could not be reached, connection was refused';
        code = networkCode;
      }
      else if (networkCode === 'ECONNRESET') {
        logger.error({ module: 'calin-api-v1.repo', path, err }, 'ECONNRESET');
        message = '[CALIN API-V1] abruptly closed its end of the connection';
        code = networkCode;
      }
      else if (
        typeof err === 'object'
        && err !== null
        && 'cause' in err
        && (err as { cause?: unknown }).cause
      ) {
        logger.error({ module: 'calin-api-v1.repo', path, err }, 'unhandled cause');
        message = '[CALIN API-V1] is down';
        code = getNetworkErrorCode((err as { cause: unknown }).cause)
          ?? getNetworkErrorCode(err);
      }
      else if (err instanceof Error && err.message) {
        logger.error({ module: 'calin-api-v1.repo', path, err }, 'fetch failed');
        message = '[CALIN API-V1] is down';
      }
      else {
        logger.error({ module: 'calin-api-v1.repo', path, err }, 'fetch failed');
        message = '[CALIN API-V1] is down';
      }

      throw new CalinApiV1Error(message, { code });
    }
  };

  return { sendRequest };
}

/** Thin HTTP client for CALIN API V1 ({@link createCalinApiV1Client}). */
export type CalinApiV1Client = ReturnType<typeof createCalinApiV1Client>;
