/**
 * @fileoverview CALIN API V2 HTTP client.
 *
 * Native `fetch`; JWT `exp` decoded without `jsonwebtoken`. Login credentials and
 * base URL come from secrets (`CALIN_API_V2_*`); the client caches a Bearer
 * token and refreshes on expiry or HTTP 401.
 */

import { logger } from '../../../log.js';
import { CLIENT_SAFETY_DEADLINE_MS } from '../../_shared/client-safety-deadline.js';

/** Options for {@link CalinApiV2Error}. */
export type CalinApiV2ErrorOptions = {
  readonly code?: number;
  /** When true, outgoing `parseError` sets `skipRetry` (unrecoverable). */
  readonly skipRetry?: boolean;
};

/**
 * Vendor / transport / local failure for CALIN API V2.
 * Use `{ skipRetry: true }` for permanent validation failures (bad payload, etc.).
 */
export class CalinApiV2Error extends Error {
  readonly code?: number;
  readonly skipRetry: boolean;

  constructor(message: string, options: CalinApiV2ErrorOptions = {}) {
    super(message);
    this.name = 'CalinApiV2Error';
    this.code = options.code;
    this.skipRetry = options.skipRetry ?? false;
  }
}

export type CalinApiV2DataItem =
  // Reads
  | 'Current Credit Balance'
  | 'Phase-A Voltage' // | 'Phase-B Voltage' | 'Phase-C Voltage'
  | 'Power'
  | 'Phase-A Current(A)' // | 'Phase-B Current(A)' | 'Phase-C Current(A)'
  | 'Maximum power threshold'
  | 'Meter Firmware Version'
  // Not implemented
  // | 'The Number Of Power Down'
  // | 'Special status identifier'

  // Write
  | 'Clock(time)'

  // Control
  | 'Relay On/Off' // 'Connected

  // Tokens
  | 'Token'
;

/**
 * Create-task body. Happy path is `code === 0` / `reason === 'success'`; the
 * client still returns other values (logs only) so callers must not assume success.
 */
export type CalinApiV2CreateTaskResponse = {
  code: number;
  reason: string;
  result?: {
    id: string;
  }[];
};

/**
 * Poll / token body. Same `code` / `reason` caveat as
 * {@link CalinApiV2CreateTaskResponse}.
 */
export type CalinApiV2TaskDataResponse = {
  code: number;
  reason: string;
  result?: {
    token?: string;
    data?: {
      name: CalinApiV2DataItem;
      status: 0 | 1 | 2 | 3; // Processing | Success | Failed | (Token) Rejected
      data: number | string;
      pn?: string;
    }[];
  };
};

type CalinApiV2Response = CalinApiV2CreateTaskResponse | CalinApiV2TaskDataResponse;

type RequestBody = Record<string, string | number | boolean> | Record<string, string | number | boolean>[];

type CachedToken = {
  readonly token: string;
  /** Expiry as epoch milliseconds. */
  readonly expMs: number;
};

type LoginResponseBody = {
  readonly reason?: unknown;
  readonly result?: {
    readonly token?: unknown;
  };
};

type UnexpectedCodeProbe = {
  readonly code?: unknown;
  readonly reason?: unknown;
};

/** Login request timeout. */
const CUSTOM_LOGIN_TIMEOUT_MS = 5_000;

/** Attempts for login and for each authenticated request wave. */
const FETCH_RETRIES = 3;

/** Refresh when fewer than this many ms remain before JWT `exp`. */
const TOKEN_EXPIRY_SKEW_MS = 1_000;

/**
 * Read JWT `exp` (seconds) from the payload segment without verifying signature.
 *
 * @param jwt - Compact JWT string
 * @returns `exp` as epoch milliseconds, or `undefined` if unreadable
 */
function readJwtExpMs(jwt: string): number | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2 || parts[1] === undefined || parts[1] === '') {
    return undefined;
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return undefined;
    }
    return payload.exp * 1_000;
  }
  catch {
    return undefined;
  }
}

/**
 * Build a CALIN API V2 client closed over base URL + login credentials.
 *
 * @param deps - URL and admin login fields from {@link loadCalinApiV2Secrets}
 */
