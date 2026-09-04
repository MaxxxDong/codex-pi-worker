import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const bridge = resolve(import.meta.dirname, "../lib/commandcode-anthropic-bridge.mjs");
const launcher = resolve(import.meta.dirname, "../bin/claude-commandcode-launcher.mjs");

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

test("CommandCode bridge converts Claude Messages and tool calls without persisting credentials", async () => {
  let upstreamBody;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.url, "/provider/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer upstream-test-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      choices: [{
        finish_reason: "tool_calls",
        message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" } }] },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } },
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
      COMMANDCODE_REASONING_EFFORT: "max",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    await waitForPort(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        max_tokens: 4096,
        system: [{ type: "text", text: "system" }],
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "Grep", input: { pattern: "x" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "found" }, { type: "text", text: "continue" }] },
        ],
        tools: [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }],
      }),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.stop_reason, "tool_use");
    assert.deepEqual(value.content[0], { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "README.md" } });
    assert.equal(value.usage.cache_read_input_tokens, 64);
    assert.equal(upstreamBody.model, "deepseek/deepseek-v4-flash");
    assert.equal(upstreamBody.reasoning_effort, "max");
    assert.equal(upstreamBody.tool_choice, undefined);
    assert.equal(upstreamBody.messages[0].role, "system");
    assert.ok(upstreamBody.messages.some((message) => message.role === "tool" && message.tool_call_id === "old-call"));
    assert.equal(upstreamBody.tools[0].function.name, "Read");

    const count = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-test-key" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    assert.ok((await count.json()).input_tokens > 0);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
  assert.equal(stderr, "");
});

test("CommandCode bridge emits valid Anthropic SSE for text responses", async () => {
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "DONE" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const port = await freePort();
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
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
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "go" }] }),
    });
    const body = await response.text();
    assert.match(body, /event: message_start/);
    assert.match(body, /"type":"text_delta","text":"DONE"/);
    assert.match(body, /"stop_reason":"end_turn"/);
    assert.match(body, /event: message_stop/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});

test("CommandCode launcher keeps effort and endpoint overrides scoped to one Claude process", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worker-claude-launcher-"));
  const agent = join(temporary, "agent");
  const marker = join(temporary, "claude.json");
  const fakeClaude = join(temporary, "claude.mjs");
  mkdirSync(agent);
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ commandcode: { key: "test-key" } }));
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import {writeFileSync} from "node:fs";
writeFileSync(process.env.CLAUDE_LAUNCH_MARKER, JSON.stringify({
  args: process.argv.slice(2),
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  effort: process.env.CLAUDE_CODE_EFFORT_LEVEL,
}));
`);
  chmodSync(fakeClaude, 0o755);
  try {
    const child = spawn(process.execPath, [launcher, "--model", "deepseek/deepseek-v4-flash", "--effort", "high", "-p", "task"], {
      env: {
        ...process.env,
        PI_WORKER_AGENT_SOURCE: agent,
        PI_WORKER_CLAUDE_BIN: fakeClaude,
        CLAUDE_LAUNCH_MARKER: marker,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolveExit) => child.once("close", resolveExit));
    assert.equal(code, 0, stderr);
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.effort, "high");
    assert.match(observed.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(observed.args.includes("--settings"));
    assert.ok(observed.args.indexOf("--settings") < observed.args.indexOf("-p"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
