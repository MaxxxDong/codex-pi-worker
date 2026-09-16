// Pure retry guidance policy. No I/O, no process control.
// Guidance only: never blocks an explicit continue, gates dispatch, stops
// tool tasks, or kills processes. Counting uses only explicit native retry
// events/attempts; ordinary tool errors or string occurrences are never
// counted. Unknown stays null, never 0.
export const CONFIG_CATEGORIES = new Set([
  "authentication",
  "permission_denied",
  "request_rejected",
  "reasoning_ignored",
  "prompt_rejected",
]);

export const TRANSIENT_CATEGORIES = new Set([
  "transport",
  "rate_limit",
  "provider_5xx",
  "provider_retry",
  "provider_retry_failed",
]);

export function isConfigCategory(category) {
  return CONFIG_CATEGORIES.has(category);
}

export function isTransientCategory(category) {
  return TRANSIENT_CATEGORIES.has(category);
}

export function parseRetryAttempt(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  // Only field spellings already observed in this repo (claude describeApiRetry
  // uses attempt/retry_attempt/retryAttempt). No speculative new event names.
  const raw = event.attempt
    ?? event.retry_attempt
    ?? event.retryAttempt
    ?? null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 1) return null;
  return Math.floor(num);
}

export function nextRetryCount(current, attempt) {
  const base = Number.isFinite(current) && current >= 0 ? Math.floor(current) : 0;
  if (Number.isFinite(attempt) && attempt >= 1) return Math.max(base, Math.floor(attempt));
  return base + 1;
}

// Soft operational notes, not errors: they carry no retry advice (null) and
// must never be reported as an "unknown error".
export const SOFT_CATEGORIES = new Set([
  "startup_silent",
  "silent_reminder",
  "progress_stalled",
]);

export function isSoftCategory(category) {
  return SOFT_CATEGORIES.has(category);
}

export function buildRetryGuidance({ category = null, terminal = false, providerRetryCount = null } = {}) {
  if (category === null || category === undefined || category === "") return null;
  if (isSoftCategory(category)) return null;
  if (isConfigCategory(category)) {
    return {
      kind: "config",
      action: "fix_config",
      retryOwner: "host",
      message: "Do not retry verbatim; fix configuration/permission/parameters first, then continue with the same run-id.",
    };
  }
  if (isTransientCategory(category)) {
    if (!terminal) {
      return {
        kind: "transient_active",
        action: "wait_backend",
        retryOwner: "cli",
        message: "CLI native retry or transient provider error while the run is active; wait for the backend, do not dispatch a duplicate run.",
      };
    }
    return {
      kind: "transient_terminal",
      action: "review_retry_same_config",
      retryOwner: "host",
      message: "Transient provider/transport error at terminal state; review reason and partial output, then continue with the same config; do not switch model/endpoint by default.",
    };
  }
  return {
    kind: "unknown",
    action: "inspect",
    retryOwner: "host",
    message: "Unknown error; inspect reason and partial output; do not assume channel failure.",
  };
}
