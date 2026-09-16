import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const events = join(root, "lib/events.mjs");

function command(args, env, allowFailure = false) {
  const result = spawnSync(process.execPath, [events, ...args], { encoding: "utf8", env });
  if (!allowFailure && (result.status !== 0 || result.signal)) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `command failed: status=${result.status} signal=${result.signal}`;
    const error = new Error(detail);
    error.status = result.status;
    error.signal = result.signal;
    throw error;
  }
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

// Attention interrupts every wait (exit 4). Drain until the run reaches a
// terminal state, collecting receipts as they appear.
function drainUntilTerminal(ids, env) {
  const byId = new Map();
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const waited = command(["wait", "--full", ...ids.flatMap((id) => ["--run-id", id]), "--timeout", "10"], env, true);
    const list = waited.json?.results ?? [];
    for (const result of list) byId.set(result.runId, result);
    if (ids.every((id) => byId.has(id))) break;
    const pending = waited.json?.pending ?? [];
    if (waited.status !== 0 && waited.json?.state !== "attention") break;
    if (waited.status === 0 && pending.length === 0) break;
  }
  return byId;
}

function testEnv(temporary, launcher) {
  const caches = [join(temporary, ".npm"), join(temporary, ".cache", "uv")];
  caches.forEach((path) => mkdirSync(path, { recursive: true }));
  const agent = join(temporary, "agent-source");
  mkdirSync(join(agent, "npm"), { recursive: true });
  for (const name of ["auth.json", "models.json", "models-store.json", "settings.json"]) {
    writeFileSync(join(agent, name), "{}\n");
  }
  const baseEnv = { ...process.env };
  delete baseEnv.CODEX_THREAD_ID;
  return {
    ...baseEnv,
    SUBWORKER_STATE_ROOT: join(temporary, "state"),
    PI_WORKER_STATE_ROOT: join(temporary, "state"),
    SUBWORKER_LAUNCHER: launcher,
    PI_WORKER_LAUNCHER: launcher,
    SUBWORKER_AGENT_SOURCE: agent,
    PI_WORKER_AGENT_SOURCE: agent,
    PI_WORKER_TEST_CACHE_ROOTS: caches.join(delimiter),
    PI_WORKER_CACHE_MAX_BYTES: String(1024 * 1024),
  };
}

function fakeLauncher(temporary, body) {
  const path = join(temporary, `fake-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

const successEvents = `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:"DONE"}],usage:{input:1,output:1}}}));
console.log(JSON.stringify({type:"agent_settled"}));`;

function gitSource(temporary) {
  const source = join(temporary, "source");
  mkdirSync(source);
  execFileSync("git", ["-C", source, "init", "-q"]);
  execFileSync("git", ["-C", source, "config", "user.email", "pi-worker@test.invalid"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Pi Worker Test"]);
  writeFileSync(join(source, "base.txt"), "base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  return source;
}

function storedResult(env, runId) {
  return JSON.parse(readFileSync(join(env.PI_WORKER_STATE_ROOT, runId, "result.json"), "utf8"));
}

function assertStalled(detail) {
  assert.match(detail, /No tool start or finish observed for [\d.]+ seconds since .*the worker is still running without observable tool progress/);
}

test("model chunks keep arriving but no tool boundary raises one progress_stalled and the run succeeds", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-stall-"));
  const source = gitSource(temporary);
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_update",phase:"thinking",content:[{type:"thinking",thinking:"step one"}]}));
for (let index = 0; index < 4; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log(JSON.stringify({type:"message_update",phase:"chunk",content:[{type:"text",text:"chunk " + index}]}));
}
await new Promise((resolve) => setTimeout(resolve, 200));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "stall", "--mode", "write", "--source", source, "--startup-attention", "0", "--progress-reminder", "0.15", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const terminal = drainUntilTerminal(["stall"], env).get("stall");
    assert.equal(terminal.state, "success");
    assert.equal(terminal.progressReminderSeconds, 0.15);
    const stored = storedResult(env, "stall");
    const stalls = stored.attentions.filter((entry) => entry.category === "progress_stalled");
    assert.equal(stalls.length, 1, `expected exactly one stalled alert, got ${stalls.length}`);
    assertStalled(stalls[0].detail);
    assert.equal(stored.attention.category, "progress_stalled");
    command(["cleanup", "--reviewed", "yes", "--run-id", "stall"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an active long tool never raises progress_stalled even when model output continues inside it", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-tool-active-"));
  const source = gitSource(temporary);
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"bash",args:{command:"sleep 2"}}));
for (let index = 0; index < 5; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log(JSON.stringify({type:"message_update",phase:"chunk",content:[{type:"text",text:"still inside tool " + index}]}));
}
console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"t1",toolName:"bash",isError:false}));
await new Promise((resolve) => setTimeout(resolve, 100));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "tool-active", "--mode", "write", "--source", source, "--startup-attention", "0", "--progress-reminder", "0.2", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const terminal = drainUntilTerminal(["tool-active"], env).get("tool-active");
    assert.equal(terminal.state, "success");
    const stored = storedResult(env, "tool-active");
    assert.equal(stored.attentions.filter((entry) => entry.category === "progress_stalled").length, 0);
    command(["cleanup", "--reviewed", "yes", "--run-id", "tool-active"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("tool activity resets the span: only the final quiet phase raises once", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-tool-reset-"));
  const source = gitSource(temporary);
  const fake = fakeLauncher(temporary, `
