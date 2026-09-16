import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { agyLaunchArgs, summarizeAgyStream } from "../lib/agy-backend.mjs";
import { summarizeClaudeStream } from "../lib/claude-backend.mjs";
import { createStderrScan, createStdoutScan } from "../lib/stream-scan.mjs";

function classifyAttention(value) {
  const text = String(value ?? "");
  if (/\b401\b|\b403\b|unauthorized/i.test(text)) return "authentication";
  if (/\b429\b|rate limit/i.test(text)) return "rate_limit";
  if (/\b500\b|internal server error/i.test(text)) return "provider_5xx";
  if (/connection error|fetch failed/i.test(text)) return "transport";
  return null;
}

function hooks() {
  const activities = [];
  const attentions = [];
  let settled = 0;
  return {
    activities,
    attentions,
    get settled() { return settled; },
    onActivity: (activity) => { activities.push(activity); },
    onAttention: (category, message) => { attentions.push({ category, message }); },
    onSettled: () => { settled += 1; },
    classifyAttention,
  };
}

test("claude stdout surfaces one non-JSON 401 line and ignores banner/blank lines", async () => {
  const seen = hooks();
  const stream = Readable.from([
    "pi-worker claude backend starting\n",
    "\n",
    "401 unauthorized: invalid api key\n",
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" })}\n`,
  ]);
  const summary = await summarizeClaudeStream(stream, seen);
  assert.deepEqual(seen.attentions.map((entry) => entry.category), ["authentication"]);
  assert.ok(seen.activities.some((activity) => activity.type === "backend_init"));
  assert.equal(summary.conversationId, "sess-1");
});

test("claude stdout callback errors propagate instead of being swallowed", async () => {
  const seen = hooks();
  seen.onActivity = () => { throw new Error("activity sink blew up"); };
  const stream = Readable.from([`${JSON.stringify({ type: "system", subtype: "init" })}\n`]);
  await assert.rejects(() => summarizeClaudeStream(stream, seen), /activity sink blew up/);
});

test("agy stdout flags repeated protocol corruption without spamming attention", async () => {
  const seen = hooks();
  const lines = ["garbage one", "garbage two", "garbage three", "garbage four", "garbage five", "garbage six"]
    .map((text) => `${text}\n`);
  lines.push(`${JSON.stringify({ event: "init", conversation_id: "agy-1" })}\n`);
  const summary = await summarizeAgyStream(Readable.from(lines), seen);
  assert.deepEqual(seen.attentions.map((entry) => entry.category), ["transport"]);
  assert.equal(summary.conversationId, "agy-1");
});

test("stderr scan joins split connection errors, dedupes repeats, stays bounded", async () => {
  const scan = createStderrScan({ classifyAttention, windowBytes: 64 });
  assert.equal(scan.push("Connec"), null);
  const first = scan.push("tion error.");
  assert.equal(first?.category, "transport");
  assert.match(first.detail, /Connection error/);
  assert.equal(scan.push("Connec"), null);
  assert.equal(scan.push("tion error."), null);
});

test("stderr pass-through without newline still notifies promptly", async () => {
  const attentions = [];
  const stderr = new PassThrough();
  let tail = "";
  const scan = createStderrScan({ classifyAttention });
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk) => {
    tail = (tail + chunk).slice(-1024);
    const hit = scan.push(chunk);
    if (hit) attentions.push(hit);
  });
  stderr.write("Connec");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attentions.length, 0);
  stderr.write("tion error.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attentions.length, 1);
  assert.equal(attentions[0].category, "transport");
  stderr.end("fetch failed");
  await new Promise((resolve) => stderr.on("end", resolve));
  assert.equal(attentions.length, 2);
  assert.equal(attentions[1].category, "transport");
  assert.ok(tail.length <= 1024);
});

test("stdout scan callback errors propagate", () => {
  const scan = createStdoutScan({
    classifyAttention: () => { throw new Error("classifier blew up"); },
  });
  assert.throws(() => scan.noteLine("not json"), /classifier blew up/);
});

test("normal banner lines never alert", () => {
  const scan = createStdoutScan({ classifyAttention });
  assert.equal(scan.noteLine(""), null);
  assert.equal(scan.noteLine("   "), null);
  assert.equal(scan.noteLine("pi-worker starting"), null);
});

test("stderr scan 401 then 429 continuous input does not shadow 429", () => {
  const scan = createStderrScan({ classifyAttention });
  const first = scan.push("HTTP 401 unauthorized: bad key\n");
  assert.equal(first?.category, "authentication");
  assert.match(first?.detail, /401 unauthorized/);
  const second = scan.push("HTTP 429 rate limit exceeded: try again later\n");
  assert.equal(second?.category, "rate_limit");
  assert.match(second?.detail, /429 rate limit/);
});

test("stderr scan joins split errors across chunks", () => {
  const scan = createStderrScan({ classifyAttention });
  assert.equal(scan.push("fatal: rate "), null);
  assert.equal(scan.push("li"), null);
  const hit = scan.push("mit reached");
  assert.equal(hit?.category, "rate_limit");
  assert.match(hit?.detail, /rate limit reached/);
});

