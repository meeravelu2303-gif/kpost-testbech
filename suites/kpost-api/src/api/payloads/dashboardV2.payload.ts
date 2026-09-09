/**
 * Request builders for the Dashboard V2 controller.
 *
 * Per the KPOST API spec these are simple pagination payloads keyed by `serverTime` / message
 * ids (not the sender/receiver objects an earlier version assumed):
 *   - katchupDashboardMsg   `{ serverTime }`
 *   - kallDashboard         `{ serverTime }`
 *   - homeDashboardMsgs     `{ serverTime, lastMsgID }`
 *   - homeDashboardNewMsgs  `{ firstMsgID, serverTime }`
 *   - getKmailDashboardMsg  `{ kmailID }`
 *
 * Overrides are `Record<string, unknown>` on purpose: the fuzzing suites submit wrong-typed
 * values, which a strict override type would forbid.
 */

// Excel spec: `{ serverTime }`.
export function buildKatchupDashboardPayload(overrides: Record<string, unknown> = {}) {
  return {
    serverTime: Date.now(),
    ...overrides,
  };
}

// Excel spec: `{ serverTime }`.
export function buildKallDashboardPayload(overrides: Record<string, unknown> = {}) {
  return {
    serverTime: Date.now(),
    ...overrides,
  };
}

// Excel spec: homeDashboardMsgs `{ serverTime, lastMsgID }`, homeDashboardNewMsgs
// `{ firstMsgID, serverTime }` — the union covers both home routes.
export function buildHomeDashboardPayload(overrides: Record<string, unknown> = {}) {
  return {
    firstMsgID: 0,
    serverTime: Date.now(),
    lastMsgID: 50,
    ...overrides,
  };
}

// Excel spec: `{ kmailID }`.
export function buildKmailDashboardPayload(overrides: Record<string, unknown> = {}) {
  return {
    kmailID: '',
    ...overrides,
  };
}
