import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const events = join(root, "lib/events.mjs");
const THINKING_LEVELS_FOR_TEST = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function command(args, env, allowFailure = false) {
  const result = spawnSync(process.execPath, [events, ...args], { encoding: "utf8", env });
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || result.stdout);
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

function commandAsync(args, env) {
  return new Promise((resolveCommand) => {
    const child = spawn(process.execPath, [events, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveCommand({ status, stderr, json: stdout ? JSON.parse(stdout) : null }));
  });
}

function waitAll(ids, env) {
  const byId = new Map();
  let pending = ids;
  while (pending.length > 0) {
    const waited = command(["wait", ...pending.flatMap((id) => ["--run-id", id]), "--timeout", "10"], env).json;
    for (const result of waited.results) byId.set(result.runId, result);
    pending = waited.pending;
  }
  return ids.map((id) => byId.get(id));
}

function testEnv(temporary, launcher) {
  const caches = [join(temporary, ".npm"), join(temporary, ".cache", "uv")];
  caches.forEach((path) => mkdirSync(path, { recursive: true }));
  const agent = join(temporary, "agent-source");
  mkdirSync(join(agent, "npm"), { recursive: true });
  for (const name of ["auth.json", "models.json", "models-store.json", "settings.json"]) {
    writeFileSync(join(agent, name), "{}\n");
  }
  return {
    ...process.env,
    PI_WORKER_STATE_ROOT: join(temporary, "state"),
    PI_WORKER_LAUNCHER: launcher,
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
console.log(JSON.stringify({type:"argv",argv:process.argv.slice(2)}));
await new Promise((resolve) => setTimeout(resolve, 100));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:"DONE"}],usage:{input:1,output:1}}}));
console.log(JSON.stringify({type:"agent_settled"}));`;

test("workers use a run-local writable Pi profile with shared packages", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-agent-profile-"));
  const marker = join(temporary, "profile.json");
  const fake = fakeLauncher(temporary, `
import {readFileSync, readlinkSync, writeFileSync} from "node:fs";
import {join} from "node:path";
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(process.env.PI_WORKER_TEST_PROFILE_MARKER, JSON.stringify({
  agent,
  auth: JSON.parse(readFileSync(join(agent, "auth.json"), "utf8")),
  settings: JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")),
  npm: readlinkSync(join(agent, "npm")),
}));
${successEvents}`);
  const env = testEnv(temporary, fake);
  env.PI_WORKER_TEST_PROFILE_MARKER = marker;
  writeFileSync(join(env.PI_WORKER_AGENT_SOURCE, "auth.json"), '{"provider":"configured"}\n');
  writeFileSync(join(env.PI_WORKER_AGENT_SOURCE, "settings.json"), JSON.stringify({
    skills: ["coding"],
    packages: ["npm:pi-lens", "npm:pi-playwright", "npm:context-mode", "npm:@upstash/context7-pi", "npm:keep-me"],
  }));
  try {
    command(["dispatch", "--run-id", "profile", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash"], env);
    const result = command(["wait", "--run-id", "profile", "--timeout", "10"], env).json.results[0];
    assert.equal(result.hardTimeoutSeconds, 0);
    assert.equal(result.idleTimeoutSeconds, 0);
    const profile = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(profile.agent, join(env.PI_WORKER_STATE_ROOT, "profile", "agent"));
    assert.deepEqual(profile.auth, { provider: "configured" });
    assert.deepEqual(profile.settings, { skills: ["coding"], packages: ["npm:keep-me"] });
    assert.equal(profile.npm, join(env.PI_WORKER_AGENT_SOURCE, "npm"));
    assert.ok(!existsSync(profile.agent));
    command(["cleanup", "--reviewed", "yes", "--run-id", "profile"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("parallel read workers return independently and retain only compact results", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-read-"));
  const fake = fakeLauncher(temporary, successEvents);
  const env = testEnv(temporary, fake);
  try {
    for (const [id, provider, model] of [["one", "shuaiapi", "gpt-5.6-sol"], ["two", "shuaiapi", "gpt-5.6-luna"], ["three", "opencode-go", "deepseek-v4-flash"], ["four", "xai", "grok-4.5"]]) {
      command(["dispatch", "--run-id", id, "--mode", "read", "--workdir", temporary, "--", "--provider", provider, "--model", model], env);
    }
    const results = waitAll(["one", "two", "three", "four"], env);
    assert.deepEqual(results.map((result) => result.state), ["success", "success", "success", "success"]);
    assert.deepEqual(results.map((result) => result.thinking), ["medium", "xhigh", "max", "high"]);
    assert.ok(results.every((result) => result.finalText === "DONE"));
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "one", "worker.jsonl")));
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "one", "worker.stderr")));
    command(["cleanup", "--reviewed", "yes", "--run-id", "one", "--run-id", "two", "--run-id", "three", "--run-id", "four"], env);
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "one")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("wait returns when one run succeeds while peers continue", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-success-fast-"));
  const fake = fakeLauncher(temporary, `
