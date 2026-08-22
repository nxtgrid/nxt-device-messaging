/**
 * Fail if a MULTI/EXEC (or pipeline) reply is missing or any command errored.
 *
 * @param results - `exec()` reply (`null` if the transaction was aborted)
 * @param operation - Label for the error message
 */
export function assertExecSucceeded(
  results: [Error | null, unknown][] | null,
  operation: string,
): void {
  if (results === null) {
    throw new Error(`[REDIS] ${ operation } aborted (MULTI/EXEC returned null)`);
  }
  for (const [ err ] of results) {
    if (err) {
      throw new Error(`[REDIS] ${ operation } failed`, { cause: err });
    }
  }
}