test("stderr scan allows same category with different details without shadowing", () => {
  const scan = createStderrScan({ classifyAttention });
  const first = scan.push("401 unauthorized: key expired\n");
  assert.equal(first?.category, "authentication");
  const second = scan.push("401 unauthorized: token revoked\n");
  assert.equal(second?.category, "authentication");
  assert.match(second?.detail, /token revoked/);
  // Identical repeat of same detail is deduped
  assert.equal(scan.push("401 unauthorized: token revoked\n"), null);
});

test("createStdoutScan ignores 5+ lines of normal banners and info logs", () => {
  const scan = createStdoutScan({ classifyAttention });
  const banners = [
    "pi-worker claude backend starting",
    "[INFO] Initializing worker profile",
    "2026-09-05T14:39:36.000Z INFO starting listener",
    "=== Session Ready ===",
    "Loading extensions and tools...",
    "Ready to accept commands",
    "connected to provider endpoint",
    "listening on stdio",
  ];
  for (const line of banners) {
    assert.equal(scan.noteLine(line), null);
  }
});

test("createStdoutScan flags corrupted protocol JSON immediately", () => {
  const scan = createStdoutScan({ classifyAttention });
  const hit = scan.noteLine('{"event": "step_update", "incomplete": ');
  assert.equal(hit?.category, "transport");
  assert.match(hit?.detail, /corrupted JSON/i);
});

test("summarizeAgyStream rejects on null frame and array frame", async () => {
  const seenNull = hooks();
  await assert.rejects(
    () => summarizeAgyStream(Readable.from(["null\n"]), seenNull),
    /Corrupted protocol frame.*null/
  );

  const seenArray = hooks();
  await assert.rejects(
    () => summarizeAgyStream(Readable.from(["[1, 2, 3]\n"]), seenArray),
    /Corrupted protocol frame.*array/
  );
});

test("summarizeClaudeStream rejects on null frame and array frame", async () => {
  const seenNull = hooks();
  await assert.rejects(
    () => summarizeClaudeStream(Readable.from(["null\n"]), seenNull),
    /Corrupted protocol frame.*null/
  );

  const seenArray = hooks();
  await assert.rejects(
    () => summarizeClaudeStream(Readable.from(["[1, 2, 3]\n"]), seenArray),
    /Corrupted protocol frame.*array/
  );
});

test("summarizeAgyStream rejects on corrupted protocol JSON", async () => {
  const seen = hooks();
  const stream = Readable.from(['{"event": "step", broken syntax\n']);
  await assert.rejects(
    () => summarizeAgyStream(stream, seen),
    /Corrupted protocol JSON/
  );
});

test("summarizeClaudeStream rejects on corrupted protocol JSON", async () => {
  const seen = hooks();
  const stream = Readable.from(['{"type": "assistant", broken syntax\n']);
  await assert.rejects(
    () => summarizeClaudeStream(stream, seen),
    /Corrupted protocol JSON/
  );
});

test("agyLaunchArgs appends --add-dir workdir and preserves explicit dirs", () => {
  const argsWithoutAddDir = agyLaunchArgs({
    args: ["--verbose"],
    prompt: "do work",
    mode: { model: "gemini-3.8-flash-high", thinking: "high", readOnly: false },
    hardTimeoutSeconds: 60,
    workdir: "/workspace/project",
  });
  assert.ok(argsWithoutAddDir.includes("--add-dir"));
  assert.equal(argsWithoutAddDir[argsWithoutAddDir.indexOf("--add-dir") + 1], "/workspace/project");
  assert.equal(argsWithoutAddDir.includes("--dangerously-skip-permissions"), false);

  const argsWithExplicit = agyLaunchArgs({
    args: ["--add-dir", "/explicit/dir"],
    prompt: "do work",
    mode: { model: "gemini-3.8-flash-high", thinking: "high", readOnly: false },
    hardTimeoutSeconds: 60,
    workdir: "/workspace/project",
  });
  const addDirs = [];
  argsWithExplicit.forEach((arg, i) => {
    if (arg === "--add-dir") addDirs.push(argsWithExplicit[i + 1]);
  });
  assert.deepEqual(addDirs, ["/explicit/dir", "/workspace/project"]);

  const argsAlreadyHasWorkdir = agyLaunchArgs({
    args: ["--add-dir", "/workspace/project"],
    prompt: "do work",
    mode: { model: "gemini-3.8-flash-high", thinking: "high", readOnly: false },
    hardTimeoutSeconds: 60,
    workdir: "/workspace/project",
  });
  const addDirsSingle = [];
  argsAlreadyHasWorkdir.forEach((arg, i) => {
    if (arg === "--add-dir") addDirsSingle.push(argsAlreadyHasWorkdir[i + 1]);
  });
  assert.deepEqual(addDirsSingle, ["/workspace/project"]);
});
