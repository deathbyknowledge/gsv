import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(toolDirectory, "..", "..");
const executable = process.platform === "win32"
  ? join(repositoryRoot, "node_modules", ".bin", "oxlint.cmd")
  : join(repositoryRoot, "node_modules", ".bin", "oxlint");
const baseline = JSON.parse(readFileSync(join(toolDirectory, "baseline.json"), "utf8"));

const oxlintArguments = [
  ".",
  "--deny-warnings",
  "--report-unused-disable-directives",
  "--format",
  "json",
];
if (process.argv.includes("--fix")) oxlintArguments.push("--fix");

const result = spawnSync(executable, oxlintArguments, {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (result.error) throw result.error;
if (!result.stdout) {
  process.stderr.write(result.stderr || "oxlint produced no report\n");
  process.exit(1);
}

const report = JSON.parse(result.stdout);
const current = new Map();
let errors = 0;
let warnings = 0;

for (const diagnostic of report.diagnostics) {
  const code = diagnostic.code || "<uncoded>";
  current.set(code, (current.get(code) || 0) + 1);
  if (diagnostic.severity === "error") errors += 1;
  if (diagnostic.severity === "warning") warnings += 1;
}

const regressions = [];
for (const [code, count] of current) {
  const allowed = baseline[code] || 0;
  if (count > allowed) regressions.push({ code, count, allowed });
}

console.log(
  `oxlint: ${errors} errors and ${warnings} warnings ` +
  `(${errors + warnings} baseline findings across ${report.number_of_files} files)`,
);

if (regressions.length > 0) {
  regressions.sort((left, right) => left.code.localeCompare(right.code));
  for (const regression of regressions) {
    console.error(
      `${regression.code}: ${regression.count} findings, baseline permits ${regression.allowed}`,
    );
  }
  process.exit(1);
}

if (result.stderr) process.stderr.write(result.stderr);