await new Promise((resolve) => setTimeout(resolve, 150));
console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"read",args:{path:"base.txt"}}));
console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"t1",toolName:"read",isError:false}));
for (let index = 0; index < 4; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log(JSON.stringify({type:"message_update",phase:"chunk",content:[{type:"text",text:"chunk " + index}]}));
}
await new Promise((resolve) => setTimeout(resolve, 150));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "tool-reset", "--mode", "write", "--source", source, "--startup-attention", "0", "--progress-reminder", "0.15", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const terminal = drainUntilTerminal(["tool-reset"], env).get("tool-reset");
    assert.equal(terminal.state, "success");
    const stored = storedResult(env, "tool-reset");
    // The tool boundary closes the pre-tool window and the post-tool phase is
    // one continuous no-tool span, so exactly one stalled alert may appear.
    const stalls = stored.attentions.filter((entry) => entry.category === "progress_stalled");
    assert.equal(stalls.length, 1, `expected one stalled alert after the tool, got ${stalls.length}`);
    command(["cleanup", "--reviewed", "yes", "--run-id", "tool-reset"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("defaults persist: write 600, read 0, explicit zero disables", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-stall-off-"));
  const quickFake = fakeLauncher(temporary, `
await new Promise((resolve) => setTimeout(resolve, 250));
${successEvents}`);
  const env = testEnv(temporary, quickFake);
  const source = gitSource(temporary);
  try {
    // No --progress-reminder flag anywhere; only the mode differs.
    command(["dispatch", "--run-id", "cfg-read", "--mode", "read", "--workdir", temporary, "--startup-attention", "0", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    command(["dispatch", "--run-id", "cfg-default", "--mode", "write", "--source", source, "--startup-attention", "0", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    // Write mode with an explicit zero: progress reminders stay disabled.
    // Both write runs share one source repo; each dispatch creates its own
    // independent managed worktree from it.
    command(["dispatch", "--run-id", "cfg-off", "--mode", "write", "--source", source, "--startup-attention", "0", "--progress-reminder", "0", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const terminal = drainUntilTerminal(["cfg-read", "cfg-default", "cfg-off"], env);
    const expectations = new Map([
      ["cfg-read", 0],
      ["cfg-default", 600],
      ["cfg-off", 0],
    ]);
    for (const [runId, expected] of expectations) {
      const result = terminal.get(runId);
      assert.equal(result.state, "success");
      assert.equal(result.progressReminderSeconds, expected, `${runId} terminal receipt`);
      const stored = storedResult(env, runId);
      assert.equal(stored.progressReminderSeconds, expected, `${runId} persisted config`);
      assert.equal(stored.attentions.filter((entry) => entry.category === "progress_stalled").length, 0);
      command(["cleanup", "--reviewed", "yes", "--run-id", runId], env);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("continue keeps the stored threshold unless overridden and rejects negatives", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-stall-continue-"));
  const fake = fakeLauncher(temporary, `
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
mkdirSync(sessionDir, {recursive:true});
const marker = join(sessionDir, "marker");
const continuing = args.includes("--continue");
writeFileSync(marker, "saved");
if (continuing) {
  // One pre-window chunk opens the span, then a silent gap longer than the
  // threshold (owned by silent_reminder), then steady model chunks: the
  // resumed output must still produce exactly one stalled alert.
  console.log(JSON.stringify({type:"message_update",phase:"chunk",content:[{type:"text",text:"pre"}]}));
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    console.log(JSON.stringify({type:"message_update",phase:"chunk",content:[{type:"text",text:"continue chunk " + index}]}));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:continuing ? "CONTINUED" : "FIRST"}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    // Dispatch --silent-reminder 0: only progress_reminder can alert this turn.
    command(["dispatch", "--run-id", "stall-continue", "--workdir", temporary, "--startup-attention", "0", "--silent-reminder", "0", "--progress-reminder", "0.15", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "first"], env);
    const first = command(["wait", "--full", "--run-id", "stall-continue", "--timeout", "10"], env).json.results[0];
    assert.equal(first.state, "success");
    assert.equal(first.progressReminderSeconds, 0.15);
    assert.ok(first.elapsedSeconds >= 0, "first turn reports its own elapsedSeconds");
    const negative = command(["continue", "--run-id", "stall-continue", "--progress-reminder", "-1", "--", "second"], env, true);
    assert.equal(negative.status, 2);
    assert.match(negative.stderr, /--progress-reminder must be zero or positive/);
    const rejected = command(["wait", "--full", "--run-id", "stall-continue", "--timeout", "10"], env, true);
    assert.equal(rejected.status, 0);
    assert.equal(rejected.json.results[0].state, "success");
    command(["continue", "--run-id", "stall-continue", "--progress-reminder", "0.1", "--", "second"], env);
    // The continuation must start its own turn clock, not carry the finished
    // turn's elapsedSeconds (a stale value would persist through the new turn).
    const running = JSON.parse(readFileSync(join(env.PI_WORKER_STATE_ROOT, "stall-continue", "result.json"), "utf8"));
    assert.equal(running.state, "starting");
    assert.equal(running.turnIndex, 2);
    assert.equal(running.elapsedSeconds, null, "continue resets elapsedSeconds for the new turn");
    const second = drainUntilTerminal(["stall-continue"], env).get("stall-continue");
    assert.equal(second.state, "success");
    assert.equal(second.turnIndex, 2);
    assert.equal(second.progressReminderSeconds, 0.1);
    assert.ok(second.elapsedSeconds < first.elapsedSeconds + 30, "second turn does not inherit the first turn's elapsedSeconds");
    const stored = storedResult(env, "stall-continue");
    assert.equal(stored.progressReminderSeconds, 0.1);
    assert.deepEqual(stored.attentions.map((entry) => entry.category), ["progress_stalled"]);
    const stalls = stored.attentions.filter((entry) => entry.category === "progress_stalled");
    assert.equal(stalls.length, 1, `expected one stalled alert on the continued turn, got ${stalls.length}`);
    assertStalled(stalls[0].detail);
    command(["cleanup", "--reviewed", "yes", "--run-id", "stall-continue"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("after a silent gap owned by silent_reminder, resumed chunks reopen the progress window once", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-stall-recover-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_update",phase:"chunk",content:[{type:"text",text:"wake"}]}));
await new Promise((resolve) => setTimeout(resolve, 800));
// Post-gap chunks stay well under the silent threshold (120 ms cadence vs
// 0.3 s silent interval) so no second silent span opens; the only
// silent_reminder belongs to the intended 800 ms gap. The quiet tail is also
// shorter than the silent interval.
for (let index = 0; index < 7; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log(JSON.stringify({type:"message_update",phase:"chunk",content:[{type:"text",text:"recovered chunk " + index}]}));
}
await new Promise((resolve) => setTimeout(resolve, 120));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    // silent_reminder (0.3) fires inside the silent gap and owns that stretch;
    // progress_reminder (0.6, longer) is suppressed there and closes its span.
    // The resumed model chunks then reopen a fresh progress window, which
    // raises exactly one stalled alert.
    command(["dispatch", "--run-id", "stall-recover", "--workdir", temporary, "--startup-attention", "0", "--silent-reminder", "0.3", "--progress-reminder", "0.6", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    const terminal = drainUntilTerminal(["stall-recover"], env).get("stall-recover");
    assert.equal(terminal.state, "success");
    const stored = storedResult(env, "stall-recover");
    const categories = stored.attentions.map((entry) => entry.category);
    const stalls = stored.attentions.filter((entry) => entry.category === "progress_stalled");
    assert.equal(stalls.length, 1, `expected one stalled alert after the silent gap, got ${stalls.length}`);
    assertStalled(stalls[0].detail);
    assert.equal(categories.filter((entry) => entry === "silent_reminder").length, 1, "silent gap raised its own single reminder");
    assert.equal(stored.attention.category, "progress_stalled");
    command(["cleanup", "--reviewed", "yes", "--run-id", "stall-recover"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cancel clears the stall timer and the cancelled run records no alert", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-stall-cancel-"));
  const source = gitSource(temporary);
  const fake = fakeLauncher(temporary, `
process.on("SIGTERM", () => process.exit(0));
for (let index = 0; index < 6; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log(JSON.stringify({type:"message_update",phase:"chunk",content:[{type:"text",text:"chunk " + index}]}));
}
await new Promise((resolve) => setTimeout(resolve, 5000));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "stall-cancel", "--mode", "write", "--source", source, "--startup-attention", "0", "--progress-reminder", "0.3", "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "task"], env);
    // Wait until the run is demonstrably streaming chunks (so the timer is
    // armed and would otherwise fire), then cancel before the threshold.
    const resultPath = join(env.PI_WORKER_STATE_ROOT, "stall-cancel", "result.json");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const current = JSON.parse(readFileSync(resultPath, "utf8"));
      if (current.lastEventType === "message_update" && current.state === "running") break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    const response = command(["cancel", "--run-id", "stall-cancel", "--reason", "scope withdrawn", "--timeout", "10"], env).json;
    assert.equal(response.state, "cancelled");
    const stored = storedResult(env, "stall-cancel");
    assert.equal(stored.progressReminderSeconds, 0.3);
    assert.equal(stored.attentions.filter((entry) => entry.category === "progress_stalled").length, 0);
    command(["cleanup", "--reviewed", "yes", "--run-id", "stall-cancel"], env);
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "stall-cancel")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
