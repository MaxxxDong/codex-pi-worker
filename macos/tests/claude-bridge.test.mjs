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
    assert.equal(value.usage.input_tokens, 36);
    assert.equal(value.usage.cache_read_input_tokens, 64);
    assert.equal(value.usage.output_tokens, 20);
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
  let upstreamStream;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    upstreamStream = body.stream;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ model: "deepseek/deepseek-v4-flash", choices: [{ delta: { content: "DONE" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
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
    assert.equal(upstreamStream, true);
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

test("CommandCode bridge streams data before upstream finishes and converts reasoning to ping without user text", async () => {
  let upstreamFinished = false;
  let downstreamGotFirstChunk = false;
  let finishUpstream;
  const upstreamGate = new Promise((resolveGate) => { finishUpstream = resolveGate; });

  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking deeply" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first word" } }] })}\n\n`);

    await upstreamGate;
    response.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: { content: " second word" } }] })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    upstreamFinished = true;
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

    assert.equal(response.status, 200);
    const decoder = new TextDecoder();
    let accumulated = "";
    for await (const chunk of response.body) {
      accumulated += decoder.decode(chunk, { stream: true });
      if (!downstreamGotFirstChunk && accumulated.includes('"text_delta","text":"first word"') && accumulated.includes("event: ping")) {
        downstreamGotFirstChunk = true;
        assert.equal(upstreamFinished, false, "downstream must receive data while upstream is still alive");
        finishUpstream();
      }
    }
    accumulated += decoder.decode();
    assert.equal(downstreamGotFirstChunk, true);
    assert.equal(upstreamFinished, true);
    assert.ok(!accumulated.includes("thinking deeply"), "reasoning must not be output to user text");
    assert.match(accumulated, /event: ping\ndata: \{"type":"ping"\}/);
    assert.match(accumulated, /"text_delta","text":" second word"/);
    assert.match(accumulated, /event: message_stop/);
  } finally {
    finishUpstream?.();
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});

test("CommandCode bridge handles CRLF, split chunks, incremental tool calls, stop, and usage", async () => {
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ping\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hello \"");
    response.write("}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"World\"}}]}\r\n\r\n");
    response.write("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_grep_1\",\"type\":\"function\",\"function\":{\"name\":\"grep\",\"arguments\":\"{\\\"pattern\\\":\"}}]}}]}\r\n\r\n");
    response.write("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"main\\\"}\"}}]}}]}\r\n\r\n");
    response.write("data: {\"choices\":[{\"finish_reason\":\"tool_calls\",\"delta\":{}}],\"usage\":{\"prompt_tokens\":80,\"completion_tokens\":35}}\r\n\r\n");
    response.write("data: [DONE]\r\n\r\n");
    response.end();
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
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        stream: true,
        messages: [{ role: "user", content: "find" }],
        tools: [{ name: "grep", description: "grep", input_schema: { type: "object" } }],
      }),
    });

    const body = await response.text();
    assert.match(body, /"type":"text_delta","text":"Hello "/);
    assert.match(body, /"type":"text_delta","text":"World"/);
    assert.match(body, /"type":"content_block_start","index":1,"content_block":\{"type":"tool_use","id":"call_grep_1","name":"grep","input":\{\}\}/);
    assert.match(body, /"type":"input_json_delta","partial_json":"\{\\"pattern\\":"/);
    assert.match(body, /"type":"input_json_delta","partial_json":"\\"main\\"}"/);
    assert.match(body, /"type":"content_block_stop","index":1/);
    assert.match(body, /"stop_reason":"tool_use"/);
    assert.match(body, /"input_tokens":80/);
    assert.match(body, /"output_tokens":35/);
    assert.match(body, /event: message_stop/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});

test("CommandCode bridge handles interleaved parallel tool calls and propagates full input/cached token usage", async () => {
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "text/event-stream" });

    // Tool 0 chunk 1 (Read)
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read_1", type: "function", function: { name: "Read", arguments: "{\"file" } }] } }],
    })}\n\n`);

    // Tool 1 chunk 1 (Write with delayed name: id and arguments first)
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 1, id: "call_write_1", function: { arguments: "{\"dest\":" } }] } }],
    })}\n\n`);

    // Tool 0 chunk 2 (interleaved back to tool 0)
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "_path\":\"foo.txt\"}" } }] } }],
    })}\n\n`);

    // Tool 1 chunk 2 (name arrives for tool 1, plus remaining arguments)
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 1, type: "function", function: { name: "Write", arguments: "\"bar.txt\"}" } }] } }],
    })}\n\n`);

    // Terminal chunk with usage containing prompt_tokens and prompt_tokens_details.cached_tokens
    response.write(`data: ${JSON.stringify({
      choices: [{ finish_reason: "tool_calls", delta: {} }],
      usage: { prompt_tokens: 150, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 96 } },
    })}\n\n`);

    response.write("data: [DONE]\n\n");
    response.end();
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
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        stream: true,
        messages: [{ role: "user", content: "read and write" }],
        tools: [
          { name: "Read", description: "read", input_schema: { type: "object" } },
          { name: "Write", description: "write", input_schema: { type: "object" } },
        ],
      }),
    });

    const body = await response.text();

    const lines = body.split("\n");
    const blocksByIndex = new Map();
    let messageDeltaUsage = null;
    let messageDeltaStopReason = null;
    let sawMessageStop = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("data: ")) {
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }
        if (data.type === "content_block_start") {
          blocksByIndex.set(data.index, {
            type: data.content_block?.type,
            id: data.content_block?.id,
            name: data.content_block?.name,
            rawJson: "",
            stopped: false,
          });
        } else if (data.type === "content_block_delta") {
          const block = blocksByIndex.get(data.index);
          if (block && data.delta?.type === "input_json_delta") {
            block.rawJson += data.delta.partial_json;
          }
        } else if (data.type === "content_block_stop") {
          const block = blocksByIndex.get(data.index);
          if (block) block.stopped = true;
        } else if (data.type === "message_delta") {
          messageDeltaStopReason = data.delta?.stop_reason;
          messageDeltaUsage = data.usage;
        } else if (data.type === "message_stop") {
          sawMessageStop = true;
        }
      }
    }

    assert.equal(blocksByIndex.size, 2);

    const block0 = blocksByIndex.get(0);
    assert.ok(block0);
    assert.equal(block0.name, "Read");
    assert.equal(block0.id, "call_read_1");
    assert.deepEqual(JSON.parse(block0.rawJson), { file_path: "foo.txt" });
    assert.equal(block0.stopped, true);

    const block1 = blocksByIndex.get(1);
    assert.ok(block1);
    assert.equal(block1.name, "Write");
    assert.equal(block1.id, "call_write_1");
    assert.deepEqual(JSON.parse(block1.rawJson), { dest: "bar.txt" });
    assert.equal(block1.stopped, true);

    // Verify stop_reason and full usage without double-counting (150 prompt, 96 cached => 54 input, 96 cache)
    assert.equal(messageDeltaStopReason, "tool_use");
    assert.equal(messageDeltaUsage?.input_tokens, 54);
    assert.equal(messageDeltaUsage?.cache_read_input_tokens, 96);
    assert.equal(messageDeltaUsage?.output_tokens, 60);
    assert.equal(sawMessageStop, true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});

test("CommandCode bridge explicitly fails on corrupted SSE data JSON and rejects pseudo-success", async () => {
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "valid start" } }] })}\n\n`);
    response.write("data: { this is corrupt json \n\n");
    response.write("data: [DONE]\n\n");
    response.end();
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
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });

    const body = await response.text();
    assert.match(body, /event: error/);
    assert.match(body, /Invalid SSE data JSON|SyntaxError|JSON/i);
    assert.doesNotMatch(body, /event: message_stop/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});

