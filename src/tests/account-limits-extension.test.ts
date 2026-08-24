import { describe, expect, it } from "vitest";
import {
  mergeClaudeRateLimitEvent,
  normalizeClaudeAccountLimits,
  parseAccountLimitsReadRequest,
} from "../account-limits-extension.js";

describe("account limits extension", () => {
  it("normalizes subscription windows, model buckets, and extra usage", () => {
    expect(
      normalizeClaudeAccountLimits({
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 82, resets_at: "2099-12-31T00:00:00.000Z" },
          seven_day: { utilization: 41, resets_at: "2100-01-01T00:00:00.000Z" },
          seven_day_opus: { utilization: 12.5, resets_at: "2100-01-02T00:00:00.000Z" },
          model_scoped: [
            {
              display_name: "Fable",
              utilization: 27,
              resets_at: "2100-01-03T00:00:00.000Z",
            },
          ],
          extra_usage: {
            is_enabled: true,
            monthly_limit: 50,
            used_credits: 12.5,
            utilization: 25,
            currency: "USD",
          },
        },
      }),
    ).toEqual({
      defaultBucketId: "claude",
      buckets: [
        {
          id: "claude",
          label: "Claude",
          planType: "max",
          windows: [
            { usedPercent: 82, windowDurationMins: 300, resetsAt: 4102358400 },
            { usedPercent: 41, windowDurationMins: 10080, resetsAt: 4102444800 },
          ],
        },
        {
          id: "seven_day_opus",
          label: "Opus",
          planType: "max",
          windows: [{ usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 4102531200 }],
        },
        {
          id: "model_scoped:Fable",
          label: "Fable",
          planType: "max",
          windows: [{ usedPercent: 27, windowDurationMins: 10080, resetsAt: 4102617600 }],
        },
        {
          id: "extra_usage",
          label: "Extra usage (USD)",
          planType: "max",
          windows: [],
          credits: { balance: 37.5, unlimited: false },
        },
      ],
    });
  });

  it("preserves a known not-applicable result as an empty snapshot", () => {
    expect(
      normalizeClaudeAccountLimits({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
      }),
    ).toEqual({ buckets: [] });
  });

  it("does not present disabled extra usage as available capacity", () => {
    expect(
      normalizeClaudeAccountLimits({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          extra_usage: {
            is_enabled: false,
            monthly_limit: 50,
            used_credits: 0,
            utilization: 0,
          },
        },
      }),
    ).toEqual({ buckets: [] });
  });

  it("rejects malformed percentages and reset timestamps", () => {
    expect(() =>
      normalizeClaudeAccountLimits({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 101, resets_at: "2099-12-31T00:00:00.000Z" },
        },
      }),
    ).toThrow("invalid account-limit percentage");

    expect(() =>
      normalizeClaudeAccountLimits({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 10, resets_at: "not-a-time" },
        },
      }),
    ).toThrow("invalid account-limit reset time");
  });

  it("merges a structured rolling event into the complete snapshot", () => {
    const snapshot = normalizeClaudeAccountLimits({
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 70, resets_at: "2099-12-31T00:00:00.000Z" },
        seven_day: { utilization: 30, resets_at: "2100-01-01T00:00:00.000Z" },
      },
    });

    expect(
      mergeClaudeRateLimitEvent(snapshot, {
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 100,
        resetsAt: 4102358500,
      }),
    ).toEqual({
      defaultBucketId: "claude",
      buckets: [
        {
          id: "claude",
          label: "Claude",
          planType: "pro",
          reachedType: "five_hour",
          windows: [
            { usedPercent: 100, windowDurationMins: 300, resetsAt: 4102358500 },
            { usedPercent: 30, windowDurationMins: 10080, resetsAt: 4102444800 },
          ],
        },
      ],
    });
  });

  it("seeds an observed snapshot from a complete structured event", () => {
    expect(
      mergeClaudeRateLimitEvent(
        { buckets: [] },
        {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 22,
          resetsAt: 4102358500,
        },
      ),
    ).toEqual({
      defaultBucketId: "claude",
      buckets: [
        {
          id: "claude",
          label: "Claude",
          windows: [{ usedPercent: 22, windowDurationMins: 300, resetsAt: 4102358500 }],
        },
      ],
    });
  });

  it("does not invent a window from an incomplete event", () => {
    const snapshot = { buckets: [] };
    expect(
      mergeClaudeRateLimitEvent(snapshot, {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 4102358500,
      }),
    ).toBe(snapshot);
  });

  it("requires the read request to be an empty object", () => {
    expect(parseAccountLimitsReadRequest({})).toEqual({});
    expect(() => parseAccountLimitsReadRequest([])).toThrow("must be an empty object");
    expect(() => parseAccountLimitsReadRequest({ sessionId: "session-1" })).toThrow(
      "must be an empty object",
    );
  });
});
