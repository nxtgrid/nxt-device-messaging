/**
 * @fileoverview No-op {@link Metrics} for tests that do not scrape Prometheus.
 */

import type { Metrics } from '#src/metrics/index.js';

/** Satisfies the required metrics dep without a registry or `/metrics` route. */
export const noopMetrics: Metrics = {
  recordMessageTerminal() {},
  recordWebhookResult() {},
  recordIngressUnhandled() {},
  async registerRoutes() {},
};