test("CommandCode bridge validates tool arguments JSON and does not coerce invalid JSON to empty object", async () => {
  let mode = "streaming_invalid";
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    if (mode === "streaming_invalid") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: "call_bad", type: "function", function: { name: "danger", arguments: "{ invalid_json: " } }],
          },
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: {} }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    } else if (mode === "streaming_valid_empty") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: "call_empty", type: "function", function: { name: "noop", arguments: "{}" } }],
          },
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: {} }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    } else if (mode === "non_streaming_invalid") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_bad_sync", type: "function", function: { name: "danger", arguments: "not a json" } }],
          },
        }],
      }));
    }
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

    // 1. Streaming with invalid JSON -> must fail explicitly, never emit message_stop
    mode = "streaming_invalid";
    const res1 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "run" }] }),
    });
    const body1 = await res1.text();
    assert.match(body1, /event: error/);
    assert.match(body1, /Invalid tool call arguments JSON/);
    assert.doesNotMatch(body1, /event: message_stop/);

    // 2. Streaming with valid {} -> succeeds
    mode = "streaming_valid_empty";
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "run" }] }),
    });
    const body2 = await res2.text();
    assert.match(body2, /"type":"content_block_start"/);
    assert.match(body2, /"stop_reason":"tool_use"/);
    assert.match(body2, /event: message_stop/);

    // 3. Non-streaming with invalid JSON -> fails explicitly with HTTP 500, does not return input: {}
    mode = "non_streaming_invalid";
    const res3 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "run" }] }),
    });
    assert.equal(res3.status, 500);
    const body3 = await res3.json();
    assert.equal(body3.type, "error");
    assert.match(body3.error.message, /Invalid tool call arguments JSON/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});

