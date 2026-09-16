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
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = usage.prompt_tokens ?? 0;
  const inputTokens = Math.max(0, promptTokens - cacheRead - cacheCreation);
  return {
    input_tokens: inputTokens,
    output_tokens: usage.completion_tokens ?? 0,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

function parseToolArguments(rawArgs, label = "") {
  const prefix = label ? `Invalid tool call arguments JSON for ${label}` : `Invalid tool call arguments JSON`;
  if (rawArgs === undefined || rawArgs === null || rawArgs === "") {
    return {};
  }
  if (typeof rawArgs === "object") {
    if (rawArgs === null || Array.isArray(rawArgs)) throw new Error(`${prefix}: arguments must be an object`);
    return rawArgs;
  }
  if (typeof rawArgs !== "string") {
    throw new Error(`${prefix}: invalid arguments type`);
  }
  const trimmed = rawArgs.trim();
  if (trimmed === "" || trimmed === "{}") {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${prefix}: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${prefix}: arguments must be an object`);
  }
  return parsed;
}

function contentBlocks(message = {}) {
  const content = [];
  if (message.content) content.push({ type: "text", text: String(message.content) });
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name ?? "";
    const id = call.id ?? "";
    const label = name ? `${name}${id ? ` (${id})` : ""}` : id;
    const input = parseToolArguments(call.function?.arguments, label);
    content.push({ type: "tool_use", id: call.id || `toolu_${randomUUID()}`, name, input });
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

function extractLines(buffer, isEnd = false) {
  const lines = [];
  let start = 0;
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] === "\r") {
      if (i + 1 < buffer.length) {
        if (buffer[i + 1] === "\n") {
          lines.push(buffer.slice(start, i));
          i += 2;
          start = i;
        } else {
          lines.push(buffer.slice(start, i));
          i += 1;
          start = i;
        }
      } else {
        if (isEnd) {
          lines.push(buffer.slice(start, i));
          start = i + 1;
        }
        break;
      }
    } else if (buffer[i] === "\n") {
      lines.push(buffer.slice(start, i));
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  return { lines, remaining: buffer.slice(start) };
}

async function handleStream(request, response, body, upstreamBody, controller) {
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(`${upstream.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    throw err;
  }

  if (!upstreamResponse.ok) {
    let errorObj;
    try { errorObj = await upstreamResponse.json(); } catch { errorObj = null; }
    const error = errorObj?.error ?? { type: "api_error", message: `CommandCode HTTP ${upstreamResponse.status}` };
    sendJson(response, upstreamResponse.status, { type: "error", error });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
  const model = body.model;
  sendEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let sseBuffer = "";
  const decoder = new TextDecoder();
  let nextBlockIndex = 0;
  let textBlock = null;
  const toolStates = new Map();
  let terminalFinishReason = null;
  let latestUsage = null;
  let streamCompleted = false;

  function finalizeStream() {
    if (streamCompleted) return;
    if (!terminalFinishReason) {
      throw new Error("Stream disconnected prematurely without terminal state");
    }

    if (textBlock && textBlock.started && !textBlock.stopped) {
      sendEvent(response, "content_block_stop", { type: "content_block_stop", index: textBlock.index });
      textBlock.stopped = true;
    }

    const tools = Array.from(toolStates.values()).sort((a, b) => (a.blockIndex ?? 0) - (b.blockIndex ?? 0));
    for (const tool of tools) {
      if (!tool.started && tool.name) {
        tool.blockIndex = nextBlockIndex++;
        if (!tool.id) tool.id = `toolu_${randomUUID().replaceAll("-", "")}`;
        sendEvent(response, "content_block_start", {
          type: "content_block_start",
          index: tool.blockIndex,
          content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
        });
        tool.started = true;
        if (tool.arguments.length > 0) {
          sendEvent(response, "content_block_delta", {
            type: "content_block_delta",
            index: tool.blockIndex,
            delta: { type: "input_json_delta", partial_json: tool.arguments },
          });
        }
      }
      if (tool.started && !tool.stopped) {
        const label = tool.name ? `${tool.name}${tool.id ? ` (${tool.id})` : ""}` : (tool.id ?? "");
        parseToolArguments(tool.arguments, label);
        sendEvent(response, "content_block_stop", { type: "content_block_stop", index: tool.blockIndex });
        tool.stopped = true;
      }
    }

    const reason = stopReason(terminalFinishReason);
    const usage = anthropicUsage(latestUsage ?? {});
    sendEvent(response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage,
    });
    sendEvent(response, "message_stop", { type: "message_stop" });
    response.end();
    streamCompleted = true;
  }

  function handleSseEvent(eventName, eventData) {
    if (eventName === "ping") {
      sendEvent(response, "ping", { type: "ping" });
      return;
    }
    if (eventData === "[DONE]") {
      finalizeStream();
      return;
    }
    if (!eventData || eventData.trim() === "") {
      return;
    }
    if (eventName === "error") {
      let msg = eventData;
      try {
        const parsedErr = JSON.parse(eventData);
        msg = parsedErr?.error?.message || parsedErr?.message || eventData;
      } catch {}
      throw new Error(msg || "Upstream SSE error");
    }
    let parsed;
    try {
      parsed = JSON.parse(eventData);
    } catch (err) {
      throw new Error(`Invalid SSE data JSON: ${err.message}`);
    }
    if (parsed.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }
    if (parsed.usage) {
      latestUsage = parsed.usage;
    }
    const choice = parsed.choices?.[0];
    if (!choice) return;

    if (choice.finish_reason) {
      terminalFinishReason = choice.finish_reason;
    }

    const delta = choice.delta ?? {};

    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thought;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      sendEvent(response, "ping", { type: "ping" });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!textBlock || textBlock.stopped) {
        const index = nextBlockIndex++;
        textBlock = { index, started: true, stopped: false };
        sendEvent(response, "content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        });
      }
      sendEvent(response, "content_block_delta", {
        type: "content_block_delta",
        index: textBlock.index,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      if (textBlock && textBlock.started && !textBlock.stopped) {
        sendEvent(response, "content_block_stop", { type: "content_block_stop", index: textBlock.index });
        textBlock.stopped = true;
      }

      for (const tc of delta.tool_calls) {
        const toolIndex = tc.index ?? 0;
        let toolState = toolStates.get(toolIndex);
        if (!toolState) {
          toolState = {
            upstreamIndex: toolIndex,
            blockIndex: null,
            id: tc.id || null,
            name: tc.function?.name || null,
            arguments: "",
            started: false,
            stopped: false,
          };
          toolStates.set(toolIndex, toolState);
        } else {
          if (tc.id && !toolState.id) toolState.id = tc.id;
          if (tc.function?.name && !toolState.name) toolState.name = tc.function.name;
        }

        const argsChunk = tc.function?.arguments;
        if (!toolState.started) {
          if (argsChunk) {
            toolState.arguments += argsChunk;
          }
          if (toolState.name) {
            if (!toolState.id) {
              toolState.id = `toolu_${randomUUID().replaceAll("-", "")}`;
            }
            toolState.blockIndex = nextBlockIndex++;
            sendEvent(response, "content_block_start", {
              type: "content_block_start",
              index: toolState.blockIndex,
              content_block: {
                type: "tool_use",
                id: toolState.id,
                name: toolState.name,
                input: {},
              },
            });
            toolState.started = true;
            if (toolState.arguments.length > 0) {
              sendEvent(response, "content_block_delta", {
                type: "content_block_delta",
                index: toolState.blockIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: toolState.arguments,
                },
              });
            }
          }
        } else {
          if (argsChunk) {
            toolState.arguments += argsChunk;
            sendEvent(response, "content_block_delta", {
              type: "content_block_delta",
              index: toolState.blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: argsChunk,
              },
            });
          }
        }
      }
    }
  }

  try {
    let currentEvent = null;
    const currentData = [];

    function processLines(lines) {
      for (const line of lines) {
        if (line === "") {
          if (currentData.length > 0 || currentEvent !== null) {
            handleSseEvent(currentEvent, currentData.join("\n"));
            currentEvent = null;
            currentData.length = 0;
          }
        } else if (line.startsWith("data:")) {
          currentData.push(line.slice(5).replace(/^\s/, ""));
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).replace(/^\s/, "");
        }
      }
    }

    for await (const chunk of upstreamResponse.body) {
      sseBuffer += decoder.decode(chunk, { stream: true });
      const { lines, remaining } = extractLines(sseBuffer, false);
      sseBuffer = remaining;
      processLines(lines);
    }

    sseBuffer += decoder.decode();
    if (sseBuffer.length > 0) {
      const { lines } = extractLines(sseBuffer, true);
      processLines(lines);
    }
    if (currentData.length > 0 || currentEvent !== null) {
      handleSseEvent(currentEvent, currentData.join("\n"));
      currentEvent = null;
      currentData.length = 0;
    }

    finalizeStream();
  } catch (err) {
    if (controller.signal.aborted || response.writableEnded) return;
    try {
      sendEvent(response, "error", {
        type: "error",
        error: { type: "api_error", message: err.message ?? "Stream error" },
      });
      response.end();
    } catch {
      response.destroy(err);
    }
  }
}

