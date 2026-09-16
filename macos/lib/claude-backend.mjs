import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createStdoutScan, isCorruptedJson } from "./stream-scan.mjs";
import { nextRetryCount, parseRetryAttempt } from "./retry-policy.mjs";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OWNED_FLAGS = new Set([
  "--background",
  "--bg",
  "--continue",
  "--effort",
  "--input-format",
  "--model",
  "--no-session-persistence",
  "--output-format",
  "--permission-mode",
  "--print",
  "--provider",
  "--resume",
  "--session-id",
  "--settings",
  "--thinking",
  "--worktree",
  "-c",
  "-p",
  "-r",
  "-w",
]);
const BOOLEAN_OWNED_FLAGS = new Set([
  "--allow-orchestration",
  "--background",
  "--bg",
  "--continue",
  "--no-session-persistence",
  "--print",
  "-c",
  "-p",
]);

function optionValues(args, names) {
  const wanted = new Set(names);
  const values = [];
  args.forEach((argument, index) => {
    const [name, inline] = argument.split("=", 2);
    if (!wanted.has(name)) return;
    if (inline !== undefined) values.push(inline);
    else if (args[index + 1] && !args[index + 1].startsWith("-")) values.push(args[index + 1]);
  });
  return values;
}

function withoutOwnedFlags(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const name = argument.split("=", 1)[0];
    if (!OWNED_FLAGS.has(name)) {
      result.push(argument);
      continue;
    }
    if (!argument.includes("=") && !BOOLEAN_OWNED_FLAGS.has(name)) {
      if (args[index + 1] && !args[index + 1].startsWith("-")) index += 1;
    }
  }
  return result;
}

export function selectClaude(args) {
  const allowOrchestration = args.includes("--allow-orchestration");
  const provider = optionValues(args, ["--provider"]).at(-1) ?? "commandcode";
  if (!["commandcode", "native"].includes(provider)) {
    throw new Error("Claude provider must be commandcode or native");
  }
  const model = optionValues(args, ["--model"]).at(-1)
    ?? (provider === "commandcode" ? "deepseek/deepseek-v4-flash" : null);
  const effort = optionValues(args, ["--effort", "--thinking"]).at(-1) ?? "max";
  if (!CLAUDE_EFFORTS.includes(effort)) {
    throw new Error(`Claude effort must be one of: ${CLAUDE_EFFORTS.join(", ")}`);
  }
  return { args: withoutOwnedFlags(args), provider, model, thinking: effort, allowOrchestration };
}

export function claudeLauncher(provider) {
  if (process.env.CLAUDE_WORKER_LAUNCHER) return process.env.CLAUDE_WORKER_LAUNCHER;
  if (provider === "commandcode") return resolve(import.meta.dirname, "../bin/claude-commandcode-launcher.mjs");
  const local = join(homedir(), ".local", "bin", "claude");
  return existsSync(local) ? local : "claude";
}

export function claudeLaunchArgs({ args, prompt, mode, conversationId = null, systemPrompt, allowOrchestration = false }) {
  const bypass = args.includes("--dangerously-skip-permissions");
  const orchestrationTools = "Agent,TaskCreate,TaskGet,TaskList,TaskOutput,TaskStop,TaskUpdate,ListAgents,SendMessage,Monitor,CronCreate,CronDelete,ScheduleWakeup,PushNotification,Workflow";
  return [
    ...args,
    ...(mode.model ? ["--model", mode.model] : []),
    "--effort", mode.thinking,
    "--input-format", "text",
    "--output-format", "stream-json",
    "--verbose",
    ...(!bypass ? ["--permission-mode", mode.permissionMode] : []),
    ...(!allowOrchestration ? ["--disallowedTools", orchestrationTools] : []),
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ...(conversationId ? ["--resume", conversationId] : []),
    "-p", prompt,
  ];
}

function toolEntry(tools, name) {
  let tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    tool = { name, count: 0, errorCount: 0 };
    tools.push(tool);
  }
  return tool;
}

function resultError(event, backendName) {
  if (event.subtype === "success" && event.is_error !== true) return null;
  if (typeof event.error === "string" && event.error) return event.error;
  if (Array.isArray(event.errors) && event.errors.length > 0) return event.errors.map(String).join("; ");
  if (event.is_error === true && typeof event.result === "string" && event.result) return event.result;
  return `${backendName} result ${event.subtype || "error"}`;
}

function retryErrorText(event) {
  const candidates = [event.error, event.message, event.last_error];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
    if (candidate && typeof candidate.message === "string" && candidate.message) return candidate.message;
  }
  return "";
}

function describeApiRetry(event, backendName) {
  const attempt = event.attempt ?? event.retry_attempt ?? event.retryAttempt ?? null;
  const status = event.status ?? event.status_code ?? event.statusCode ?? null;
  const error = retryErrorText(event).slice(0, 300) || "unknown error";
  const hasAttempt = attempt !== null && attempt !== undefined && String(attempt).trim() !== "" && Number.isFinite(Number(attempt));
  const attemptText = hasAttempt ? `attempt ${attempt}` : "retrying";
  const statusText = status !== null && status !== undefined && String(status) ? ` (status ${String(status).slice(0, 32)})` : "";
  return `${backendName === "claude" ? "Claude" : backendName} API retry ${attemptText}${statusText}: ${error}`;
}

