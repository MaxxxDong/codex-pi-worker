import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function canonical(pathname) {
  let current = path.resolve(pathname);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    current = fs.realpathSync.native(current);
  } catch {}
  return path.resolve(current, ...suffix);
}

function isInside(candidate, parent) {
  const relative = path.relative(canonical(parent), canonical(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function referenced(command, pathname) {
  if (!pathname) return false;
  const haystack = command.toLowerCase().replaceAll("\\", "/");
  const needle = path.resolve(pathname).toLowerCase().replaceAll("\\", "/");
  const msys = needle.replace(/^([a-z]):/, "/$1");
  return haystack.includes(needle) || haystack.includes(msys);
}

const RECURSIVE_DELETE = [
  /\brm\b[^\r\n;&|]*(?:\s-[a-z]*r[a-z]*\b|\s--recursive\b)/i,
  /\b(?:remove-item|ri|rm)\b[^\r\n;|]*\s-recurse\b/i,
  /\b(?:rd|rmdir|del)\b[^\r\n&|]*\/s\b/i,
  /\bgit\s+clean\b[^\r\n;&|]*(?:-[a-z]*f[a-z]*d[a-z]*|-[a-z]*d[a-z]*f[a-z]*|--force[^\r\n;&|]*(?:-d|--directories)|(?:-d|--directories)[^\r\n;&|]*--force)/i,
  /\bshutil\.rmtree\s*\(/i,
  /\b(?:fs\.)?rm(?:Sync)?\s*\([^\r\n]*(?:recursive\s*:\s*true)/i,
  /\bDirectory\.Delete\s*\([^\r\n]*,\s*true\s*\)/i,
];

const DISK_DESTRUCTION = [
  /(?:^|[;&|]\s*)format(?:\.com)?\s+[a-z]:/i,
  /\b(?:clear-disk|initialize-disk)\b/i,
  /\bvssadmin\s+delete\b/i,
  /\bdiskpart(?:\.exe)?\b/i,
];

const MUTATION = /(?:^|[\s;&|()])(?:(?:rm|remove-item|del|erase|rd|rmdir|mv|move|cp|copy|touch|mkdir|new-item|set-content|add-content|out-file|tee)(?:\.exe|\.cmd|\.bat)?(?=$|[\s;&|()])|sed\s+-i\b|git(?:\.exe)?\s+(?:add|apply|checkout|restore|reset|clean|commit)\b)|(?:^|[^<])>{1,2}(?!>)/i;
const EXECUTION = /(?:^|[\s;&|()])(?:"?[^"'\s;&|()<>]*[\\/])?(?:python|py|node|npm|npx|pnpm|yarn|uv|pip|pytest|cargo|gradle|gradlew|mvn|dotnet)(?:\.exe|\.cmd|\.bat)?"?(?=$|[\s;&|()])/i;

function mutatesOrExecutes(command) {
  return MUTATION.test(command) || EXECUTION.test(command);
}

function outsideExecutionCwd(command, cwd) {
  const tokens = command.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s;&|<>]+/g) || [];
  return tokens.some((rawToken, index) => {
    let token = rawToken.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    const equals = token.indexOf("=");
    if (equals >= 0) token = token.slice(equals + 1);
    const previous = (tokens[index - 1] || "").replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    if (/^(?:\\|\/dev\/null|nul)$/i.test(token) || (token === "/" && previous === "tr")) return false;
    const msys = process.platform === "win32" && /^\/[a-z](?:\/|$)/i.test(token);
    if (msys) token = `${token[1]}:${token.slice(2)}`;
    const absolute = msys || path.isAbsolute(token) || path.win32.isAbsolute(token);
    const traverses = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(token);
    return (absolute || traverses) && !isInside(path.resolve(cwd, token), cwd);
  });
}

function isTrustedToolExecution(command, cwd, home, policy) {
  let quote = "";
  for (const char of command) {
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? "" : char;
    } else if (!quote && ";&|<>".includes(char)) {
      return false;
    }
  }
  const tokens = command.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) || [];
  const clean = tokens.map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
  if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(clean[0] || "")) return false;
  const agentDir = policy.agentDir || process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const trusted = path.join(agentDir, "npm", "node_modules", "pi-playwright", "skills", "playwright-browser", "scripts");
  if (!clean[1] || !isInside(clean[1], trusted)) return false;
  return clean.slice(2).every((token) => {
    const absolute = path.isAbsolute(token) || path.win32.isAbsolute(token);
    return !absolute || isInside(token, cwd);
  });
}

function literalDeleteTarget(command) {
  const patterns = [
    /^rm\s+-[a-z]*r[a-z]*\s+(?:--\s+)?(.+)$/i,
    /^Remove-Item\s+-LiteralPath\s+(.+?)\s+-Recurse(?:\s+-Force)?$/i,
    /^(?:cmd(?:\.exe)?\s+\/c\s+)?(?:rd|rmdir)\s+\/s(?:\s+\/q)?\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = command.trim().match(pattern);
    if (!match) continue;
    const token = match[1].trim();
    if (!/^(?:"[^"]+"|'[^']+'|[^\s;&|<>*?$%]+)$/.test(token)) return null;
    return token.replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
  }
  return null;
}

function isSafeRecursiveDelete(command, cwd) {
  const target = literalDeleteTarget(command);
  if (!target) return false;
  const resolved = canonical(path.resolve(cwd, target));
  return resolved !== canonical(cwd) && isInside(resolved, cwd);
}

export function evaluateToolCall(toolName, input = {}, policy = {}) {
  const cwd = path.resolve(policy.cwd || process.env.PI_WORKER_EXECUTION_CWD || process.cwd());
  const sourceCwd = policy.sourceRoot || process.env.PI_WORKER_SOURCE_ROOT
    || policy.sourceCwd || process.env.PI_WORKER_SOURCE_CWD || "";
  const home = policy.home || os.homedir();

  if (toolName === "write" || toolName === "edit" || toolName === "ast_grep_replace") {
    const requested = input.path ?? input.file_path ?? input.filePath;
    if (!requested || !isInside(path.resolve(cwd, requested), cwd)) {
      return `Blocked write outside execution worktree: ${requested || "<missing path>"}`;
    }
    return null;
  }

  if (toolName !== "bash") return null;
  const command = String(input.command ?? "");
  if (RECURSIVE_DELETE.some((pattern) => pattern.test(command)) && !isSafeRecursiveDelete(command, cwd)) {
    return "Blocked unsafe recursive deletion; use one literal path strictly inside the execution worktree";
  }
  if (DISK_DESTRUCTION.some((pattern) => pattern.test(command))) {
    return "Blocked destructive disk/system command";
  }
  if (isTrustedToolExecution(command, cwd, home, policy)) return null;
  const protectedReference = referenced(command, sourceCwd)
    || referenced(command, home)
    || /(?:\$HOME|%USERPROFILE%|\$env:USERPROFILE)/i.test(command);
  if (protectedReference && mutatesOrExecutes(command)) {
    return "Blocked mutation or command execution against source checkout/home; read-only inspection is allowed";
  }
  // This is a narrow policy guard for obvious paths, not an OS sandbox or shell parser.
  if (mutatesOrExecutes(command) && outsideExecutionCwd(command, cwd)) {
    return "Blocked mutation or command execution outside the execution worktree";
  }
  return null;
}

export default function piWorkerGuard(pi) {
  pi.on("tool_call", async (event) => {
    const reason = evaluateToolCall(event.toolName, event.input);
    return reason ? { block: true, reason } : undefined;
  });
}
