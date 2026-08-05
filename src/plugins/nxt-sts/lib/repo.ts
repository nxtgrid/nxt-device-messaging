/**
 * @fileoverview nxt-sts HTTP client (Unit 8.2).
 *
 * Port of legacy `adapters/nxt-sts/_token.service.ts` HTTP path with native
 * `fetch` instead of Nest `HttpService` / axios. Base URL from secrets
 * (`NXT_STS_URL`).
 */

/** Transport / vendor failure from {@link createNxtStsClient}. */
export class NxtStsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NxtStsError';
  }
}

/** Successful STS `/token` response body (fields used by this client). */
export type NxtStsTokenResponse = {
  readonly token?: string;
};

/** Request body for `POST /token` (vendor vocabulary — `TOP_UP`, not wire `TOP_UP_KWH`). */
export type NxtStsTokenRequest = {
  readonly decoderKey: string;
  readonly randomNumber: number;
  readonly issueDate: string;
  readonly type: 'TOP_UP' | 'SET_POWER_LIMIT' | 'CLEAR_CREDIT' | 'CLEAR_TAMPER';
  readonly kwh?: number;
  readonly powerLimit?: number;
};

/**
 * Build an nxt-sts client closed over `apiBaseUrl`.
 *
 * @param deps - Base URL from {@link loadNxtStsSecrets}
 */
export function createNxtStsClient(deps: { readonly apiBaseUrl: string }) {
  const { apiBaseUrl } = deps;

  /**
   * POST `/token` and return the parsed JSON body.
   *
   * @param body - Vendor token request
   * @throws {@link NxtStsError} on non-OK HTTP or network failure
   */
  const sendTokenRequest = async (
    body: NxtStsTokenRequest,
  ): Promise<NxtStsTokenResponse> => {
    try {
      const response = await fetch(`${ apiBaseUrl }/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let responseData: unknown;
        try {
          responseData = await response.json();
        }
        catch {
          responseData = undefined;
        }
        console.error('[NXT STS TOKEN SERVICE] Fetch error', responseData);
        console.error('    for data', body);
        throw new NxtStsError('[NXT STS TOKEN SERVICE] Failed to generate token');
      }

      return await response.json() as NxtStsTokenResponse;
    }
    catch (err) {
      if (err instanceof NxtStsError) {
        throw err;
      }
      console.error(
        '[NXT STS TOKEN SERVICE] Fetch error',
        err instanceof Error && 'cause' in err ? err.cause : err,
      );
      console.error('    for data', body);
      throw new NxtStsError('[NXT STS TOKEN SERVICE] Failed to generate token');
    }
  };

  return { sendTokenRequest };
}

/** Thin HTTP client for nxt-sts ({@link createNxtStsClient}). */
export type NxtStsClient = ReturnType<typeof createNxtStsClient>;
