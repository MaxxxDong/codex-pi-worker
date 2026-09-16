#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function executable(override, preferred, fallback) {
  if (override) return override;
  if (existsSync(preferred)) return preferred;
  return fallback;
}

function commandCodeKey() {
  const agent = process.env.PI_WORKER_AGENT_SOURCE
    ?? process.env.PI_CODING_AGENT_DIR
    ?? join(homedir(), ".pi", "agent");
  let auth;
  try {
    auth = JSON.parse(readFileSync(join(agent, "auth.json"), "utf8"));
  } catch {
    throw new Error(`Cannot read Pi authentication from ${join(agent, "auth.json")}`);
  }
  if (!auth.commandcode?.key) throw new Error("Pi CommandCode credential is missing");
  return auth.commandcode.key;
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function waitForPort(port, child, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error(`CommandCode proxy exited with ${child.exitCode}`));
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolveReady();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("CommandCode proxy did not become ready"));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return Promise.race([
    new Promise((resolveExit) => child.once("close", resolveExit)),
    new Promise((resolveExit) => setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveExit();
    }, 2_000)),
  ]);
}

async function main() {
  const key = commandCodeKey();
  const port = await reservePort();
  const localToken = randomBytes(32).toString("hex");
  const bridge = process.env.PI_WORKER_COMMANDCODE_BRIDGE
    ?? resolve(import.meta.dirname, "../lib/commandcode-anthropic-bridge.mjs");
  const claude = executable(
    process.env.PI_WORKER_CLAUDE_BIN,
    join(homedir(), ".local", "bin", "claude"),
    "claude",
  );
  const modelIndex = process.argv.findIndex((argument) => argument === "--model");
  const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : "deepseek/deepseek-v4-flash";
  const effortIndex = process.argv.findIndex((argument) => argument === "--effort");
  const effort = effortIndex >= 0 ? process.argv[effortIndex + 1] : "max";
  const proxyProcess = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      COMMANDCODE_BRIDGE_HOST: "127.0.0.1",
      COMMANDCODE_BRIDGE_PORT: String(port),
      COMMANDCODE_BRIDGE_KEY: localToken,
      COMMANDCODE_API_KEY: key,
      COMMANDCODE_REASONING_EFFORT: effort,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let proxyError = "";
  proxyProcess.stderr.setEncoding("utf8").on("data", (chunk) => {
    proxyError = `${proxyError}${chunk}`.slice(-4_096);
  });
  try {
    await waitForPort(port, proxyProcess);
  } catch (error) {
    await stop(proxyProcess);
    throw new Error(`${error.message}${proxyError ? `: ${proxyError.trim()}` : ""}`);
  }

  const claudeEnv = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: localToken,
    ANTHROPIC_AUTH_TOKEN: localToken,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: effort,
  };
  const claudeArgs = process.argv.slice(2);
  const promptIndex = claudeArgs.lastIndexOf("-p");
  claudeArgs.splice(promptIndex < 0 ? claudeArgs.length : promptIndex, 0, "--settings", JSON.stringify({ env: claudeEnv }));
  const claudeProcess = spawn(claude, claudeArgs, {
    env: { ...process.env, ...claudeEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const forward = (signal) => {
    if (claudeProcess.exitCode === null) claudeProcess.kill(signal);
    if (proxyProcess.exitCode === null) proxyProcess.kill(signal);
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  let outcome;
  try {
    outcome = await new Promise((resolveExit, reject) => {
      claudeProcess.once("error", reject);
      claudeProcess.once("close", (code, signal) => resolveExit({ code, signal }));
    });
  } finally {
    await stop(proxyProcess);
  }
  if (outcome.signal) process.kill(process.pid, outcome.signal);
  process.exitCode = outcome.code ?? 1;
}

main().catch((error) => {
  console.error(`Claude CommandCode launcher failed: ${error.message}`);
  process.exitCode = 1;
});