export async function summarizeClaudeStream(stream, { onActivity, onAttention, onSettled, classifyAttention, backendName = "claude" }) {
  const toolCalls = new Map();
  const summary = {
    settled: false,
    lastAssistant: null,
    usage: {},
    assistantCalls: 0,
    tools: [],
    playwrightUsed: false,
    conversationId: null,
    structuredOutput: null,
    backendStatus: null,
    backendTurns: null,
    backendDeniedActionCount: 0,
    providerRetryCount: null,
  };
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const scan = createStdoutScan({ classifyAttention });
  for await (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Malformed stdout cannot prove completion and is intentionally not retained.
      const hit = scan.noteLine(line);
      if (hit) onAttention(hit.category, hit.detail);
      if (isCorruptedJson(line)) {
        throw new Error(`Corrupted protocol JSON: malformed JSON frame; line: ${String(line ?? "").trim().slice(0, 200)}`);
      }
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`Corrupted protocol frame: expected non-null object, got ${event === null ? "null" : Array.isArray(event) ? "array" : typeof event}`);
    }
    scan.noteSuccess();
    if (event.parent_tool_use_id) {
      onActivity({ type: `${backendName}_child_event` });
      continue;
    }
    summary.conversationId = event.session_id ?? summary.conversationId;
    if (event.type === "system") {
      if (event.subtype === "permission_denied") {
        onAttention("permission_denied", `${backendName} denied ${event.tool_name ?? event.tool?.name ?? "a required tool"}`);
      }
      if (event.subtype === "api_retry") {
        summary.providerRetryCount = nextRetryCount(summary.providerRetryCount, parseRetryAttempt(event));
        onAttention("provider_retry", describeApiRetry(event, backendName));
      }
      onActivity({ type: event.subtype === "init" ? "backend_init" : `${backendName}_${event.subtype ?? "system"}` });
      continue;
    }
    if (event.type === "assistant") {
      summary.assistantCalls += 1;
      const message = event.message ?? {};
      const text = [];
      for (const block of message.content ?? []) {
        if (block.type === "text") text.push(String(block.text ?? ""));
        if (block.type !== "tool_use") continue;
        const id = String(block.id ?? `${block.name ?? "tool"}-${summary.assistantCalls}`);
        const name = block.name ?? "unknown";
        toolCalls.set(id, name);
        toolEntry(summary.tools, name).count += 1;
        onActivity({ type: "tool_execution_start", toolCallId: id, toolName: name });
      }
      summary.lastAssistant = {
        provider: backendName,
        model: message.model ?? summary.lastAssistant?.model ?? null,
        stopReason: message.stop_reason ?? null,
        error: null,
        usage: message.usage ?? null,
        text: text.join("\n"),
      };
      onActivity({ type: "message_end", message: { role: "assistant" } });
      continue;
    }
    if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const id = String(block.tool_use_id ?? "unknown");
        const name = toolCalls.get(id) ?? "unknown";
        const isError = block.is_error === true;
        if (isError) toolEntry(summary.tools, name).errorCount += 1;
        toolCalls.delete(id);
        onActivity({ type: "tool_execution_end", toolCallId: id, toolName: name, isError });
      }
      continue;
    }
    if (event.type !== "result") {
      onActivity({ type: `${backendName}_${event.type ?? "event"}` });
      continue;
    }
    const error = resultError(event, backendName);
    summary.settled = true;
    summary.backendStatus = String(error ? "error" : (event.subtype ?? "success")).toUpperCase();
    summary.backendTurns = Number.isFinite(Number(event.num_turns)) ? Number(event.num_turns) : null;
    summary.assistantCalls = Math.max(summary.assistantCalls, summary.backendTurns ?? 0);
    summary.structuredOutput = event.structured_output ?? null;
    summary.usage = {
      ...(event.usage ?? {}),
      ...(Number.isFinite(event.total_cost_usd) ? { total_cost_usd: event.total_cost_usd } : {}),
      ...(Number.isFinite(event.duration_ms) ? { duration_ms: event.duration_ms } : {}),
      ...(Number.isFinite(event.duration_api_ms) ? { duration_api_ms: event.duration_api_ms } : {}),
    };
    summary.lastAssistant = {
      provider: backendName,
      model: summary.lastAssistant?.model ?? null,
      stopReason: error ? "error" : "stop",
      error,
      usage: event.usage ?? summary.lastAssistant?.usage ?? null,
      text: String(event.result ?? summary.lastAssistant?.text ?? ""),
    };
    const category = classifyAttention(error);
    if (category) onAttention(category, error);
    onActivity({ type: "agent_settled" });
    onSettled();
  }
  return summary;
}

export const CLAUDE_PROFILES = {
  efforts: CLAUDE_EFFORTS,
  defaultEffort: "max",
};
