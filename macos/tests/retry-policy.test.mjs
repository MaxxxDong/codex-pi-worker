import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  buildRetryGuidance,
  nextRetryCount,
  parseRetryAttempt,
} from "../lib/retry-policy.mjs";
import { summarizeClaudeStream } from "../lib/claude-backend.mjs";

function streamOf(lines) {
  return Readable.from(lines.map((line) => `${JSON.stringify(line)}\n`));
}

function hooks() {
  const attentions = [];
  return {
    attentions,
    onActivity: () => {},
    onAttention: (category, message) => { attentions.push({ category, message }); },
    onSettled: () => {},
    classifyAttention: () => null,
  };
}

test("parseRetryAttempt accepts explicit attempt fields and rejects garbage", () => {
  assert.equal(parseRetryAttempt({ attempt: 3 }), 3);
  assert.equal(parseRetryAttempt({ retry_attempt: "2" }), 2);
  assert.equal(parseRetryAttempt({ retryAttempt: 2.9 }), 2);
  assert.equal(parseRetryAttempt({}), null);
  assert.equal(parseRetryAttempt(null), null);
  assert.equal(parseRetryAttempt([1]), null);
  assert.equal(parseRetryAttempt({ attempt: 0 }), null);
  assert.equal(parseRetryAttempt({ attempt: "later" }), null);
  assert.equal(parseRetryAttempt({ attempt: "" }), null);
});

test("nextRetryCount starts null and follows explicit attempts", () => {
  assert.equal(nextRetryCount(null, 3), 3);
  assert.equal(nextRetryCount(null, null), 1);
  assert.equal(nextRetryCount(2, 5), 5);
  assert.equal(nextRetryCount(5, 2), 5);
  assert.equal(nextRetryCount(1, null), 2);
});

test("config categories demand fix-first, never verbatim retry", () => {
  for (const category of ["authentication", "permission_denied", "request_rejected", "reasoning_ignored", "prompt_rejected"]) {
    const guidance = buildRetryGuidance({ category, terminal: false });
    assert.equal(guidance.kind, "config");
    assert.equal(guidance.action, "fix_config");
    assert.equal(guidance.retryOwner, "host");
    assert.match(guidance.message, /Do not retry verbatim/);
  }
});

test("active transient retries advise waiting, terminal advises same-config review", () => {
  for (const category of ["transport", "rate_limit", "provider_5xx", "provider_retry", "provider_retry_failed"]) {
    const active = buildRetryGuidance({ category, terminal: false });
    assert.equal(active.kind, "transient_active");
    assert.equal(active.action, "wait_backend");
    assert.equal(active.retryOwner, "cli");
    assert.match(active.message, /do not dispatch a duplicate run/i);
    const terminal = buildRetryGuidance({ category, terminal: true });
    assert.equal(terminal.kind, "transient_terminal");
    assert.equal(terminal.action, "review_retry_same_config");
    assert.equal(terminal.retryOwner, "host");
    assert.match(terminal.message, /do not switch model/i);
  }
});

test("unknown errors advise inspection without claiming channel failure", () => {
  for (const category of ["repeated_tool_errors", "extension_error", "compaction_error"]) {
    const guidance = buildRetryGuidance({ category, terminal: true });
    assert.equal(guidance.kind, "unknown");
    assert.equal(guidance.action, "inspect");
    assert.equal(guidance.retryOwner, "host");
    assert.match(guidance.message, /do not assume channel failure/i);
  }
});

test("absent and soft categories carry no guidance, never unknown-error", () => {
  for (const category of [null, undefined, "", "startup_silent", "silent_reminder", "progress_stalled"]) {
    assert.equal(buildRetryGuidance({ category, terminal: false }), null);
    assert.equal(buildRetryGuidance({ category, terminal: true }), null);
  }
});

test("first Claude api_retry event counts as one with reported attempt", async () => {
  const seen = hooks();
  const summary = await summarizeClaudeStream(streamOf([
    { type: "system", subtype: "api_retry", attempt: 1, error: "529 overloaded, retrying", status: 529 },
  ]), seen);
  assert.equal(summary.providerRetryCount, 1);
  assert.deepEqual(seen.attentions.map((entry) => entry.category), ["provider_retry"]);
});

test("Claude api_retry without attempt still counts once, never fabricates", async () => {
  const seen = hooks();
  const summary = await summarizeClaudeStream(streamOf([
    { type: "system", subtype: "api_retry", error: "connection reset, retrying" },
  ]), seen);
  assert.equal(summary.providerRetryCount, 1);
});

test("ordinary tool errors never count as provider retries", async () => {
  const seen = hooks();
  const summary = await summarizeClaudeStream(streamOf([
    { type: "assistant", message: { model: "m", content: [{ type: "tool_use", id: "t-1", name: "Bash", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t-1", content: "attempt 3 failed: boom", is_error: true }] } },
    { type: "assistant", message: { model: "m", content: [{ type: "tool_use", id: "t-2", name: "Bash", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t-2", content: "attempt 4 failed: boom", is_error: true }] } },
  ]), seen);
  assert.equal(summary.providerRetryCount, null);
  assert.deepEqual(seen.attentions, []);
});
