import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import test from "node:test";

import { summarizeClaudeStream } from "../lib/claude-backend.mjs";

const bridge = resolve(import.meta.dirname, "../lib/commandcode-anthropic-bridge.mjs");

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

function freePort() {
  const server = createServer();
  return listen(server).then((port) => close(server).then(() => port));
}

function waitForPort(port, child) {
  const deadline = Date.now() + 5_000;
  return new Promise((resolveReady, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error(`bridge exited with ${child.exitCode}`));
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolveReady(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("bridge startup timeout"));
        else setTimeout(attempt, 25);
      });
    };
    attempt();
  });
}

function runSummarize(lines) {
  const activities = [];
  const attentions = [];
  let settled = 0;
  const stream = Readable.from(lines.map((line) => `${JSON.stringify(line)}\n`));
  return summarizeClaudeStream(stream, {
    onActivity: (activity) => { activities.push(activity); },
    onAttention: (category, message) => { attentions.push({ category, message }); },
    onSettled: () => { settled += 1; },
    classifyAttention: () => null,
  }).then((summary) => ({ summary, activities, attentions, settled }));
}

test("api_retry system event emits provider_retry attention with minimal redacted summary", async () => {
  const retryEvent = {
    type: "system",
    subtype: "api_retry",
    attempt: 3,
    error: "429 rate limited, retrying",
    status: 429,
    session_id: "sess-retry-1",
    api_key_hint: "sk-ant-SENTINEL-MUST-NOT-LEAK",
  };
  const { summary, activities, attentions, settled } = await runSummarize([retryEvent]);

  assert.equal(attentions.length, 1);
  assert.equal(attentions[0].category, "provider_retry");
  assert.match(attentions[0].message, /3/);
  assert.match(attentions[0].message, /429/);
  assert.match(attentions[0].message, /rate limited/);
  assert.doesNotMatch(attentions[0].message, /SENTINEL-MUST-NOT-LEAK/);
  assert.ok(activities.some((activity) => activity.type === "claude_api_retry"));
  assert.equal(summary.settled, false);
  assert.equal(settled, 0);
});

test("bridge surfaces invalid tool call arguments JSON instead of running with empty input", async () => {
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-bad", type: "function", function: { name: "Read", arguments: "{not valid json" } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const port = await freePort();
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      COMMANDCODE_BRIDGE_HOST: "127.0.0.1",
      COMMANDCODE_BRIDGE_PORT: String(port),
      COMMANDCODE_BRIDGE_KEY: "local-test-key",
      COMMANDCODE_API_KEY: "upstream-test-key",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/provider/v1`,
    },
    stdio: "ignore",
  });
  try {
    await waitForPort(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "go" }] }),
    });
    assert.equal(response.status, 500);
    const value = await response.json();
    assert.match(value?.error?.message ?? "", /Invalid tool call arguments JSON/);
    assert.match(value?.error?.message ?? "", /Read/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});

test("bridge still accepts legal empty tool call arguments as empty object", async () => {
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-empty", type: "function", function: { name: "Read", arguments: "{}" } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const port = await freePort();
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      COMMANDCODE_BRIDGE_HOST: "127.0.0.1",
      COMMANDCODE_BRIDGE_PORT: String(port),
      COMMANDCODE_BRIDGE_KEY: "local-test-key",
      COMMANDCODE_API_KEY: "upstream-test-key",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/provider/v1`,
    },
    stdio: "ignore",
  });
  try {
    await waitForPort(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "go" }] }),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.content[0], { type: "tool_use", id: "call-empty", name: "Read", input: {} });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});