export function createCalinApiV2Client(deps: {
  readonly apiBaseUrl: string;
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly companyName: string;
}) {
  const { apiBaseUrl, adminUsername, adminPassword, companyName } = deps;

  const loginCredentials = {
    userId: adminUsername,
    password: adminPassword,
    company: companyName,
  } as const;

  let cachedToken: CachedToken | undefined;
  /** Single-flight login so concurrent callers share one `/API/User/Login`. */
  let fetchTokenInFlight: Promise<void> | undefined;

  const fetchToken = async (): Promise<void> => {
    if (fetchTokenInFlight !== undefined) {
      return fetchTokenInFlight;
    }

    fetchTokenInFlight = (async () => {
      for (let i = 0; i < FETCH_RETRIES; i++) {
        try {
          const response = await fetch(`${ apiBaseUrl }/API/User/Login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(loginCredentials),
            signal: AbortSignal.timeout(CUSTOM_LOGIN_TIMEOUT_MS),
          });

          let data: LoginResponseBody | undefined;
          try {
            data = await response.json() as LoginResponseBody;
          }
          catch {
            data = undefined;
          }

          const freshToken = data?.result?.token;
          if (typeof freshToken !== 'string' || freshToken === '') {
            // No retry: empty/rejected login body will not improve on another attempt.
            logger.error({
              module: 'calin-api-v2.repo',
              reason: data?.reason,
            }, 'login returned no token');
            cachedToken = undefined;
            break;
          }

          const expMs = readJwtExpMs(freshToken);
          if (expMs === undefined) {
            logger.error({ module: 'calin-api-v2.repo' }, 'login token missing exp claim');
            cachedToken = undefined;
            break;
          }

          logger.info({ module: 'calin-api-v2.repo' }, 'got login token');
          cachedToken = { token: freshToken, expMs };
          break;
        }
        catch (err) {
          const detail = typeof err === 'object' && err !== null && 'cause' in err
            ? (err as { cause?: unknown }).cause
            : err;
          logger.error({
            module: 'calin-api-v2.repo',
            err: detail,
            attempt: i + 1,
          }, 'login failed');
        }
      }
    })().finally(() => {
      fetchTokenInFlight = undefined;
    });

    return fetchTokenInFlight;
  };

  const ensureToken = async (): Promise<CachedToken> => {
    const needsRefresh = cachedToken === undefined
      || cachedToken.expMs - Date.now() < TOKEN_EXPIRY_SKEW_MS;
    if (needsRefresh) {
      await fetchToken();
    }
    if (cachedToken === undefined) {
      throw new CalinApiV2Error('CALIN API-V2 failed to get a token');
    }
    return cachedToken;
  };

  const postAuthorized = async (
    path: string,
    body: RequestBody,
    bearer: string,
  ): Promise<{ ok: true; data: CalinApiV2Response } | { ok: false; unauthorized: boolean }> => {
    try {
      const response = await fetch(apiBaseUrl + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${ bearer }`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CLIENT_SAFETY_DEADLINE_MS),
      });

      if (response.status === 401) {
        logger.info({ module: 'calin-api-v2.repo', path }, 'unauthorized, will refresh token');
        return { ok: false, unauthorized: true };
      }

      if (!response.ok) {
        logger.error({
          module: 'calin-api-v2.repo',
          path,
          status: response.status,
          statusText: response.statusText,
        }, 'non-OK response');
        return { ok: false, unauthorized: false };
      }

      const data = await response.json() as CalinApiV2Response & UnexpectedCodeProbe;
      if (data.code !== 0 || data.reason !== 'success') {
        logger.info({
          module: 'calin-api-v2.repo',
          path,
          code: data.code,
          reason: data.reason,
        }, 'unexpected code or reason');
      }
      return { ok: true, data };
    }
    catch (err) {
      logger.error({ module: 'calin-api-v2.repo', path, err }, 'fetch failed');
      return { ok: false, unauthorized: false };
    }
  };

  /**
   * Authenticated POST to `apiBaseUrl + path`. Ensures a login Bearer token,
   * retries transport failures, and refreshes once on HTTP 401.
   *
   * @param path - Vendor path (e.g. `/API/RemoteMeterTask/CreateReadingTask`)
   * @param body - JSON object or array body
   */
  const sendRequest = async <T extends CalinApiV2Response>(
    path: string,
    body: RequestBody,
  ): Promise<T> => {
    let token = await ensureToken();

    for (let i = 0; i < FETCH_RETRIES; i++) {
      const outcome = await postAuthorized(path, body, token.token);
      if (outcome.ok) {
        return outcome.data as T;
      }
      if (outcome.unauthorized) {
        break;
      }
      if (i === FETCH_RETRIES - 1) {
        throw new CalinApiV2Error('CALIN API-V2 is down');
      }
    }

    cachedToken = undefined;
    await fetchToken();
    if (cachedToken === undefined) {
      throw new CalinApiV2Error('[CALIN API-V2] Can\'t log in, API may be down');
    }
    token = cachedToken;

    for (let i = 0; i < FETCH_RETRIES; i++) {
      const outcome = await postAuthorized(path, body, token.token);
      if (outcome.ok) {
        return outcome.data as T;
      }
      if (outcome.unauthorized) {
        // Fresh token already minted for this wave — further 401s are auth, not stale JWT.
        logger.error({ module: 'calin-api-v2.repo', path }, 'unauthorized after token refresh');
        throw new CalinApiV2Error(
          '[CALIN API-V2] Unauthorized after token refresh',
        );
      }
      if (i === FETCH_RETRIES - 1) {
        throw new CalinApiV2Error('CALIN API-V2 is down');
      }
    }

    throw new CalinApiV2Error('CALIN API-V2 is down');
  };

  return { sendRequest };
}

/** Thin HTTP client for CALIN API V2 ({@link createCalinApiV2Client}). */
export type CalinApiV2Client = ReturnType<typeof createCalinApiV2Client>;
