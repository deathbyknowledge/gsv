// node bench/onboarding/why.mjs <label> [chars]: for each run, the reasoning and calls of every step, plus failed run-control results.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, "runs", process.argv[2]);
const limit = Number(process.argv[3] ?? 220);
for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
  const run = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
  console.log(`\n### ${run.lang}#${run.run} steps=${run.steps.length} first=${run.dismissToFirstMessageMs} end=${run.dismissToRunEndMs}`);
  for (const step of run.steps) {
    const calls = step.toolCalls.map((call) => `${call.name} ${call.args.slice(0, limit)}`).join(" || ");
    console.log(`  [${step.index}] think(${step.reasoningTokens}): ${(step.reasoningText ?? "").replace(/\s+/g, " ").slice(0, limit)}\n      -> ${calls}`);
  }
  for (const record of run.records) {
    if (record.kind === "result" && record.payload.outcome !== "completed") console.log(`  FAILED ${record.payload.tool}: ${JSON.stringify(record.payload.error ?? record.payload.output).slice(0, limit)}`);
    if (record.kind === "result" && record.payload.tool === "Shell" && record.payload.output?.exitCode) console.log(`  EXIT ${record.payload.output.exitCode}: ${String(record.payload.output.output).slice(0, limit)}`);
  }
}
