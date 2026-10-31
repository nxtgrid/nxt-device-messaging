/**
 * @fileoverview Failures from a configure post.
 *
 * `skipRetry` is set for a 4xx and for a body this plugin cannot post.
 * A 5xx, a timeout, or a network error leaves it false.
 */

/** Local or HTTP failure from `sendOne`. */
export class SparkmeterSparknetHttpError extends Error {
  readonly status?: number;
  readonly skipRetry: boolean;

  constructor(
    message: string,
    options: { readonly status?: number; readonly skipRetry?: boolean } = {},
  ) {
    super(message);
    this.name = 'SparkmeterSparknetHttpError';
    this.status = options.status;
    this.skipRetry = options.skipRetry ?? false;
  }
}
