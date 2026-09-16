import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { selectGrok, grokLaunchArgs, createGrokSession, grokSessionPath, cleanupGrokSession } from "../lib/grok-backend.mjs";
import { summarizeClaudeStream } from "../lib/claude-backend.mjs";

test("Grok selection and native bypass preserve explicit model and effort", () => {
  const selected = selectGrok(["--model=grok-4.6", "--effort", "xhigh", "--dangerously-skip-permissions"]);
  const args = grokLaunchArgs({ args: selected.args, mode: selected, prompt: "task", session: { id: "owned" }, workdir: "/tmp/work", systemPrompt: "scope" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(args.includes("--always-approve"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(args[args.indexOf("--reasoning-effort") + 1], "xhigh");
  const resumed = grokLaunchArgs({ args: [], mode: { ...selected, readOnly: true }, prompt: "more", conversationId: "exact-id", workdir: "/tmp/work", systemPrompt: "scope" });
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "exact-id");
  assert.ok(!resumed.includes("--session-id"));
  assert.equal(resumed[resumed.indexOf("--permission-mode") + 1], "plan");
  assert.throws(() => selectGrok(["--resume", "other"]), /owns/);
  assert.throws(() => selectGrok(["--effort", "unknown"]), /effort/);
});

async function summarize(frames) {
  let settled = 0;
  const result = await summarizeClaudeStream(Readable.from(frames.map((frame) => JSON.stringify(frame) + "\n")), {
    backendName: "grok", onActivity() {}, onAttention() {}, onSettled() { settled += 1; }, classifyAttention() { return null; },
  });
  return { result, settled };
}

test("Grok messages collect tools and native usage, ignoring child completion", async () => {
  const { result, settled } = await summarize([
    { type: "system", subtype: "init", session_id: "root", model: "grok-4.6" },
    { type: "result", subtype: "success", parent_tool_use_id: "child", session_id: "child", result: "wrong" },
    { type: "assistant", message: { model: "grok-4.6", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: false }] } },
    { type: "result", subtype: "success", result: "done", usage: { input_tokens: 30, output_tokens: 4 }, total_cost_usd: 0.1 },
  ]);
  assert.equal(settled, 1);
  assert.equal(result.conversationId, "root");
  assert.equal(result.lastAssistant.provider, "grok");
  assert.equal(result.lastAssistant.text, "done");
  assert.deepEqual(result.tools, [{ name: "Read", count: 1, errorCount: 0 }]);
  assert.equal(result.usage.output_tokens, 4);
  assert.equal(result.usage.reasoning_tokens, undefined);
  assert.equal((await summarize([{ type: "assistant", message: { content: [] } }])).result.settled, false);
  assert.equal((await summarize([{ type: "result", subtype: "error", is_error: true, result: "failed" }])).result.lastAssistant.error, "failed");
});

test("Grok cleanup only removes the assigned native session", () => {
  const home = mkdtempSync(join(tmpdir(), "sw-grok-home-"));
  try {
    const session = { ...createGrokSession(home), home };
    const owned = grokSessionPath(session);
    mkdirSync(owned, { recursive: true });
    const other = join(home, "sessions", "personal");
    mkdirSync(other, { recursive: true });
    cleanupGrokSession(session);
    assert.equal(existsSync(owned), false);
    assert.equal(existsSync(other), true);
    assert.throws(() => grokSessionPath({ ...session, id: "../personal" }), /Invalid/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Grok supervisor dispatch, exact continuation, diagnostics and reviewed cleanup", () => {
  const home = mkdtempSync(join(tmpdir(), "sw-grok-e2e-"));
  const events = join(import.meta.dirname, "../lib/events.mjs");
  const launcher = join(home, "fake-grok.mjs");
  const env = { ...process.env, HOME: home, GROK_HOME: join(home, ".grok"), GROK_WORKER_LAUNCHER: launcher, SUBWORKER_STATE_ROOT: join(home, "state") };
  function command(args) {
    const output = spawnSync(process.execPath, [events, ...args], { env, encoding: "utf8" });
    assert.equal(output.status, 0, output.stderr || output.stdout);
    return JSON.parse(output.stdout);
  }
  try {
    writeFileSync(launcher, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(join(home, "args.jsonl"))},JSON.stringify(args)+'\\n');\nconst id=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));\nconsole.log(JSON.stringify({type:'assistant',message:{model:'grok-4.6',content:[{type:'text',text:'done'}]}}));\nconsole.log(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'done'}));\n`, { mode: 0o755 });
    command(["dispatch", "--backend", "grok", "--run-id", "grok", "--mode", "in-place", "--workdir", home, "--", "task"]);
    command(["wait", "--run-id", "grok", "--timeout", "10"]);
    const file = join(home, "state", "grok", "result.json");
    const first = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(first.state, "success");
    assert.deepEqual(first.backendArgs, ["--dangerously-skip-permissions"]);
    assert.equal(first.conversationId, first.grokSession.id);
    // Simulate continuation of a pre-0.4.1 run that omitted the permission flag.
    writeFileSync(file, JSON.stringify({ ...first, backendArgs: [] }));
    command(["continue", "--run-id", "grok", "--", "follow up"]);
    command(["wait", "--run-id", "grok", "--timeout", "10"]);
    const second = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(second.turnIndex, 2);
    assert.equal(second.conversationId, first.conversationId);
    const calls = readFileSync(join(home, "args.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls[1][calls[1].indexOf("--resume") + 1], first.conversationId);
    assert.ok(calls.every((args) => args.includes("bypassPermissions")));
    command(["diagnose", "--run-id", "grok"]);
    command(["cleanup", "--run-id", "grok", "--reviewed", "yes"]);
    assert.equal(existsSync(file), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
