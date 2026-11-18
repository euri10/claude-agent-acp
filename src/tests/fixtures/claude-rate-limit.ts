// Rate-limit metadata captured at 2026-09-09T02:02:35.736Z in
// ~/.local/state/acp-llm-adapter/proxy/sessions/
// 3282c3df-a569-4d46-9b35-358157805c69/log.jsonl.
// Quota fields only; no account identity, prompts, or credentials.
export const unifiedRateLimit = {
  status: "allowed",
  resetsAt: 1788937200,
  rateLimitType: "five_hour",
  unifiedWindows: {
    five_hour: { utilization: 0.01, resetsAt: 1788937200 },
    seven_day: { utilization: 0.36, resetsAt: 1789005600 },
  },
} as const;
