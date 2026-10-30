// node bench/onboarding/show.mjs <run.json>: print one run's timeline.
import { readFileSync } from "node:fs";
const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(`${run.label} ${run.lang}#${run.run} ok=${run.ok} state=${run.responsibilityState} setup=${run.setupMs} toFirstReq=${run.dismissToFirstRequestMs} toFirstMsg=${run.dismissToFirstMessageMs} toEnd=${run.dismissToRunEndMs}`);
const t0 = run.steps[0]?.startedAt ?? 0;
for (const step of run.steps) {
  console.log(`step ${step.index} t=${step.startedAt - t0} ttfb=${step.firstByteMs} firstThink=${step.firstReasoningMs} firstText=${step.firstTextMs} firstTool=${step.firstToolDeltaMs} total=${step.totalMs} in=${step.inputTokens} cached=${step.cachedTokens} out=${step.outputTokens} reason=${step.reasoningTokens} effort=${step.reasoningEffort} sys=${step.systemChars} tools=${step.toolNames.join("/")} model=${step.model} ${step.error ?? ""}`);
  if (step.text) console.log(`   text: ${step.text.slice(0, 300)}`);
  for (const call of step.toolCalls) console.log(`   ${call.name}: ${call.args.slice(0, 700)}`);
}
console.log("-- ledger");
for (const line of run.ledger) {
  if (t0 && line.timestamp < t0 - 3000) continue;
  console.log(`t=${line.timestamp - t0} ${line.call} target=${line.target} dur=${line.durationMs} ${JSON.stringify(line.outcome)} ${String(line.args).slice(0, 180)}`);
}
console.log("-- messages");
for (const message of run.messages) console.log(message);
