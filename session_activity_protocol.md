# Session activity (version 1)

The optional `io.github.euri10.louiselm.sessionActivity` capability distinguishes
root-Session processing from a client `session/prompt` request. A scheduled wakeup
can start processing after that request has completed.

The Agent advertises `{ "version": 1 }` under this key in
`initialize.agentCapabilities._meta`. A client opts in with the same entry in
`initialize.clientCapabilities._meta`. No state is emitted for absent or
unsupported client versions.

SDK `system/session_state_changed` events for the current Session become:

```json
{
  "sessionId": "current ACP Session id",
  "update": {
    "sessionUpdate": "session_info_update",
    "_meta": {
      "io.github.euri10.louiselm.sessionActivity": {
        "version": 1,
        "state": "running"
      }
    }
  }
}
```

`state` is `running`, `idle`, or `requires_action`. These are ordered native
activity signals, including activity outside a pending prompt. They contain no
prompt or tool payload. Other Session IDs and unknown native states are not
published. Historical transcript replay does not synthesize activity.

Prompt responses keep their existing meaning and timing. Clients must not resolve
pending prompts from `idle`, infer idleness from a tool result, or manufacture a
second user prompt for a wakeup. `requires_action` does not replace permission
requests. Sending `session/cancel` is a request to stop, not an idle acknowledgment.
