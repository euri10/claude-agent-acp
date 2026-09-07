import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  ACCOUNT_LIMITS_META_KEY,
  ACCOUNT_LIMITS_READ_METHOD,
  ACCOUNT_LIMITS_UPDATED_METHOD,
} from "../account-limits-extension.js";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

const usageResponse = {
  subscription_type: "pro",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 70, resets_at: "2099-12-31T00:00:00.000Z" },
    seven_day: { utilization: 30, resets_at: "2100-01-01T00:00:00.000Z" },
  },
};

function mockClient(extNotifications: { method: string; params: Record<string, unknown> }[] = []) {
  return {
    sessionUpdate: async (_notification: SessionNotification) => {},
    extNotification: async (method: string, params: Record<string, unknown>) => {
      extNotifications.push({ method, params });
    },
  } as unknown as AcpClient;
}

describe("Claude account limits ACP integration", () => {
  it("advertises the provider-neutral account-limits capability", async () => {
    const agent = new ClaudeAcpAgent(mockClient(), { log: () => {}, error: () => {} });

    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    expect(response.agentCapabilities?._meta?.[ACCOUNT_LIMITS_META_KEY]).toEqual({
      accountLimits: {
        version: 1,
        readMethod: ACCOUNT_LIMITS_READ_METHOD,
        updatedMethod: ACCOUNT_LIMITS_UPDATED_METHOD,
      },
    });
  });

  it("reads limits through an existing live Session query", async () => {
    const usage = vi.fn(async () => usageResponse);
    const agent = new ClaudeAcpAgent(mockClient(), { log: () => {}, error: () => {} });
    agent.sessions["closed"] = mockSessionState({
      queryClosed: true,
      query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn() },
    });
    agent.sessions["live"] = mockSessionState({
      query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage },
    });

    await expect(agent.readAccountLimits({})).resolves.toMatchObject({
      defaultBucketId: "claude",
      buckets: [{ id: "claude" }],
    });
    expect(usage).toHaveBeenCalledOnce();
  });

  it("logs safe usage response metadata", async () => {
    const logs: string[] = [];
    const agent = new ClaudeAcpAgent(mockClient(), {
      log: (...args) => logs.push(args.join(" ")),
      error: () => {},
    });
    agent.sessions.live = mockSessionState({
      query: {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({
          subscription_type: "pro",
          rate_limits_available: true,
          rate_limits: null,
        })),
      },
    });

    await agent.readAccountLimits({});

    expect(logs).toEqual([
      "[account-limits] subscription_type=pro rate_limits_available=true rate_limits=null rate_limit_keys=none",
    ]);
  });

  it("fails without creating a Session when no live query exists", async () => {
    const agent = new ClaudeAcpAgent(mockClient(), { log: () => {}, error: () => {} });

    await expect(agent.readAccountLimits({})).rejects.toThrow("requires a live Claude session");
    expect(agent.sessions).toEqual({});
  });

  it("preserves an SDK read failure as a request failure", async () => {
    const agent = new ClaudeAcpAgent(mockClient(), { log: () => {}, error: () => {} });
    agent.sessions["live"] = mockSessionState({
      query: {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => {
          throw new Error("usage control request failed");
        }),
      },
    });

    await expect(agent.readAccountLimits({})).rejects.toThrow("usage control request failed");
  });

  it("does not retain account capacity across an authentication change", async () => {
    const usage = vi.fn().mockResolvedValueOnce(usageResponse).mockResolvedValueOnce({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    });
    const agent = new ClaudeAcpAgent(mockClient(), { log: () => {}, error: () => {} });
    agent.sessions["live"] = mockSessionState({
      query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage },
    });
    await expect(agent.readAccountLimits({})).resolves.toMatchObject({
      buckets: [{ id: "claude" }],
    });

    await agent.authenticate({ methodId: "gateway" } as any);

    await expect(agent.readAccountLimits({})).resolves.toEqual({ buckets: [] });
  });

  it("publishes an observed snapshot when a pre-read event is complete", async () => {
    const notifications: { method: string; params: Record<string, unknown> }[] = [];
    const agent = new ClaudeAcpAgent(mockClient(notifications), {
      log: () => {},
      error: () => {},
    });
    const input = new Pushable<any>();

    async function* messages() {
      const iterator = input[Symbol.asyncIterator]();
      const { value: userMessage } = await iterator.next();
      yield userEcho(userMessage);
      yield successfulResultMessage();
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 85,
          resetsAt: 4102358500,
        },
        uuid: "rate-limit-event",
        session_id: "test-session",
      };
    }

    agent.sessions["test-session"] = mockSessionState({
      query: Object.assign(wrapQuery(messages()), {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
        })),
      }),
      input,
    });

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "continue" }],
    });
    await agent.sessions["test-session"]?.consumer;

    expect(notifications).toEqual([
      {
        method: ACCOUNT_LIMITS_UPDATED_METHOD,
        params: {
          defaultBucketId: "claude",
          buckets: [
            {
              id: "claude",
              label: "Claude",
              windows: [{ usedPercent: 85, windowDurationMins: 300, resetsAt: 4102358500 }],
            },
          ],
        },
      },
    ]);
    agent.sessions["live-read"] = mockSessionState({
      query: {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
        })),
      },
    });
    await expect(agent.readAccountLimits({})).resolves.toEqual(notifications[0].params);
  });

  it("publishes a complete snapshot after a structured rolling event", async () => {
    const notifications: { method: string; params: Record<string, unknown> }[] = [];
    const agent = new ClaudeAcpAgent(mockClient(notifications), {
      log: () => {},
      error: () => {},
    });
    const input = new Pushable<any>();

    async function* messages() {
      const iterator = input[Symbol.asyncIterator]();
      const { value: userMessage } = await iterator.next();
      yield userEcho(userMessage);
      yield successfulResultMessage();
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 85,
          resetsAt: 4102358500,
        },
        uuid: "rate-limit-event",
        session_id: "test-session",
      };
    }

    const query = Object.assign(wrapQuery(messages()), {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => usageResponse),
    });
    agent.sessions["test-session"] = mockSessionState({ query, input });
    await agent.readAccountLimits({});

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "continue" }],
    });
    await agent.sessions["test-session"]?.consumer;

    expect(notifications).toEqual([
      {
        method: ACCOUNT_LIMITS_UPDATED_METHOD,
        params: {
          defaultBucketId: "claude",
          buckets: [
            {
              id: "claude",
              label: "Claude",
              planType: "pro",
              windows: [
                { usedPercent: 85, windowDurationMins: 300, resetsAt: 4102358500 },
                { usedPercent: 30, windowDurationMins: 10080, resetsAt: 4102444800 },
              ],
            },
          ],
        },
      },
    ]);
  });
});
