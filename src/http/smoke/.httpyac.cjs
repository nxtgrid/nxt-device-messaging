/**
 * httpYac environments — switch with the httpYac env picker in the status bar.
 *
 * `.cjs` because the package is `"type": "module"`; httpYac expects CommonJS `module.exports`.
 * `apiKey` lives here (not `$dotenv`) so multi-root workspaces still resolve it; keep in sync
 * with `DEVICE_MESSAGING_API_KEY` in repo-root `.env`.
 */
module.exports = {
  environments: {
    $shared: {
      baseUrl: 'http://localhost:3100',
      apiKey: 'dev-key',
    },
    local: {},
  },
};
