import { RequestError } from "@agentclientprotocol/sdk";
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

export const ACCOUNT_LIMITS_META_KEY = "io.github.euri10.louiselm";
export const ACCOUNT_LIMITS_VERSION = 1 as const;
export const ACCOUNT_LIMITS_READ_METHOD = "_io.github.euri10.louiselm/account_limits/read";
export const ACCOUNT_LIMITS_UPDATED_METHOD = "_io.github.euri10.louiselm/account_limits/updated";

export type AccountLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
};

export type AccountLimitBucket = {
  id: string;
  label?: string;
  windows: AccountLimitWindow[];
  reachedType?: string;
  planType?: string;
  credits?: {
    balance?: number;
    unlimited?: boolean;
  };
};

export type AccountLimitsSnapshot = {
  defaultBucketId?: string;
  buckets: AccountLimitBucket[];
  unlimited?: boolean;
};

export type AccountLimitsCapability = {
  version: typeof ACCOUNT_LIMITS_VERSION;
  readMethod: typeof ACCOUNT_LIMITS_READ_METHOD;
  updatedMethod: typeof ACCOUNT_LIMITS_UPDATED_METHOD;
};

type ClaudeUsageLimits = Pick<
  SDKControlGetUsageResponse,
  "subscription_type" | "rate_limits_available" | "rate_limits"
>;

type ClaudeWindow = {
  utilization: number | null;
  resets_at: string | null;
};

const WEEK_MINS = 7 * 24 * 60;

const WEEKLY_BUCKETS = [
  ["seven_day_oauth_apps", "OAuth apps"],
  ["seven_day_opus", "Opus"],
  ["seven_day_sonnet", "Sonnet"],
] as const;

function normalizePercentage(value: number, scale = 1): number {
  if (!Number.isFinite(value) || value < 0 || value > 100 / scale) {
    throw new Error("Claude Agent SDK returned an invalid account-limit percentage");
  }
  return value * scale;
}

function normalizeResetTime(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis <= 0) {
    throw new Error("Claude Agent SDK returned an invalid account-limit reset time");
  }
  return Math.floor(millis / 1000);
}

function normalizeWindow(window: ClaudeWindow | null | undefined, duration: number) {
  if (!window || window.utilization === null || window.resets_at === null) return null;
  return {
    usedPercent: normalizePercentage(window.utilization),
    windowDurationMins: duration,
    resetsAt: normalizeResetTime(window.resets_at),
  };
}

function withPlan(bucket: AccountLimitBucket, planType: string | null) {
  if (planType && planType.length > 0) bucket.planType = planType;
  return bucket;
}

/** Convert Claude's structured `/usage` response into the shared ACP shape. */
export function normalizeClaudeAccountLimits(response: ClaudeUsageLimits): AccountLimitsSnapshot {
  if (!response.rate_limits_available || response.rate_limits === null) {
    return { buckets: [] };
  }

  const limits = response.rate_limits;
  const buckets: AccountLimitBucket[] = [];
  const defaultWindows = [
    normalizeWindow(limits.five_hour, 5 * 60),
    normalizeWindow(limits.seven_day, WEEK_MINS),
  ].filter((window): window is AccountLimitWindow => window !== null);

  if (defaultWindows.length > 0) {
    buckets.push(
      withPlan(
        {
          id: "claude",
          label: "Claude",
          windows: defaultWindows,
        },
        response.subscription_type,
      ),
    );
  }

  for (const [id, label] of WEEKLY_BUCKETS) {
    const window = normalizeWindow(limits[id], WEEK_MINS);
    if (window) {
      buckets.push(withPlan({ id, label, windows: [window] }, response.subscription_type));
    }
  }

  const modelIds = new Set<string>();
  for (const model of limits.model_scoped ?? []) {
    if (typeof model.display_name !== "string" || model.display_name.length === 0) {
      throw new Error("Claude Agent SDK returned an empty account-limit bucket label");
    }
    const id = `model_scoped:${model.display_name}`;
    if (modelIds.has(id)) {
      throw new Error("Claude Agent SDK returned duplicate account-limit bucket labels");
    }
    modelIds.add(id);
    const window = normalizeWindow(model, WEEK_MINS);
    if (window) {
      buckets.push(
        withPlan({ id, label: model.display_name, windows: [window] }, response.subscription_type),
      );
    }
  }

  const extra = limits.extra_usage;
  if (extra?.is_enabled) {
    for (const amount of [extra.monthly_limit, extra.used_credits]) {
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        throw new Error("Claude Agent SDK returned an invalid extra-usage credit amount");
      }
    }
    if (extra.utilization !== null) normalizePercentage(extra.utilization);

    const label = extra.currency ? `Extra usage (${extra.currency})` : "Extra usage";
    const bucket = withPlan(
      {
        id: "extra_usage",
        label,
        windows: [],
        credits: { unlimited: false },
      },
      response.subscription_type,
    );
    if (extra.monthly_limit !== null && extra.used_credits !== null) {
      bucket.credits!.balance = Math.max(0, extra.monthly_limit - extra.used_credits);
    }
    if (extra.utilization !== null && extra.utilization >= 100) {
      bucket.reachedType = "extra_usage";
    }
    buckets.push(bucket);
  }

  const result: AccountLimitsSnapshot = { buckets };
  if (buckets.some((bucket) => bucket.id === "claude")) {
    result.defaultBucketId = "claude";
  } else if (buckets.length === 1) {
    result.defaultBucketId = buckets[0].id;
  }
  return result;
}

