// Minimal bounded helpers for backend stdout/stderr scanning.
// Never retains the full stream; only small bounded windows/counters.
export const STDOUT_CORRUPTION_THRESHOLD = 5;
const SCAN_WINDOW_BYTES = 8192;

const NORMAL_BANNER_PATTERN = /^(?:\[?(?:info|debug|warn(?:ing)?|notice|log|trace)\]?[:\s]|\d{4}[-/]\d{2}[-/]\d{2}|\[\d{4}[-/]\d{2}[-/]\d{2}|[#*=\-_~]{3,}|(?:#+\s+)?(?:pi-worker|claude|agy|worker|starting|initializing|initialized|loading|ready|welcome|version|connected|connecting|listening|session|resuming|running)\b)/i;

function isNormalBanner(text) {
  return NORMAL_BANNER_PATTERN.test(text);
}

export function isCorruptedJson(text) {
  return /^\s*[{[]/.test(text) || /"(?:type|event|id|session_id|step_update|result|status)"\s*:/i.test(text);
}

export function createStdoutScan({ classifyAttention, threshold = STDOUT_CORRUPTION_THRESHOLD } = {}) {
  let consecutive = 0;
  let notified = false;
  return {
    noteSuccess() {
      consecutive = 0;
      notified = false;
    },
    noteLine(line) {
      const text = String(line ?? "").trim();
      if (!text) return null;
      const category = classifyAttention?.(text) ?? null;
      if (category) {
        consecutive = 0;
        notified = false;
        return { category, detail: text.slice(0, 2000) };
      }
      if (isNormalBanner(text)) {
        return null;
      }
      if (isCorruptedJson(text)) {
        if (!notified) {
          notified = true;
          return { category: "transport", detail: `Backend stream had corrupted JSON protocol frame; line: ${text.slice(0, 500)}` };
        }
        return null;
      }
      consecutive += 1;
      if (consecutive >= threshold && !notified) {
        notified = true;
        return { category: "transport", detail: `Backend stream had ${consecutive} consecutive non-JSON lines; last line: ${text.slice(0, 500)}` };
      }
      return null;
    },
  };
}

export function createStderrScan({ classifyAttention, windowBytes = SCAN_WINDOW_BYTES } = {}) {
  let buffer = "";
  const seen = new Set();
  return {
    push(chunk) {
      const text = String(chunk ?? "");
      if (!text) return null;
      buffer = (buffer + text).slice(-windowBytes);
      const category = classifyAttention?.(buffer) ?? null;
      if (category) {
        const detail = buffer.slice(-2000);
        buffer = "";
        const key = `${category}:${detail}`;
        if (!seen.has(key)) {
          seen.add(key);
          return { category, detail };
        }
      }
      return null;
    },
  };
}