async function handleNonStream(request, response, body, upstreamBody, controller) {
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(`${upstream.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    throw err;
  }

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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMessages(request, response) {
  const body = await readBody(request);
  const tools = convertTools(body.tools);
  const isStream = Boolean(body.stream);
  const upstreamBody = {
    model: body.model,
    messages: convertMessages(body.system, body.messages),
    ...(tools.length > 0 ? { tools } : {}),
    reasoning_effort: effort,
    max_tokens: body.max_tokens ?? 65_536,
    stream: isStream,
    ...(isStream ? { stream_options: { include_usage: true } } : {}),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);
  const onClientClose = () => {
    if (!response.writableEnded) {
      controller.abort(new Error("Client disconnected"));
    }
  };
  request.on("close", onClientClose);
  response.on("close", onClientClose);

  try {
    if (isStream) {
      await handleStream(request, response, body, upstreamBody, controller);
    } else {
      await handleNonStream(request, response, body, upstreamBody, controller);
    }
  } finally {
    clearTimeout(timeoutId);
    request.off("close", onClientClose);
    response.off("close", onClientClose);
  }
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
    if (!response.headersSent) {
      sendJson(response, 500, { type: "error", error: { type: "api_error", message: error.message } });
    } else if (!response.writableEnded) {
      response.destroy(error);
    }
  }
});

server.listen(port, host);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
