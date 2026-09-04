import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const AGY_EFFORTS = ["low", "medium", "high"];
const OWNED_FLAGS = new Set([
  "--conversation",
  "--continue",
  "--effort",
  "--input-format",
  "--log-file",
  "--mode",
  "--model",
  "--output-format",
  "--print",
  "--print-timeout",
  "--prompt",
  "--thinking",
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
    if (!argument.includes("=") && !["-c", "--continue"].includes(name)) {
      if (args[index + 1] && !args[index + 1].startsWith("-")) index += 1;
    }
  }
  return result;
}

function inferredEffort(model) {
  return AGY_EFFORTS.find((effort) => model.endsWith(`-${effort}`)) ?? "high";
}

export function selectAgy(args) {
  const model = optionValues(args, ["--model"]).at(-1);
  if (!model) throw new Error("Agy backend requires explicit --model");
  const effortValues = [
    ...optionValues(args, ["--effort"]),
    ...optionValues(args, ["--thinking"]),
  ];
  const effort = effortValues.at(-1) ?? inferredEffort(model);
  if (!AGY_EFFORTS.includes(effort)) throw new Error(`Agy effort must be one of: ${AGY_EFFORTS.join(", ")}`);
  return { args: withoutOwnedFlags(args), model, thinking: effort };
}

export function agyLauncher() {
  if (process.env.AGY_WORKER_LAUNCHER) return process.env.AGY_WORKER_LAUNCHER;
  const local = join(homedir(), ".local", "bin", "agy");
  return existsSync(local) ? local : "agy";
}

export function agyLaunchArgs({ args, prompt, mode, hardTimeoutSeconds, conversationId = null }) {
  const timeout = hardTimeoutSeconds > 0 ? `${Math.ceil(hardTimeoutSeconds)}s` : "24h";
  return [
    ...args,
    "--model", mode.model,
    "--effort", mode.thinking,
    "--output-format", "stream-json",
    "--print-timeout", timeout,
    "--mode", mode.readOnly ? "plan" : "accept-edits",
    ...(conversationId ? ["--conversation", conversationId] : []),
    "-p", prompt,
  ];
}

function toolName(step) {
  return step?.tool_name ?? step?.toolName ?? step?.name ?? step?.step_type ?? null;
}

function isToolStep(step) {
  return /(?:tool|command|browser|mcp|search|file)/i.test(String(toolName(step) ?? ""));
}

function addTool(tools, step) {
  const name = toolName(step);
  let tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    tool = { name, count: 0, errorCount: 0 };
    tools.push(tool);
  }
  tool.count += 1;
  if (/ERROR|FAILED/i.test(String(step?.state ?? ""))) tool.errorCount += 1;
}

export async function summarizeAgyStream(stream, { onActivity, onAttention, onSettled, classifyAttention }) {
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
  };
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.event === "init") {
        summary.conversationId = event.conversation_id ?? event.init?.conversation_id ?? null;
        summary.lastAssistant = {
          provider: "agy",
          model: event.init?.model ?? null,
          stopReason: null,
          error: null,
          usage: null,
          text: "",
        };
        onActivity({ type: "backend_init" });
        continue;
      }
      if (event.event === "step_update") {
        const step = event.step_update ?? {};
        if (step.step_type === "agent_response" && step.state === "DONE") summary.assistantCalls += 1;
        if (isToolStep(step)) {
          const terminal = /DONE|ERROR|FAILED/i.test(String(step.state ?? ""));
          if (terminal) addTool(summary.tools, step);
          onActivity({
            type: terminal ? "tool_execution_end" : "tool_execution_start",
            toolCallId: step.step_index ?? step.id,
            toolName: toolName(step),
            isError: /ERROR|FAILED/i.test(String(step.state ?? "")),
          });
        } else {
          onActivity({ type: "backend_step" });
        }
        continue;
      }
      if (event.event !== "result") {
        onActivity({ type: event.event ?? "backend_event" });
        continue;
      }
      const result = event.result ?? {};
      const status = String(result.status ?? "").toUpperCase();
      const success = ["SUCCESS", "DONE", "COMPLETED"].includes(status);
      const response = String(result.response ?? "");
      const deniedActionCount = Array.isArray(result.denied_actions) ? result.denied_actions.length : 0;
      const deniedError = success && !response.trim() && deniedActionCount > 0
        ? `Agy denied ${deniedActionCount} required action${deniedActionCount === 1 ? "" : "s"}; grant the required permission or explicitly allow trusted tools.`
        : null;
      const error = deniedError ?? (success ? null : (result.error || `agy status ${status || "ERROR"}`));
      summary.settled = true;
      summary.backendStatus = status || null;
      summary.backendDeniedActionCount = deniedActionCount;
      summary.conversationId = result.conversation_id ?? summary.conversationId;
      summary.usage = result.usage ?? {};
      summary.backendTurns = Number.isFinite(Number(result.num_turns)) ? Number(result.num_turns) : null;
      if (summary.assistantCalls === 0) summary.assistantCalls = summary.backendTurns ?? 0;
      summary.structuredOutput = result.structured_output ?? null;
      summary.lastAssistant = {
        provider: "agy",
        model: summary.lastAssistant?.model ?? null,
        stopReason: error ? "error" : "stop",
        error,
        usage: result.usage ?? null,
        text: response,
      };
      const category = classifyAttention(error);
      if (category) onAttention(category, error);
      onActivity({ type: "agent_settled" });
      onSettled();
    } catch {
      // Malformed stdout cannot prove completion and is intentionally not retained.
    }
  }
  return summary;
}

export const AGY_PROFILES = {
  efforts: AGY_EFFORTS,
  defaultEffort: "high",
};
