import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(toolDirectory, "..", "..");
const executable = process.platform === "win32"
  ? join(repositoryRoot, "node_modules", ".bin", "oxlint.cmd")
  : join(repositoryRoot, "node_modules", ".bin", "oxlint");
const baselinePath = join(toolDirectory, "baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const result = spawnSync(executable, [
  ".",
  "--deny-warnings",
  "--report-unused-disable-directives",
  "--format",
  "json",
], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (result.error) throw result.error;
const report = JSON.parse(result.stdout);
const current = new Map();
for (const diagnostic of report.diagnostics) {
  const code = diagnostic.code || "<uncoded>";
  current.set(code, (current.get(code) || 0) + 1);
}

for (const [code, count] of current) {
  const allowed = baseline[code] || 0;
  if (count > allowed) {
    throw new Error(`${code} increased from ${allowed} to ${count}`);
  }
}

const next = Object.fromEntries([...current].sort(([left], [right]) => left.localeCompare(right)));
writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
console.log(`Ratchet now permits ${report.diagnostics.length} findings`);
