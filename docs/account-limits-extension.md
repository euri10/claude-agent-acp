# Account limits extension

This experimental ACP extension exposes account-level capacity without parsing `/usage` or
`/status` text. Account limits belong to the authenticated provider account, not an ACP Session.
The Claude adapter uses the structured experimental usage control API in the Claude Agent SDK;
provider-specific instability stays behind this adapter boundary.

## Capability negotiation

The agent advertises version 1 under `agentCapabilities._meta` in its `initialize` response:

```json
{
  "agentCapabilities": {
    "_meta": {
      "io.github.euri10.louiselm": {
        "accountLimits": {
          "version": 1,
          "readMethod": "_io.github.euri10.louiselm/account_limits/read",
          "updatedMethod": "_io.github.euri10.louiselm/account_limits/updated"
        }
      }
    }
  }
}
```

Both custom methods follow ACP's underscore-prefix rule. Clients that do not recognize the
capability can ignore it and its notifications.

## Complete snapshot

The read request takes an empty object. It uses any existing live Claude Session and never starts
a Session solely to inspect capacity. Its response and every update notification use the same
complete shape:

```json
{
  "defaultBucketId": "claude",
  "buckets": [
    {
      "id": "claude",
      "label": "Claude",
      "windows": [
        {
          "usedPercent": 82,
          "windowDurationMins": 300,
          "resetsAt": 4102444800
        }
      ],
      "planType": "max"
    }
  ]
}
```

`buckets` is always present. Every window contains its exact duration, Unix reset timestamp in
seconds, and consumed percentage. The default Claude bucket carries the five-hour and general
seven-day windows. Provider-named weekly model windows become additional buckets. Enabled extra
usage becomes a credit bucket when the SDK supplies enough information to calculate its remaining
balance; its currency is included in the label when available.

Optional fields are omitted when unavailable rather than represented by invented defaults. A
successful response with `buckets: []` means the SDK reports that subscription limits do not apply
or provided no complete windows. Once structured response events have supplied windows, an empty
pull result does not erase them; read returns the adapter's last observed snapshot. A request
failure remains a distinct outcome.

## Rolling updates

The SDK's `rate_limit_event` describes one limit window, not the whole account. The adapter
accumulates fully specified events into its last known snapshot and publishes the complete
normalized state known to the adapter rather than forwarding a patch. This also provides a useful
fallback when Claude's usage endpoint reports that pull-based plan limits are unavailable but model
responses still carry structured utilization headers. An event cannot create a window unless it
contains both utilization and reset time; later sparse events may update an already observed
window. Rejected events additionally mark the affected bucket as reached.

Stream `utilization` is a fraction from 0 through 1: `0.92` becomes `usedPercent: 92`.
The structured usage control response already expresses utilization from 0 through 100,
so `0.92` there remains 0.92 percent. Conversion happens only on incoming stream values;
sparse events retain previously normalized percentages without converting them again.
