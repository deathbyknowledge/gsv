import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(path, value) {
  ensureParent(path);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function appendCheck(path, name, status) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("check name is not sanitized");
  }
  if (!["passed", "failed", "skipped"].includes(status)) {
    throw new Error("invalid check status");
  }
  ensureParent(path);
  appendFileSync(path, `${JSON.stringify({ name, status, recorded_at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

const [command, path, ...args] = process.argv.slice(2);
try {
  if (command === "check") {
    appendCheck(path, args[0], args[1]);
  } else if (command === "summary") {
    const [runId, instance, release, stage, outcome, dirty, gatewayUrl] = args;
    writeJsonAtomic(path, {
      schema_version: 1,
      run_id: runId,
      instance,
      release,
      source_dirty: dirty === "true",
      final_stage: stage,
      outcome,
      gateway_url: gatewayUrl || null,
      finished_at: new Date().toISOString(),
    });
  } else {
    throw new Error("usage: results.mjs check|summary ...");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
