import { describe, expect, it } from "vitest";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

const key = "io.github.euri10.louiselm.sessionActivity";

describe("Session activity independent of prompt completion", () => {
  it.each([undefined, { version: 2 }, { version: 1 }])(
    "forwards native state only for a compatible subscriber: %j",
    async (capability) => {
      const updates: AcpSessionNotification[] = [];
      const agent = new ClaudeAcpAgent(
        {
          sessionUpdate: async (update) => {
            updates.push(update);
          },
        } as AcpClient,
        { log: () => {}, error: () => {} },
      );
      agent.clientCapabilities = {
        _meta: capability ? { [key]: capability } : {},
      } as ClientCapabilities;
      const input = new Pushable<any>();
      let wake!: () => void;
      const wakeup = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const state = (value: string, sessionId = "test-session") => ({
        type: "system",
        subtype: "session_state_changed",
        state: value,
        session_id: sessionId,
      });
      // Native wakeup state order captured with SDK 0.3.270 / CLI 2.1.270,
      // Session d860f6c9-e24e-406d-be16-5443f9b5303f, local simulated provider:
      // /tmp/louiselm-claude-wakeup.ft5NG0/native-probe3.log (louiselm-gmcod).
      // Prompt result -> idle -> scheduled running -> idle. requires_action,
      // foreign identity and future state below are additional synthetic cases.
      async function* messages() {
        const { value: prompt } = await input[Symbol.asyncIterator]().next();
        yield userEcho(prompt);
        yield state("running");
        yield successfulResultMessage();
        yield state("idle");
        await wakeup;
        yield state("running");
        yield state("requires_action");
        yield state("idle", "other-session");
        yield state("future-state");
        yield state("idle");
      }
      agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(messages()), input });
      const response = await agent.prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: "synthetic wakeup" }],
      });
      expect(response.stopReason).toBe("end_turn");
      wake();
      await agent.sessions["test-session"].consumer;
      const activity = updates.flatMap((update) => {
        const value = update.update._meta?.[key];
        return value ? [{ sessionId: update.sessionId, ...(value as object) }] : [];
      });
      expect(activity).toEqual(
        capability?.version === 1
          ? ["running", "idle", "running", "requires_action", "idle"].map((value) => ({
              sessionId: "test-session",
              version: 1,
              state: value,
            }))
          : [],
      );
    },
  );
});
