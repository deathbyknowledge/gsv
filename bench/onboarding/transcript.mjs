// node bench/onboarding/transcript.mjs <run.json> [chars]: reasoning, tool calls and tool results per step.
import { readFileSync } from "node:fs";
const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
const limit = Number(process.argv[3] ?? 400);
for (const step of run.steps) {
  console.log(`\n=== step ${step.index} in=${step.inputTokens} cached=${step.cachedTokens} out=${step.outputTokens} reason=${step.reasoningTokens}`);
  if (step.reasoningText) console.log(`think: ${step.reasoningText.slice(0, limit)}`);
  for (const call of step.toolCalls) console.log(`call ${call.name}: ${call.args.slice(0, limit)}`);
}
console.log("\n--- records");
for (const record of run.records) {
  const text = JSON.stringify(record);
  console.log(`${record.kind ?? record.type ?? "?"}: ${text.slice(0, limit)}`);
}
