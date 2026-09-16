import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const events = join(root, "lib/events.mjs");

function command(args, env, allowFailure = false) {
  const result = spawnSync(process.execPath, [events, ...args], { encoding: "utf8", env });
  if (!allowFailure && (result.status !== 0 || result.signal)) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `command failed: status=${result.status}`);
  }
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

function testEnv(temporary, launcher) {
  const caches = [join(temporary, ".npm"), join(temporary, ".cache", "uv")];
  caches.forEach((path) => mkdirSync(path, { recursive: true }));
  const agent = join(temporary, "agent-source");
  mkdirSync(join(agent, "npm"), { recursive: true });
  for (const name of ["auth.json", "models.json", "models-store.json", "settings.json"]) {
    writeFileSync(join(agent, name), "{}\n");
  }
  // Strip inherited runtime env first so fixtures never touch real state,
  // launcher, or cache roots.
  const baseEnv = { ...process.env };
  for (const name of Object.keys(baseEnv)) {
    if (name === "SUBWORKER_STATE_ROOT" || name.startsWith("SUBWORKER_") || name.startsWith("PI_WORKER_")) delete baseEnv[name];
  }
  delete baseEnv.CODEX_THREAD_ID;
  return {
    ...baseEnv,
    SUBWORKER_STATE_ROOT: join(temporary, "state"),
    SUBWORKER_LAUNCHER: launcher,
    SUBWORKER_AGENT_SOURCE: agent,
    SUBWORKER_TEST_CACHE_ROOTS: caches.join(delimiter),
    SUBWORKER_CACHE_MAX_BYTES: String(1024 * 1024),
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

test("first native retry alert carries wait-backend guidance; success clears advice", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-retry-guidance-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"auto_retry_start",attempt:1}));
await new Promise((resolve) => setTimeout(resolve, 500));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "retry-ok", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const alert = command(["wait", "--full", "--run-id", "retry-ok", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    assert.equal(alert.json.alerts[0].category, "provider_retry");
    assert.equal(alert.json.alerts[0].retryGuidance?.action, "wait_backend");
    // Top-level diagnose view mirrors the same advice during the run.
    const mid = JSON.parse(readFileSync(join(env.SUBWORKER_STATE_ROOT, "retry-ok", "result.json"), "utf8"));
    assert.equal(mid.retryGuidance?.action, "wait_backend");
    const terminal = command(["wait", "--full", "--run-id", "retry-ok", "--timeout", "10"], env).json;
    assert.equal(terminal.results[0].state, "success");
    assert.equal(terminal.results[0].retryGuidance, null);
    assert.equal(terminal.results[0].providerRetryCount, 1);
    command(["cleanup", "--reviewed", "yes", "--run-id", "retry-ok"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("failed transient run advises same-config review after inspection", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-retry-failed-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"auto_retry_start",attempt:2}));
process.stderr.write("HTTP 503 service unavailable\\n");
process.exit(7);`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "retry-fail", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash"], env);
    const first = command(["wait", "--full", "--run-id", "retry-fail", "--timeout", "10"], env, true);
    assert.ok([3, 4].includes(first.status));
    const final = first.status === 3 ? first : command(["wait", "--full", "--run-id", "retry-fail", "--timeout", "10"], env, true);
    assert.equal(final.status, 3);
    const result = final.json.results[0];
    assert.equal(result.state, "failed");
    assert.equal(result.retryGuidance?.action, "review_retry_same_config");
    assert.equal(result.retryGuidance?.retryOwner, "host");
    assert.equal(result.providerRetryCount, 2);
    assert.ok(String(result.finalText ?? "").length >= 0);
    command(["cleanup", "--reviewed", "yes", "--run-id", "retry-fail"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("continue clears advice and count, records current runtime version", () => {
  const temporary = mkdtempSync(join(tmpdir(), "subworker-retry-continue-"));
  const fake = fakeLauncher(temporary, `
const continuing = process.argv.includes("--continue");
if (!continuing) {
  console.log(JSON.stringify({type:"auto_retry_start",attempt:1}));
  process.stderr.write("HTTP 503 service unavailable\\n");
  process.exit(7);
}
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "retry-turn", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "first"], env);
    const first = command(["wait", "--full", "--run-id", "retry-turn", "--timeout", "10"], env, true);
    assert.ok([3, 4].includes(first.status));
    const failed = first.status === 3 ? first.json.results[0] : command(["wait", "--full", "--run-id", "retry-turn", "--timeout", "10"], env, true).json.results[0];
    assert.equal(failed.state, "failed");
    assert.equal(failed.retryGuidance?.action, "review_retry_same_config");
    command(["continue", "--run-id", "retry-turn", "--", "retry"], env);
    const live = JSON.parse(readFileSync(join(env.SUBWORKER_STATE_ROOT, "retry-turn", "result.json"), "utf8"));
    assert.equal(live.retryGuidance, null);
    assert.equal(live.providerRetryCount, null);
    assert.ok(live.worker?.version);
    assert.equal(live.turns[0].retryGuidance?.action, "review_retry_same_config");
    assert.equal(live.turns[0].providerRetryCount, 1);
    assert.ok(live.turns[0].worker?.version);
    const second = command(["wait", "--full", "--run-id", "retry-turn", "--timeout", "10"], env).json.results[0];
    assert.equal(second.state, "success");
    assert.equal(second.retryGuidance, null);
    assert.ok(existsSync(join(env.SUBWORKER_STATE_ROOT, "retry-turn")));
    command(["cleanup", "--reviewed", "yes", "--run-id", "retry-turn"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
