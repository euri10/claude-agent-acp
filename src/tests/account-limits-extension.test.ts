import { describe, expect, it } from "vitest";
import { unifiedRateLimit } from "./fixtures/claude-rate-limit.js";
import {
  mergeClaudeRateLimitEvent,
  normalizeClaudeAccountLimits,
  parseAccountLimitsReadRequest,
} from "../account-limits-extension.js";

describe("account limits extension", () => {
  it("reads both captured unified windows without top-level utilization", () => {
    const result = mergeClaudeRateLimitEvent({ buckets: [] }, unifiedRateLimit);
    expect(result.buckets).toEqual([
      {
        id: "claude",
        label: "Claude",
        windows: [
          { usedPercent: 1, windowDurationMins: 300, resetsAt: 1788937200 },
          { usedPercent: 36, windowDurationMins: 10080, resetsAt: 1789005600 },
        ],
      },
    ]);
    expect(result.defaultBucketId).toBe("claude");
  });

  it("keeps reached status scoped to the reported window and preserves sparse updates", () => {
    const snapshot = mergeClaudeRateLimitEvent(
      { buckets: [] },
      {
        ...unifiedRateLimit,
        status: "rejected",
        rateLimitType: "seven_day",
        resetsAt: 1789005600,
      },
    );
    expect(snapshot.buckets[0].reachedType).toBe("seven_day");
    const updated = mergeClaudeRateLimitEvent(snapshot, {
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.02 } },
    });
    expect(updated.buckets[0].reachedType).toBe("seven_day");
    expect(updated.buckets[0].windows[0]).toEqual({
      usedPercent: 2,
      windowDurationMins: 300,
      resetsAt: 1788937200,
    });
    expect(updated.buckets[0].windows[1]).toEqual(snapshot.buckets[0].windows[1]);
    expect(snapshot.buckets[0].windows[0].usedPercent).toBe(1);
  });

  it.each(
    [
      null,
      [],
      1,
      { five_hour: null },
      { five_hour: [] },
      { five_hour: { utilization: "0.1" } },
      { five_hour: { utilization: 1.1 } },
      { five_hour: { resetsAt: "123" } },
      { five_hour: { resetsAt: -1 } },
    ].map((value) => [value]),
  )("rejects malformed unified windows %j", (unifiedWindows) => {
    const snapshot = { buckets: [] };
    expect(() =>
      mergeClaudeRateLimitEvent(snapshot, { ...unifiedRateLimit, unifiedWindows }),
    ).toThrow();
    expect(snapshot).toEqual({ buckets: [] });
  });

  it("rejects conflicting duplicate window data", () => {
    expect(() =>
      mergeClaudeRateLimitEvent(
        { buckets: [] },
        {
          ...unifiedRateLimit,
          utilization: 0.9,
        },
      ),
    ).toThrow("conflicting account-limit window");
    expect(() =>
      mergeClaudeRateLimitEvent(
        { buckets: [] },
        {
          ...unifiedRateLimit,
          resetsAt: 1788937201,
        },
      ),
    ).toThrow("conflicting account-limit window");
  });

  it("ignores unknown window names without inventing a quota", () => {
    const result = mergeClaudeRateLimitEvent(
      { buckets: [] },
      {
        status: "allowed",
        unifiedWindows: { future_window: { newField: true } },
      },
    );
    expect(result).toEqual({ buckets: [] });
  });
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
        utilization: 1,
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
          utilization: 0.22,
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

  // Captured SDK metadata and ACP output: proxy/sessions/
  // 3282c3df-a569-4d46-9b35-358157805c69/log.jsonl, 2026-09-09T03:20:01.059Z,
  // under ~/.local/state/acp-llm-adapter. SDK 0.9 was emitted as usedPercent 0.9.
  it.each([0, 0.009, 0.9, 0.92, 1])(
    "converts stream utilization %s exactly once",
    (utilization) => {
      const snapshot = mergeClaudeRateLimitEvent(
        { buckets: [] },
        {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization,
          resetsAt: 1788937200,
        },
      );
      expect(snapshot.buckets[0].windows[0].usedPercent).toBeCloseTo(utilization * 100);
      const updated = mergeClaudeRateLimitEvent(snapshot, {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 1788937300,
      });
      expect(updated.buckets[0].windows[0].usedPercent).toBe(
        snapshot.buckets[0].windows[0].usedPercent,
      );
      expect(snapshot.buckets[0].windows[0].resetsAt).toBe(1788937200);
    },
  );

  it.each([-0.1, 1.01, 90, NaN, Infinity, null, "0.9"])(
    "rejects invalid stream utilization %s",
    (utilization) => {
      expect(() =>
        mergeClaudeRateLimitEvent(
          { buckets: [] },
          {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: utilization as number,
            resetsAt: 1788937200,
          },
        ),
      ).toThrow("invalid account-limit percentage");
    },
  );

  it("preserves sub-one percentages from the structured usage response", () => {
    const snapshot = normalizeClaudeAccountLimits({
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 0.9, resets_at: "2099-12-31T00:00:00.000Z" } },
    });
    expect(snapshot.buckets[0].windows[0].usedPercent).toBe(0.9);
  });

  it("requires the read request to be an empty object", () => {
    expect(parseAccountLimitsReadRequest({})).toEqual({});
    expect(() => parseAccountLimitsReadRequest([])).toThrow("must be an empty object");
    expect(() => parseAccountLimitsReadRequest({ sessionId: "session-1" })).toThrow(
      "must be an empty object",
    );
  });
});
