import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const BROWSER_STEPS = Object.freeze([
  "open-setup",
  "enter-account",
  "enter-system",
  "submit-review",
  "complete-setup",
  "reload-desktop",
  "lock-session",
  "reject-wrong-password",
  "recover-session",
]);

const STEP_SET = new Set(BROWSER_STEPS);
const OUTCOMES = new Set(["started", "passed", "failed"]);
const ERROR_CLASSES = new Set([
  "none",
  "assertion",
  "timeout",
  "browser-closed",
  "aborted",
  "unexpected",
]);

function hasOwnObject(value, property) {
  return value !== null
    && typeof value === "object"
    && Object.prototype.hasOwnProperty.call(value, property)
    && typeof value[property] === "object"
    && value[property] !== null;
}

export function classifyBrowserError(error) {
  try {
    if (hasOwnObject(error, "matcherResult")) {
      return "assertion";
    }
    const name = error !== null && typeof error === "object" && typeof error.name === "string"
      ? error.name
      : "";
    if (name === "TimeoutError") {
      return "timeout";
    }
    if (name === "TargetClosedError") {
      return "browser-closed";
    }
    if (name === "AbortError") {
      return "aborted";
    }
  } catch {
    return "unexpected";
  }
  return "unexpected";
}

function retainedBrowserEvent(event) {
  if (!STEP_SET.has(event?.step)) {
    throw new Error("browser diagnostic step is invalid");
  }
  if (!OUTCOMES.has(event?.outcome)) {
    throw new Error("browser diagnostic outcome is invalid");
  }
  if (!ERROR_CLASSES.has(event?.error_class)) {
    throw new Error("browser diagnostic error class is invalid");
  }
  if (event.outcome === "failed" && event.error_class === "none") {
    throw new Error("failed browser diagnostic requires an error class");
  }
  if (event.outcome !== "failed" && event.error_class !== "none") {
    throw new Error("non-failed browser diagnostic cannot have an error class");
  }
  return {
    step: event.step,
    outcome: event.outcome,
    error_class: event.error_class,
  };
}

export function recordBrowserEvent(path, event) {
  const retained = retainedBrowserEvent(event);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(retained)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function tryRecord(record, path, event) {
  try {
    record(path, event);
  } catch {
    // Diagnostics are best-effort and must not change the browser scenario.
  }
}

export function createBrowserStepRunner(path, record = recordBrowserEvent) {
  return async function runBrowserStep(step, action) {
    tryRecord(record, path, { step, outcome: "started", error_class: "none" });
    try {
      const result = await action();
      tryRecord(record, path, { step, outcome: "passed", error_class: "none" });
      return result;
    } catch (error) {
      tryRecord(record, path, {
        step,
        outcome: "failed",
        error_class: classifyBrowserError(error),
      });
      throw error;
    }
  };
}
