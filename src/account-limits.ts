import { RequestError } from "@agentclientprotocol/sdk";
import type { Query, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  mergeClaudeRateLimitEvent,
  normalizeClaudeAccountLimits,
  type AccountLimitsSnapshot,
} from "./account-limits-extension.js";
import type { Logger } from "./logger.js";

/** Connection-owned limits, shared by both ACP cores and all their live sessions. */
export class ClaudeAccountLimits {
  private snapshot: AccountLimitsSnapshot | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly notify: (snapshot: AccountLimitsSnapshot) => Promise<void>,
  ) {}

  reset(): void {
    this.snapshot = null;
  }

  async read(query?: Query): Promise<AccountLimitsSnapshot> {
    if (!query) {
      throw RequestError.internalError(
        undefined,
        "Reading account limits requires a live Claude session",
      );
    }
    const response = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    const rateLimitKeys =
      response.rate_limits === null
        ? []
        : Object.keys(response.rate_limits).map((key) => key.replace(/[^A-Za-z0-9_:-]/g, "_"));
    const subscriptionType =
      response.subscription_type?.replace(/[^A-Za-z0-9_.:-]/g, "_") ?? "null";
    this.logger.log(
      `[account-limits] subscription_type=${subscriptionType} ` +
        `rate_limits_available=${response.rate_limits_available} ` +
        `rate_limits=${response.rate_limits === null ? "null" : "object"} ` +
        `rate_limit_keys=${rateLimitKeys.length > 0 ? rateLimitKeys.join(",") : "none"}`,
    );
    const snapshot = normalizeClaudeAccountLimits(response);
    const previous = this.snapshot;
    if (snapshot.buckets.length === 0 && previous !== null && previous.buckets.length > 0) {
      return previous;
    }
    this.snapshot = snapshot;
    return snapshot;
  }

  async update(info: SDKRateLimitInfo): Promise<void> {
    try {
      const previous = this.snapshot ?? { buckets: [] };
      const snapshot = mergeClaudeRateLimitEvent(previous, info);
      if (snapshot !== previous) {
        this.snapshot = snapshot;
        await this.notify(snapshot);
      }
    } catch (error) {
      const kind = error instanceof Error ? error.name : typeof error;
      this.logger.error(`Failed to publish ACP account-limits update (${kind})`);
    }
  }
}