const prompt = process.argv.at(-1);
await new Promise((resolve) => setTimeout(resolve, prompt === "fast" ? 100 : 1200));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "fast-success", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "fast"], env);
    command(["dispatch", "--run-id", "slow-success", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "slow"], env);
    const started = Date.now();
    const first = command(["wait", "--run-id", "fast-success", "--run-id", "slow-success", "--timeout", "10"], env).json;
    assert.equal(first.state, "completed");
    assert.deepEqual(first.results.map((result) => result.runId), ["fast-success"]);
    assert.deepEqual(first.pending, ["slow-success"]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(command(["wait", "--run-id", "slow-success", "--timeout", "10"], env).json.state, "settled");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("independent waiters on the same run are both notified", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-multi-waiter-"));
  const fake = fakeLauncher(temporary, `
await new Promise((resolve) => setTimeout(resolve, 500));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "shared", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "task"], env);
    const args = ["wait", "--run-id", "shared", "--timeout", "3"];
    const [first, second] = await Promise.all([commandAsync(args, env), commandAsync(args, env)]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.json.results[0].state, "success");
    assert.equal(second.json.results[0].state, "success");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("usage aggregates every assistant call", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-usage-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"toolUse",content:[{type:"text",text:"STEP"}],usage:{input:10,output:2,cacheRead:5,reasoning:3,totalTokens:20,cost:{input:1,total:2}}}}));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:"DONE"}],usage:{input:20,output:4,cacheRead:7,reasoning:6,totalTokens:40,cost:{input:3,total:4}}}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "usage", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash"], env);
    const result = command(["wait", "--run-id", "usage", "--timeout", "10"], env).json.results[0];
    assert.equal(result.finalText, "DONE");
    assert.deepEqual(result.usage, { input: 30, output: 6, cacheRead: 12, reasoning: 9, totalTokens: 60, cost: { input: 4, total: 6 } });
    assert.equal(result.assistantCalls, 2);
    assert.equal(result.reportedReasoningTokens, 9);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("failure produces a bounded failure log", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-failure-"));
  const fake = fakeLauncher(temporary, 'process.stderr.write("diagnostic Authorization: Bearer sk-secret0123456789012345\\n"); console.log(JSON.stringify({type:"agent_end"}));');
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "failed", "--workdir", temporary, "--", "--provider", "xai", "--model", "grok-4.5"], env);
    const waited = command(["wait", "--run-id", "failed", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].reason, "missing agent_settled");
    const log = readFileSync(join(env.PI_WORKER_STATE_ROOT, "failed", "failure.log"), "utf8");
    assert.match(log, /diagnostic/);
    assert.doesNotMatch(log, /sk-secret/);
    assert.match(log, /\[REDACTED\]/);
    assert.ok(!existsSync(join(env.PI_WORKER_STATE_ROOT, "failed", "changes.patch")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("settled reasoning without visible final text fails explicitly", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-empty-final-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"thinking",thinking:"internal only"}],usage:{input:1,output:1,reasoning:1}}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "empty", "--workdir", temporary, "--", "--provider", "shuaiapi-grok", "--model", "grok-4.5"], env);
    const waited = command(["wait", "--run-id", "empty", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].reason, "empty final response");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("dispatch requires an explicit model, fixes DeepSeek to max, and accepts explicit new profiles", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-profile-"));
  const env = testEnv(temporary, fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`));
  try {
    const implicit = command(["dispatch", "--run-id", "implicit", "--workdir", temporary, "--", "task"], env, true);
    assert.equal(implicit.status, 2);
    assert.match(implicit.stderr, /--provider, --model/);
    const shuaiGrok = command(["dispatch", "--run-id", "wrong-shuai", "--workdir", temporary, "--", "--provider", "shuaiapi-grok", "--model", "grok-4.5", "--thinking", "medium"], env, true);
    assert.equal(shuaiGrok.status, 2);
    assert.match(shuaiGrok.stderr, /one of: high/);
    const session = command(["dispatch", "--run-id", "session", "--workdir", temporary, "--", "--provider", "shuaiapi", "--model", "gpt-5.6-sol", "--resume", "abc"], env, true);
    assert.equal(session.status, 2);
    assert.match(session.stderr, /owns its managed session/);
    const sol = command(["dispatch", "--run-id", "sol", "--workdir", temporary, "--", "--provider", "shuaiapi", "--model", "gpt-5.6-sol", "--thinking", "invalid"], env, true);
    assert.equal(sol.status, 2);
    assert.match(sol.stderr, /thinking must be one of/);
    const deepseek = command(["dispatch", "--run-id", "deepseek-low", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "--thinking", "low"], env, true);
    assert.equal(deepseek.status, 0);
    const fixed = command(["wait", "--run-id", "deepseek-low", "--timeout", "10"], env).json.results[0];
    const fixedArgs = JSON.parse(fixed.finalText);
    assert.equal(fixed.thinking, "max");
    assert.deepEqual(fixedArgs.filter((argument) => argument === "--thinking" || THINKING_LEVELS_FOR_TEST.has(argument)), ["--thinking", "max"]);
    const official = command(["dispatch", "--run-id", "official-low", "--workdir", temporary, "--", "--provider", "deepseek", "--model", "deepseek-v4-flash", "--thinking", "low"], env, true);
    assert.equal(official.status, 2);
    assert.match(official.stderr, /one of: high, max/);
    const unknownImplicit = command(["dispatch", "--run-id", "unknown-implicit", "--workdir", temporary, "--", "--provider", "new-provider", "--model", "new-model", "task"], env, true);
    assert.equal(unknownImplicit.status, 2);
    assert.match(unknownImplicit.stderr, /requires explicit --thinking/);
    command(["dispatch", "--run-id", "unknown", "--workdir", temporary, "--", "--provider", "new-provider", "--model", "new-model", "--thinking", "high", "task"], env);
    const unknown = command(["wait", "--run-id", "unknown", "--timeout", "10"], env).json.results[0];
    assert.equal(unknown.provider, "new-provider");
    assert.equal(unknown.model, "new-model");
    assert.equal(unknown.thinking, "high");
    command(["cleanup", "--reviewed", "yes", "--run-id", "deepseek-low", "--run-id", "unknown"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("provider attention wakes wait immediately and does not prevent a later terminal wait", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-attention-"));
  const fake = fakeLauncher(temporary, `
process.stderr.write("HTTP 429 too many requests\\n");
await new Promise((resolve) => setTimeout(resolve, 500));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "attention", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash"], env);
    const alert = command(["wait", "--run-id", "attention", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    assert.equal(alert.json.state, "attention");
    assert.equal(alert.json.alerts[0].category, "rate_limit");
    assert.deepEqual(alert.json.pending, ["attention"]);
    const terminal = command(["wait", "--run-id", "attention", "--timeout", "10"], env).json;
    assert.equal(terminal.results[0].state, "success");
    assert.equal(terminal.results[0].attention.category, "rate_limit");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("three consecutive tool failures wake wait with bounded redacted summaries", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-tool-errors-"));
  const fake = fakeLauncher(temporary, `
for (let index = 0; index < 3; index += 1) console.log(JSON.stringify({type:"tool_execution_end",toolName:"read",isError:true,result:{content:[{type:"text",text:"Authorization: Bearer sk-secret0123456789012345 " + "x".repeat(5000)}]}}));
await new Promise((resolve) => setTimeout(resolve, 1000));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "tool-errors", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "task"], env);
    const alert = command(["wait", "--run-id", "tool-errors", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    assert.equal(alert.json.alerts[0].category, "repeated_tool_errors");
    const result = command(["wait", "--run-id", "tool-errors", "--timeout", "10"], env).json.results[0];
    assert.deepEqual(result.tools.map(({ name, count, errorCount }) => ({ name, count, errorCount })), [
      { name: "read", count: 3, errorCount: 3 },
    ]);
    assert.ok(result.tools[0].lastError.length <= 2048);
    assert.ok(!result.tools[0].lastError.includes("sk-secret"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("RPC steer is acknowledged and changes the active turn without continuation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-steer-"));
  const fake = fakeLauncher(temporary, `
import {createInterface} from "node:readline";
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const value = JSON.parse(line);
  console.log(JSON.stringify({type:"response",id:value.id,success:true}));
  if (value.type === "steer") {
    console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:"STEERED:" + value.message}]}}));
    console.log(JSON.stringify({type:"agent_settled"}));
    break;
  }
}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "steer", "--workdir", temporary, "--live", "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "start"], env);
    const ack = command(["steer", "--run-id", "steer", "--timeout", "10", "--", "focus on boundary tests"], env).json;
    assert.equal(ack.success, true);
    const result = command(["wait", "--run-id", "steer", "--timeout", "10"], env).json.results[0];
    assert.equal(result.finalText, "STEERED:focus on boundary tests");
    assert.equal(result.turnIndex, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("headless is default and live RPC is required for steer", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-headless-"));
  const fake = fakeLauncher(temporary, `
const args = process.argv.slice(2);
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(args)}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "headless", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "plain task"], env);
    const steer = command(["steer", "--run-id", "headless", "--", "not allowed"], env, true);
    assert.equal(steer.status, 2);
    assert.match(steer.stderr, /--live/);
    const result = command(["wait", "--run-id", "headless", "--timeout", "10"], env).json.results[0];
    const args = JSON.parse(result.finalText);
    assert.equal(result.live, false);
    assert.equal(result.idleTimeoutSeconds, 0);
    assert.equal(args.includes("rpc"), false);
    assert.equal(args.at(-1), "plain task");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("wait returns immediately when one run fails while peers continue", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-fail-fast-"));
  const fake = fakeLauncher(temporary, `
const prompt = process.argv.at(-1);
if (prompt === "fail now") process.exit(7);
await new Promise((resolve) => setTimeout(resolve, 1200));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "fast-fail", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "fail now"], env);
    command(["dispatch", "--run-id", "slow-success", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "finish later"], env);
    const started = Date.now();
    const failed = command(["wait", "--run-id", "fast-fail", "--run-id", "slow-success", "--timeout", "10"], env, true);
    assert.equal(failed.status, 3);
    assert.equal(failed.json.state, "failed");
    assert.equal(failed.json.results[0].runId, "fast-fail");
    assert.deepEqual(failed.json.pending, ["slow-success"]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(command(["wait", "--run-id", "slow-success", "--timeout", "10"], env).json.results[0].state, "success");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("continue reuses the managed session and preserves a compact prior turn", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-session-"));
  const fake = fakeLauncher(temporary, `
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
mkdirSync(sessionDir, {recursive:true});
const marker = join(sessionDir, "marker");
const continuing = args.includes("--continue");
if (continuing && !existsSync(marker)) process.exit(9);
writeFileSync(marker, "saved");
if (continuing) await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:continuing ? "CONTINUED" : "FIRST"}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    const receipt = command(["dispatch", "--run-id", "session", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "first"], env).json;
    const first = command(["wait", "--run-id", "session", "--timeout", "10"], env).json.results[0];
    assert.equal(first.finalText, "FIRST");
    assert.ok(existsSync(join(receipt.sessionDir, "marker")));
    const lock = join(env.PI_WORKER_STATE_ROOT, "session", ".lifecycle.lock");
    writeFileSync(lock, "busy");
    const busy = command(["continue", "--run-id", "session", "--", "blocked"], env, true);
    assert.equal(busy.status, 3);
    assert.match(busy.stderr, /lifecycle is busy/);
    rmSync(lock);
    writeFileSync(lock, JSON.stringify({pid:99999999}));
    command(["continue", "--run-id", "session", "--", "second"], env);
    const live = JSON.parse(readFileSync(join(env.PI_WORKER_STATE_ROOT, "session", "result.json"), "utf8"));
    assert.equal(live.assistantCalls, 0);
    assert.equal(live.firstToolAt, null);
    const second = command(["wait", "--run-id", "session", "--timeout", "10"], env).json.results[0];
    assert.equal(second.finalText, "CONTINUED");
    assert.equal(second.turnIndex, 2);
    assert.equal(second.turns[0].finalText, "FIRST");
    assert.equal(second.sessionDir, receipt.sessionDir);
    command(["cleanup", "--reviewed", "yes", "--run-id", "session"], env);
    assert.ok(!existsSync(receipt.sessionDir));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("continuation preserves the prior failure diagnosis", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-session-failure-"));
  const fake = fakeLauncher(temporary, `
const continuing = process.argv.includes("--continue");
if (!continuing) {
  process.stderr.write("HTTP 503 service unavailable\\n");
  process.exit(7);
}
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "failed-session", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "first"], env);
    const alert = command(["wait", "--run-id", "failed-session", "--timeout", "10"], env, true);
    assert.equal(alert.status, 4);
    const first = command(["wait", "--run-id", "failed-session", "--timeout", "10"], env, true).json.results[0];
    assert.equal(first.reasonCode, "missing_settled");
    assert.equal(first.attention.category, "provider_5xx");
    command(["continue", "--run-id", "failed-session", "--", "retry"], env);
    const second = command(["wait", "--run-id", "failed-session", "--timeout", "10"], env).json.results[0];
    assert.equal(second.turns[0].reasonCode, "missing_settled");
    assert.equal(second.turns[0].reason, "missing agent_settled");
    assert.equal(second.turns[0].attention.category, "provider_5xx");
    assert.equal(second.turns[0].assistantCalls, 0);
    assert.equal(typeof second.turns[0].elapsedSeconds, "number");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("status exposes bounded live activity without persisting process observations", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-activity-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"a",toolName:"read",args:{secret:"must-not-persist"}}));
console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"b",toolName:"bash",args:{command:"private"}}));
await new Promise((resolve) => setTimeout(resolve, 800));
console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"a",toolName:"read",isError:false}));
console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"b",toolName:"bash",isError:false}));
${successEvents}`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "activity", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "task"], env);
    let observed;
    for (let index = 0; index < 40; index += 1) {
      observed = command(["status", "--run-id", "activity"], env).json.runs[0].result;
      if (observed.activeTools?.length === 2) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    assert.equal(observed.state, "running");
    assert.equal(observed.activity, "running_tools");
    assert.deepEqual(observed.activeTools.map((tool) => tool.name).sort(), ["bash", "read"]);
    assert.ok(observed.supervisorAlive);
    assert.ok(observed.childAlive);
    assert.ok(observed.firstToolAt);
    assert.ok(observed.lastToolAt);
    assert.equal(observed.lastEventType, "tool_execution_start");
    assert.equal(typeof observed.activitySeconds, "number");
    assert.doesNotMatch(JSON.stringify(observed.activeTools), /secret|private/);
    const stored = JSON.parse(readFileSync(join(env.PI_WORKER_STATE_ROOT, "activity", "result.json"), "utf8"));
    assert.equal(stored.supervisorAlive, undefined);
    assert.equal(stored.childAlive, undefined);
    const result = command(["wait", "--run-id", "activity", "--timeout", "10"], env).json.results[0];
    assert.equal(result.state, "success");
    assert.equal(result.activity, null);
    assert.deepEqual(result.activeTools, []);
    assert.ok(result.firstEventAt);
    assert.ok(result.lastEventAt);
    assert.ok(result.firstToolAt);
    assert.ok(result.lastToolAt);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cancel stops the child through the supervisor and produces a reviewable terminal result", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-cancel-"));
  const fake = fakeLauncher(temporary, `
process.on("SIGTERM", () => process.exit(0));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"toolUse",content:[{type:"text",text:"WORKING"}]}}));
await new Promise((resolve) => setTimeout(resolve, 5000));`);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "cancelled", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "task"], env);
    const response = command(["cancel", "--run-id", "cancelled", "--reason", "scope withdrawn", "--timeout", "10"], env).json;
    assert.equal(response.state, "cancelled");
    const cancelled = response.results[0];
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.reasonCode, "user_cancelled");
    assert.equal(cancelled.reason, "scope withdrawn");
    assert.equal(cancelled.activity, null);
    assert.equal(cancelled.cleanupRequired, true);
    assert.ok(existsSync(cancelled.failureLogPath));
    const waited = command(["wait", "--run-id", "cancelled", "--timeout", "1"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].state, "cancelled");
    assert.equal(command(["cancel", "--run-id", "cancelled", "--timeout", "1"], env).json.state, "cancelled");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("status converts every vanished supervisor into a durable failed result", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-orphan-"));
  const env = testEnv(temporary, process.execPath);
  for (const id of ["orphan-a", "orphan-b"]) {
    const directory = join(env.PI_WORKER_STATE_ROOT, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "result.json"), JSON.stringify({schema:2,runId:id,state:"running",mode:"read",supervisorPid:99999999,childPid:null,managedWorktree:false,workdir:temporary,startedAt:new Date().toISOString()}));
  }
  try {
    const status = command(["status", "--run-id", "orphan-a", "--run-id", "orphan-b"], env).json;
    assert.deepEqual(status.runs.map((item) => item.result.state), ["failed", "failed"]);
    assert.ok(status.runs.every((item) => item.result.reasonCode === "supervisor_lost"));
    assert.ok(status.runs.every((item) => item.result.schema === 3));
    assert.ok(status.runs.every((item) => existsSync(item.result.failureLogPath)));
    const waited = command(["wait", "--run-id", "orphan-a", "--run-id", "orphan-b", "--timeout", "1"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results.length, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("optional idle timeout stops a silent worker", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-idle-"));
  const fake = fakeLauncher(temporary, "await new Promise((resolve) => setTimeout(resolve, 5000));");
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "idle", "--workdir", temporary, "--idle-timeout", "0.2", "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash"], env);
    const waited = command(["wait", "--run-id", "idle", "--timeout", "10"], env, true);
    assert.equal(waited.status, 3);
    assert.equal(waited.json.results[0].reason, "idle timeout");
    assert.equal(waited.json.results[0].timeoutType, "idle");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("runtime expands named capabilities and owns their tool allowlists", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-capability-"));
  const agent = join(temporary, "agent");
  const extension = join(agent, "npm", "node_modules", "@upstash", "context7-pi", "extensions", "context7.ts");
  const skill = join(agent, "npm", "node_modules", "@upstash", "context7-pi", "skills", "context7-docs", "SKILL.md");
  mkdirSync(resolve(extension, ".."), { recursive: true });
  mkdirSync(resolve(skill, ".."), { recursive: true });
  writeFileSync(extension, "export default function noop() {}\n");
  writeFileSync(skill, "---\nname: context7-docs\ndescription: docs\n---\n");
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = { ...testEnv(temporary, fake), PI_CODING_AGENT_DIR: agent };
  try {
    command(["dispatch", "--run-id", "docs", "--workdir", temporary, "--capability", "docs", "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "task"], env);
    const result = command(["wait", "--run-id", "docs", "--timeout", "10"], env).json.results[0];
    const args = JSON.parse(result.finalText);
    const tools = args.indexOf("--tools");
    assert.equal(args[tools + 1], "read,bash,grep,ls,web_search,resolve-library-id,query-docs");
    assert.ok(args.includes("This is a read-only task. Do not modify repository files. Use bash only for inspection or commands known not to write project files."));
    const sessionDir = args.indexOf("--session-dir");
    assert.equal(args[sessionDir + 1], result.sessionDir);
    assert.ok(args.includes(extension));
    assert.ok(args.includes(skill));
    assert.deepEqual(result.capabilities, ["docs"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("optional package skills load only with their matching capability", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-optional-skills-"));
  const agent = join(temporary, "agent");
  const npm = join(agent, "npm", "node_modules");
  const resources = {
    lens: [join(npm, "pi-lens", "dist", "index.js"), join(npm, "pi-lens", "skills")],
    context: [join(npm, "context-mode", "build", "adapters", "pi", "extension.js"), join(npm, "context-mode", "skills")],
    browser: [join(npm, "pi-playwright", "skills", "playwright-browser", "SKILL.md")],
  };
  for (const paths of Object.values(resources)) for (const path of paths) {
    if (path.endsWith("skills")) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, path.endsWith(".md") ? "---\nname: test\ndescription: test\n---\n" : "export default function noop() {}\n");
    }
  }
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = { ...testEnv(temporary, fake), PI_CODING_AGENT_DIR: agent };
  try {
    for (const [capability, paths] of Object.entries(resources)) {
      command(["dispatch", "--run-id", capability, "--workdir", temporary, "--capability", capability, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash", "task"], env);
      const result = command(["wait", "--run-id", capability, "--timeout", "10"], env).json.results[0];
      const args = JSON.parse(result.finalText);
      assert.ok(paths.every((path) => args.includes(path)));
      assert.deepEqual(result.capabilities, [capability]);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("write mode carries dirty source state, captures only worker changes, and waits for review cleanup", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-write-"));
  const source = join(temporary, "source");
  mkdirSync(source);
  execFileSync("git", ["-C", source, "init", "-q"]);
  execFileSync("git", ["-C", source, "config", "user.email", "pi-worker@test.invalid"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Pi Worker Test"]);
  writeFileSync(join(source, "existing.txt"), "committed\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "base"]);
  writeFileSync(join(source, "existing.txt"), "user dirty\n");
  const fake = fakeLauncher(temporary, `
import {writeFileSync} from "node:fs";
writeFileSync("worker.txt", "worker change\\n");
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify(process.argv.slice(2))}],usage:{input:1,output:1}}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    const receipt = command(["dispatch", "--run-id", "write", "--mode", "write", "--source", source, "--", "--provider", "shuaiapi", "--model", "gpt-5.6-sol", "--thinking", "high"], env).json;
    const settled = command(["wait", "--run-id", "write", "--timeout", "10"], env).json.results[0];
    assert.equal(settled.state, "success");
    assert.equal(settled.thinking, "high");
    assert.equal(readFileSync(join(receipt.workdir, "existing.txt"), "utf8"), "user dirty\n");
    const initial = JSON.parse(readFileSync(join(env.PI_WORKER_STATE_ROOT, "write", "result.json"), "utf8"));
    assert.equal(initial.mode, "write");
    const args = JSON.parse(settled.finalText);
    const tools = args.indexOf("--tools");
    assert.equal(args[tools + 1], "read,bash,edit,write,grep,ls,web_search");
    assert.ok(existsSync(receipt.workdir), "worktree must remain until Codex review");
    assert.ok(!existsSync(join(source, "worker.txt")));
    const patch = readFileSync(settled.patchPath, "utf8");
    assert.match(patch, /worker\.txt/);
    assert.doesNotMatch(patch, /existing\.txt/);
    const premature = command(["cleanup", "--run-id", "write"], env, true);
    assert.equal(premature.status, 2);
    assert.ok(existsSync(receipt.workdir));
    const cleaned = command(["cleanup", "--reviewed", "yes", "--run-id", "write"], env).json;
    assert.equal(cleaned.cleaned[0].worktreeRemoved, true);
    assert.ok(!existsSync(receipt.workdir));
    assert.doesNotMatch(execFileSync("git", ["-C", source, "worktree", "list", "--porcelain"], { encoding: "utf8" }), new RegExp(receipt.workdir));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the public wrapper executes its adjacent staged runtime", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-wrapper-"));
  try {
    const result = spawnSync(join(root, "bin", "pi-worker"), ["cache-status"], {
      encoding: "utf8",
      env: { ...process.env, PI_WORKER_TEST_CACHE_ROOTS: temporary, PI_WORKER_CACHE_MAX_BYTES: "1234" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).maxBytes, 1234);
    const help = spawnSync(join(root, "bin", "pi-worker"), ["--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--capability/);
    const profiles = spawnSync(join(root, "bin", "pi-worker"), ["profiles"], { encoding: "utf8" });
    assert.ok(JSON.parse(profiles.stdout).models.some((profile) => profile.id === "opencode-go/deepseek-v4-flash"));
    const cancel = spawnSync(join(root, "bin", "pi-worker"), ["cancel", "--run-id", "missing"], {
      encoding: "utf8",
      env: { ...process.env, PI_WORKER_STATE_ROOT: temporary },
    });
    assert.equal(cancel.status, 2);
    assert.match(cancel.stderr, /unknown run/);
    assert.doesNotMatch(cancel.stderr, /startup session lookup/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the headless wrapper keeps optional extensions out of the default path", () => {
  const wrapper = readFileSync(join(root, "bin", "pi-worker"), "utf8");
  assert.match(wrapper, /--no-extensions/);
  assert.match(wrapper, /--offline/);
  assert.doesNotMatch(wrapper, /--no-skills/);
  assert.doesNotMatch(wrapper, /--no-session/);
  assert.match(wrapper, /previous.*--mode/s);
  assert.match(wrapper, /--no-prompt-templates/);
  assert.match(wrapper, /write only inside the current working directory or TMPDIR/);
  assert.match(wrapper, /Do not scan the whole repository unless the task explicitly requires it or targeted evidence is insufficient/);
  assert.match(wrapper, /For output-only or connectivity checks, do not call tools/);
  assert.doesNotMatch(wrapper, /@upstash\/context7-pi/);
  assert.doesNotMatch(wrapper, /resolve-library-id|query-docs/);
  assert.doesNotMatch(wrapper, /node_modules\/pi-lens/);
  assert.doesNotMatch(wrapper, /node_modules\/pi-mcp-adapter/);
  assert.doesNotMatch(wrapper, /node_modules\/context-mode/);
});

test("the public wrapper fails before dispatch when Codex blocks provider network", () => {
  const blocked = spawnSync(join(root, "bin", "pi-worker"), ["dispatch"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" },
  });
  assert.equal(blocked.status, 69);
  assert.match(blocked.stderr, /provider network is blocked by the Codex sandbox/);
  assert.match(blocked.stderr, /sandbox_permissions="require_escalated"/);
});

test("Playwright runs get a unique session and supervisor-owned close", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-playwright-"));
  const agent = join(temporary, "agent");
  const marker = join(temporary, "closed.json");
  const closeScript = join(agent, "npm", "node_modules", "pi-playwright", "skills", "playwright-browser", "scripts", "pw.js");
  mkdirSync(resolve(closeScript, ".."), { recursive: true });
  writeFileSync(closeScript, `import {writeFileSync} from "node:fs"; writeFileSync(process.env.PI_WORKER_TEST_PLAYWRIGHT_MARKER, JSON.stringify({args:process.argv.slice(2),session:process.env.PLAYWRIGHT_CLI_SESSION,artifacts:process.env.PI_PLAYWRIGHT_ARTIFACTS}));`);
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"tool_execution_start",toolName:"bash",args:{command:"node /tmp/pi-playwright/skills/playwright-browser/scripts/pw.js open"}}));
${successEvents}`);
  const env = { ...testEnv(temporary, fake), PI_WORKER_AGENT_SOURCE: agent, PI_WORKER_TEST_PLAYWRIGHT_MARKER: marker };
  try {
    command(["dispatch", "--run-id", "browser", "--workdir", temporary, "--", "--provider", "xai", "--model", "grok-4.5"], env);
    const result = command(["wait", "--run-id", "browser", "--timeout", "10"], env).json.results[0];
    const closed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(result.state, "success");
    assert.deepEqual(closed.args, ["close"]);
    assert.equal(closed.session, "pi-worker-browser");
    assert.equal(closed.artifacts, join(env.PI_WORKER_STATE_ROOT, "browser", "browser-artifacts"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("production shared-cache discovery parses host paths", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-cache-paths-"));
  const bin = join(temporary, "bin");
  mkdirSync(bin);
  const du = join(bin, "du");
  writeFileSync(du, "#!/bin/sh\nprintf '0 %s\\n' \"$2\"\n");
  chmodSync(du, 0o700);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  delete env.PI_WORKER_TEST_CACHE_ROOTS;
  delete env.PI_WORKER_CACHE_MAX_BYTES;
  try {
    const result = command(["cache-status"], env);
    assert.equal(result.json.maxBytes, 20 * 1024 * 1024 * 1024);
    assert.ok(result.json.entries.length > 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("workers receive the same shared dependency cache paths", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-cache-"));
  const fake = fakeLauncher(temporary, `
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"test",model:"fake",stopReason:"stop",content:[{type:"text",text:JSON.stringify({npm:process.env.npm_config_cache,uv:process.env.UV_CACHE_DIR,pnpmConfig:process.env.npm_config_store_dir??null})}]}}));
console.log(JSON.stringify({type:"agent_settled"}));`);
  const env = testEnv(temporary, fake);
  try {
    for (const id of ["cache-a", "cache-b"]) command(["dispatch", "--run-id", id, "--workdir", temporary, "--", "--provider", "shuaiapi", "--model", "gpt-5.6-sol"], env);
    const results = waitAll(["cache-a", "cache-b"], env);
    assert.equal(results[0].finalText, results[1].finalText);
    const paths = JSON.parse(results[0].finalText);
    assert.equal(paths.npm, join(temporary, ".npm"));
    assert.equal(paths.uv, join(temporary, ".cache", "uv"));
    assert.equal(paths.pnpmConfig, null);
    const status = command(["cache-status"], env).json;
    assert.equal(status.maxBytes, 1024 * 1024);
    assert.equal(status.entries.length, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cache GC removes stale files without whole-cache purge", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-cache-gc-"));
  const fake = fakeLauncher(temporary, successEvents);
  const env = testEnv(temporary, fake);
  const old = join(temporary, ".npm", "old.bin");
  const recent = join(temporary, ".npm", "recent.bin");
  writeFileSync(old, Buffer.alloc(2 * 1024 * 1024));
  writeFileSync(recent, Buffer.alloc(1024));
  const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  utimesSync(old, oldTime, oldTime);
  try {
    command(["dispatch", "--run-id", "gc", "--workdir", temporary, "--", "--provider", "shuaiapi", "--model", "gpt-5.6-sol"], env);
    command(["wait", "--run-id", "gc", "--timeout", "10"], env);
    const cache = command(["cleanup", "--reviewed", "yes", "--run-id", "gc"], env).json.cache;
    assert.ok(cache.actions.some((action) => action.command === "cache file remove" && action.path === old && action.stale));
    assert.ok(cache.actions.every((action) => !/cache (?:clean --force|purge)|uv cache clean/.test(action.command)));
    assert.ok(!existsSync(old));
    assert.ok(existsSync(recent));
    command(["dispatch", "--run-id", "gc-again", "--workdir", temporary, "--", "--provider", "shuaiapi", "--model", "gpt-5.6-sol"], env);
    command(["wait", "--run-id", "gc-again", "--timeout", "10"], env);
    const repeated = command(["cleanup", "--reviewed", "yes", "--run-id", "gc-again"], env).json.cache;
    assert.equal(repeated.skipped, "checked within the last day");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cache GC counts and prunes the oldest rebuildable Pi Lens data", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-lens-cache-gc-"));
  const lens = join(temporary, ".pi-lens");
  mkdirSync(join(lens, "projects"), { recursive: true });
  mkdirSync(join(lens, "tools"), { recursive: true });
  writeFileSync(join(lens, "projects", "index.bin"), Buffer.alloc(1024));
  writeFileSync(join(lens, "tools", "managed.bin"), Buffer.alloc(2 * 1024 * 1024));
  const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  utimesSync(join(lens, "tools", "managed.bin"), oldTime, oldTime);
  const fake = fakeLauncher(temporary, successEvents);
  const env = {
    ...testEnv(temporary, fake),
    PI_WORKER_TEST_CACHE_ROOTS: lens,
    PI_WORKER_CACHE_MAX_BYTES: String(1024 * 1024),
  };
  try {
    command(["dispatch", "--run-id", "lens-gc", "--workdir", temporary, "--", "--provider", "shuaiapi", "--model", "gpt-5.6-sol"], env);
    command(["wait", "--run-id", "lens-gc", "--timeout", "10"], env);
    const cache = command(["cleanup", "--reviewed", "yes", "--run-id", "lens-gc"], env).json.cache;
    assert.equal(cache.before.entries[0].path, lens);
    assert.ok(cache.actions.some((action) => action.command === "cache file remove" && action.path.endsWith("managed.bin")));
    assert.ok(cache.after.totalBytes <= cache.after.maxBytes);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("old result-bearing runs remain until reviewed cleanup", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-review-ttl-"));
  const fake = fakeLauncher(temporary, successEvents);
  const env = testEnv(temporary, fake);
  try {
    command(["dispatch", "--run-id", "old", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash"], env);
    command(["wait", "--run-id", "old", "--timeout", "10"], env);
    const oldDirectory = join(env.PI_WORKER_STATE_ROOT, "old");
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(oldDirectory, oldTime, oldTime);
    command(["dispatch", "--run-id", "new", "--workdir", temporary, "--", "--provider", "opencode-go", "--model", "deepseek-v4-flash"], env);
    assert.ok(existsSync(oldDirectory));
    command(["wait", "--run-id", "new", "--timeout", "10"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
