// node bench/onboarding/ripgit-timeline.mjs <run.json>: ripgit calls against model steps.
import { readFileSync } from "node:fs";
const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
const t0 = run.dismissedAt;
const events = [
  ...run.ripgit.filter((call) => call.at >= t0).map((call) => ({ at: call.at, text: `  ripgit ${call.method} ${call.path.replace("/hyperspace/repos/", "")}${decodeURIComponent(call.query)} ${call.status} ${call.ms}ms` })),
  ...run.steps.map((step) => ({ at: step.startedAt, text: `STEP ${step.index} ${step.totalMs}ms -> ${step.toolCalls.map((tool) => `${tool.name}:${tool.args.slice(0, 70)}`).join(" | ")}` })),
  ...run.ledger.filter((line) => line.pid && line.timestamp >= t0).map((line) => ({ at: line.timestamp, text: `  syscall ${line.call} ${line.durationMs}ms` })),
];
events.sort((a, b) => a.at - b.at);
for (const event of events) console.log(String(event.at - t0).padStart(6), event.text);
