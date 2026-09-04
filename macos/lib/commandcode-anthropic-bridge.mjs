#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const host = process.env.COMMANDCODE_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.COMMANDCODE_BRIDGE_PORT ?? 0);
const clientKey = process.env.COMMANDCODE_BRIDGE_KEY;
const upstreamKey = process.env.COMMANDCODE_API_KEY;
const upstream = process.env.COMMANDCODE_BASE_URL ?? "https://api.commandcode.ai/provider/v1";
const effort = process.env.COMMANDCODE_REASONING_EFFORT ?? "max";
const timeoutMs = Number(process.env.COMMANDCODE_REQUEST_TIMEOUT_MS ?? 86_400_000);

if (!clientKey || !upstreamKey || !Number.isInteger(port) || port <= 0) {
  console.error("CommandCode bridge requires client key, upstream key, and a positive port");
  process.exit(1);
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("\n");
}

function systemText(system) {
  return textContent(system);
}

function convertMessages(system, messages) {
  const converted = [];
  const systemMessage = systemText(system);
  if (systemMessage) converted.push({ role: "system", content: systemMessage });
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) {
      converted.push({ role: message.role === "assistant" ? "assistant" : "user", content: textContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const text = textContent(message.content);
      const toolCalls = message.content.filter((block) => block?.type === "tool_use").map((block) => ({
        id: block.id || `call_${randomUUID()}`,
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      }));
      converted.push({ role: "assistant", content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const toolResults = message.content.filter((block) => block?.type === "tool_result");
    for (const result of toolResults) {
      converted.push({ role: "tool", tool_call_id: result.tool_use_id ?? "", content: textContent(result.content) });
    }
    const text = textContent(message.content);
    if (text || toolResults.length === 0) converted.push({ role: "user", content: text });
  }
  return converted;
}

function convertTools(tools) {
  return (tools ?? []).filter((tool) => tool?.name && tool?.input_schema).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema,
    },
  }));
}

function anthropicUsage(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
  };
}

function contentBlocks(message = {}) {
  const content = [];
  if (message.content) content.push({ type: "text", text: String(message.content) });
  for (const call of message.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: call.id || `toolu_${randomUUID()}`, name: call.function?.name ?? "", input });
  }
  return content;
}

function stopReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendEvent(response, event, value) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function sendStream(response, messageId, model, blocks, reason, usage) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sendEvent(response, "message_start", {
    type: "message_start",
    message: { id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } },
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      sendEvent(response, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      sendEvent(response, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      sendEvent(response, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      sendEvent(response, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    }
    sendEvent(response, "content_block_stop", { type: "content_block_stop", index });
  });
  sendEvent(response, "message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  sendEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMessages(request, response) {
  const body = await readBody(request);
  const tools = convertTools(body.tools);
  const upstreamBody = {
    model: body.model,
    messages: convertMessages(body.system, body.messages),
    ...(tools.length > 0 ? { tools } : {}),
    reasoning_effort: effort,
    max_tokens: body.max_tokens ?? 65_536,
    stream: false,
  };
  const upstreamResponse = await fetch(`${upstream.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let value;
  try { value = await upstreamResponse.json(); } catch { value = {}; }
  if (!upstreamResponse.ok) {
    const error = value?.error ?? { type: "api_error", message: `CommandCode HTTP ${upstreamResponse.status}` };
    sendJson(response, upstreamResponse.status, { type: "error", error });
    return;
  }
  const choice = value.choices?.[0] ?? {};
  const blocks = contentBlocks(choice.message);
  const usage = anthropicUsage(value.usage);
  const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
  const model = value.model ?? body.model;
  const reason = stopReason(choice.finish_reason);
  if (body.stream) {
    sendStream(response, messageId, model, blocks, reason, usage);
    return;
  }
  sendJson(response, 200, {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: reason,
    stop_sequence: null,
    usage,
  });
}

const server = createServer(async (request, response) => {
  try {
    const token = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || String(request.headers["x-api-key"] ?? "");
    if (token !== clientKey) return sendJson(response, 401, { type: "error", error: { type: "authentication_error", message: "Invalid local bridge key" } });
    const path = new URL(request.url, "http://localhost").pathname.replace(/^\/v1\/v1\//, "/v1/");
    if (request.method === "POST" && path.endsWith("/messages/count_tokens")) {
      const body = await readBody(request);
      const size = Buffer.byteLength(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools }));
      return sendJson(response, 200, { input_tokens: Math.max(1, Math.ceil(size / 4)) });
    }
    if (request.method === "POST" && (path === "/v1/messages" || path === "/messages")) return await handleMessages(request, response);
    if (request.method === "GET" && (path === "/health" || path === "/")) return sendJson(response, 200, { status: "ok" });
    return sendJson(response, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
  } catch (error) {
    sendJson(response, 500, { type: "error", error: { type: "api_error", message: error.message } });
  }
});

server.listen(port, host);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