test("CommandCode bridge explicitly fails on upstream HTTP error, SSE error, and stream cutoff without terminal state", async () => {
  let mode = "http_error";
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    if (mode === "http_error") {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Bad Gateway from CommandCode" } }));
    } else if (mode === "sse_error") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: error\ndata: {\"error\":{\"message\":\"Upstream model exploded\"}}\n\n");
      response.end();
    } else if (mode === "premature_cutoff") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Unfinished..." } }] })}\n\n`);
      response.destroy();
    }
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

    // 1. HTTP 502 error
    mode = "http_error";
    const res1 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res1.status, 502);
    const val1 = await res1.json();
    assert.equal(val1.error.message, "Bad Gateway from CommandCode");

    // 2. SSE error event
    mode = "sse_error";
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const text2 = await res2.text();
    assert.match(text2, /event: error/);
    assert.match(text2, /Upstream model exploded/);
    assert.doesNotMatch(text2, /event: message_stop/);

    // 3. Premature cutoff without terminal state
    mode = "premature_cutoff";
    const res3 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    let text3 = "";
    try {
      for await (const chunk of res3.body) {
        text3 += Buffer.from(chunk).toString("utf8");
      }
    } catch {}
    assert.doesNotMatch(text3, /event: message_stop/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("close", resolveExit));
    await close(upstream);
  }
});

test("CommandCode bridge aborts upstream request when downstream client disconnects", async () => {
  let upstreamAborted = false;
  let notifyAborted;
  const abortPromise = new Promise((resolveAbort) => { notifyAborted = resolveAbort; });

  const upstream = createServer(async (request, response) => {
    request.on("close", () => {
      if (!response.writableEnded) {
        upstreamAborted = true;
        notifyAborted();
      }
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "starting..." } }] })}\n\n`);
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
    const clientController = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-test-key" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "slow" }] }),
      signal: clientController.signal,
    });

    for await (const chunk of response.body) {
      if (Buffer.from(chunk).toString("utf8").includes("starting...")) {
        break;
      }
    }

    clientController.abort();

    await Promise.race([
      abortPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Upstream abort timeout")), 3000)),
    ]);

    assert.equal(upstreamAborted, true, "upstream request should be aborted when client disconnects");
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
