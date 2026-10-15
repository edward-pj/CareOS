// Dev default reaches the host through reverse port forwarding:
//   vega device start-port-forwarding --port 8787 --forward false
// Production must point at an HTTPS endpoint (and the cleartext policy in manifest.toml must be removed).
export const SERVER_URL = 'http://localhost:8787';

export const STATE_POLL_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const LONG_POLL_WAIT_S = 20; // server caps at 25
