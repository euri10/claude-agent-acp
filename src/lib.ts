// The package's public API: serve ACP (v1 and v2) on stdio, and the wire
// names of the `authStatus` extension that a client needs to read its traffic.
export { serveAcp, type AcpProtocols } from "./serve.js";
export type { Logger } from "./logger.js";
export {
  AUTH_STATUS_UPDATE_METHOD,
  type AuthStatus,
  type AuthStatusAccount,
  type AuthStatusKind,
  type AuthStatusUpdateNotification,
} from "./auth-status.js";
export {
  ACCOUNT_LIMITS_META_KEY,
  ACCOUNT_LIMITS_READ_METHOD,
  ACCOUNT_LIMITS_UPDATED_METHOD,
  ACCOUNT_LIMITS_VERSION,
  mergeClaudeRateLimitEvent,
  normalizeClaudeAccountLimits,
  parseAccountLimitsReadRequest,
  type AccountLimitBucket,
  type AccountLimitsCapability,
  type AccountLimitsReadRequest,
  type AccountLimitsSnapshot,
  type AccountLimitWindow,
} from "./account-limits-extension.js";