function eventTarget(rateLimitType: SDKRateLimitInfo["rateLimitType"]) {
  switch (rateLimitType) {
    case "five_hour":
      return { id: "claude", label: "Claude", duration: 5 * 60 };
    case "seven_day":
      return { id: "claude", label: "Claude", duration: WEEK_MINS };
    case "seven_day_opus":
      return { id: "seven_day_opus", label: "Opus", duration: WEEK_MINS };
    case "seven_day_sonnet":
      return { id: "seven_day_sonnet", label: "Sonnet", duration: WEEK_MINS };
    case "seven_day_overage_included":
      return {
        id: "seven_day_overage_included",
        label: "Overage-included models",
        duration: WEEK_MINS,
      };
    case "overage":
      return { id: "extra_usage", label: "Extra usage", duration: null };
    default:
      return null;
  }
}

/** Merge one structured SDK rate-limit event into the last known snapshot. */
export function mergeClaudeRateLimitEvent(
  snapshot: AccountLimitsSnapshot,
  info: SDKRateLimitInfo,
): AccountLimitsSnapshot {
  const target = eventTarget(info.rateLimitType);
  if (!target) return snapshot;

  // Stream utilization is a fraction; usage-control responses already use percentages.
  const eventUsedPercent =
    info.utilization === undefined ? undefined : normalizePercentage(info.utilization, 100);
  if (info.resetsAt !== undefined && (!Number.isSafeInteger(info.resetsAt) || info.resetsAt <= 0)) {
    throw new Error("Claude Agent SDK returned an invalid account-limit reset time");
  }

  const existing = snapshot.buckets.find((candidate) => candidate.id === target.id);
  const previousWindow = existing?.windows.find(
    (window) => window.windowDurationMins === target.duration,
  );
  const canUpdateWindow =
    target.duration !== null &&
    (eventUsedPercent ?? previousWindow?.usedPercent) !== undefined &&
    (info.resetsAt ?? previousWindow?.resetsAt) !== undefined;
  const canUpdateReached =
    info.status === "rejected" || existing?.reachedType === info.rateLimitType;
  if (!canUpdateWindow && !canUpdateReached) return snapshot;

  const buckets = snapshot.buckets.map((bucket) => ({
    ...bucket,
    windows: bucket.windows.map((window) => ({ ...window })),
    ...(bucket.credits && { credits: { ...bucket.credits } }),
  }));
  let bucket = buckets.find((candidate) => candidate.id === target.id);
  if (!bucket) {
    bucket = { id: target.id, label: target.label, windows: [] };
    const planType = buckets.find((candidate) => candidate.planType)?.planType;
    if (planType) bucket.planType = planType;
    buckets.push(bucket);
  }

  if (target.duration !== null && canUpdateWindow) {
    const previous = bucket.windows.find((window) => window.windowDurationMins === target.duration);
    const usedPercent = eventUsedPercent ?? previous?.usedPercent;
    const resetsAt = info.resetsAt ?? previous?.resetsAt;
    if (usedPercent !== undefined && resetsAt !== undefined) {
      const updated = {
        usedPercent,
        windowDurationMins: target.duration,
        resetsAt,
      };
      if (previous) {
        Object.assign(previous, updated);
      } else {
        bucket.windows.push(updated);
      }
    }
  }

  if (info.status === "rejected") {
    bucket.reachedType = info.rateLimitType;
  } else if (bucket.reachedType === info.rateLimitType) {
    delete bucket.reachedType;
  }

  const result = { ...snapshot, buckets };
  if (result.defaultBucketId === undefined && buckets.some((item) => item.id === "claude")) {
    result.defaultBucketId = "claude";
  }
  return result;
}

export type AccountLimitsReadRequest = Record<string, never>;

export function parseAccountLimitsReadRequest(params: unknown): AccountLimitsReadRequest {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).length > 0
  ) {
    throw RequestError.invalidParams(undefined, "account-limits params must be an empty object");
  }
  return {};
}
