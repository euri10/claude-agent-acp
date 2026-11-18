import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const SESSION_ACTIVITY_META_KEY = "io.github.euri10.louiselm.sessionActivity";

/** Forward only negotiated root-session native activity, including scheduled wakeups. */
export function sessionActivityUpdate(capability: unknown, sessionId: string, message: SDKMessage) {
  if (
    capability &&
    typeof capability === "object" &&
    "version" in capability &&
    capability.version === 1 &&
    message.type === "system" &&
    message.subtype === "session_state_changed" &&
    message.session_id === sessionId &&
    (message.state === "running" || message.state === "idle" || message.state === "requires_action")
  ) {
    return {
      sessionUpdate: "session_info_update" as const,
      _meta: { [SESSION_ACTIVITY_META_KEY]: { version: 1, state: message.state } },
    };
  }
}
