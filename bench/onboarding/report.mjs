// node bench/onboarding/report.mjs <label>...: summarise runs by label.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function quantile(values, q) {
  const sorted = values.filter((value) => value !== null && value !== undefined).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
const cell = (values, unit = 1) => {
  const med = quantile(values, 0.5);
  const p90 = quantile(values, 0.9);
  return med === null ? "-" : `${Math.round(med / unit * 10) / 10} / ${Math.round(p90 / unit * 10) / 10}`;
};

const LANG = {
  en: /\b(i'm|the|your|tell me|about)\b/i,
  es: /\b(soy|tu|cuéntame|cuentame|sobre|hola|puedo)\b/i,
  de: /\b(ich|bin|dein|deine|erzähl|über|und)\b/i,
  fr: /\b(je|suis|votre|ton|bonjour|parle)\b/i,
  ja: /[぀-ヿ]/,
};

function classify(call) {
  if (call.name !== "Shell") return call.name;
  let input = "";
  try { input = JSON.parse(call.args).input ?? ""; } catch { input = call.args; }
  const commands = input.split(/&&|;|\||\n/).map((part) => part.trim().split(/\s+/).slice(0, 2).join(" ")).filter(Boolean);
  return commands.map((command) => command.replace(/[0-9a-f-]{20,}.*/, "")).join("+").trim();
}

function load(label) {
  const dir = resolve(HERE, "runs", label);
  return readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(resolve(dir, file), "utf8")));
}

for (const label of process.argv.slice(2)) {
  const runs = load(label);
  const ok = runs.filter((run) => run.steps.length > 0);
  const failed = runs.length - runs.filter((run) => run.ok).length;
  const langOk = ok.filter((run) => run.firstMessage && (LANG[run.lang]?.test(run.firstMessage) ?? true)).length;
  const multi = ok.filter((run) => run.messages.length > 1).length;
  const waiting = ok.filter((run) => run.responsibilityState === "waiting").length;
  console.log(`\n## ${label}: n=${runs.length} failed=${failed} right-language=${langOk}/${ok.length} >1 message=${multi} state-waiting=${waiting}/${ok.length} cost=$${ok.reduce((sum, run) => sum + run.costUsd, 0).toFixed(4)} ($${(ok.reduce((sum, run) => sum + run.costUsd, 0) / (ok.length || 1)).toFixed(4)}/run)`);
  const rows = [];
  const row = (name, values, unit) => rows.push(`| ${name} | ${cell(values, unit)} |`);
  const modelMs = ok.map((run) => run.steps.reduce((sum, step) => sum + step.totalMs, 0));
  const gapMs = ok.map((run) => {
    const sorted = run.steps;
    let gap = 0;
    for (let index = 1; index < sorted.length; index++) gap += sorted[index].startedAt - (sorted[index - 1].startedAt + sorted[index - 1].totalMs);
    return gap;
  });
  row("steps", ok.map((run) => run.steps.length));
  row("dismiss to first model request (s)", ok.map((run) => run.dismissToFirstRequestMs), 1000);
  row("dismiss to first message (s)", ok.map((run) => run.dismissToFirstMessageMs), 1000);
  row("dismiss to run end (s)", ok.map((run) => run.dismissToRunEndMs), 1000);
  row("model time, sum of steps (s)", modelMs, 1000);
  row("between steps, sum (s)", gapMs, 1000);
  row("between steps, one gap (ms)", ok.flatMap((run) => run.steps.slice(1).map((step, index) => step.startedAt - (run.steps[index].startedAt + run.steps[index].totalMs))));
  row("one step total (ms)", ok.flatMap((run) => run.steps.map((step) => step.totalMs)));
  row("one step time to first delta (ms)", ok.flatMap((run) => run.steps.map((step) => step.firstByteMs)));
  row("step 0 time to first delta (ms)", ok.map((run) => run.steps[0]?.firstByteMs));
  row("step 0 total (ms)", ok.map((run) => run.steps[0]?.totalMs));
  row("step 0 input tokens", ok.map((run) => run.steps[0]?.inputTokens));
  row("step 0 cached tokens", ok.map((run) => run.steps[0]?.cachedTokens));
  row("step 1 input tokens", ok.map((run) => run.steps[1]?.inputTokens));
  row("step 1 cached tokens", ok.map((run) => run.steps[1]?.cachedTokens));
  row("step output tokens", ok.flatMap((run) => run.steps.map((step) => step.outputTokens)));
  row("step reasoning tokens", ok.flatMap((run) => run.steps.map((step) => step.reasoningTokens)));
  row("total input tokens", ok.map((run) => run.steps.reduce((sum, step) => sum + step.inputTokens, 0)));
  row("setup (s)", ok.map((run) => run.setupMs), 1000);
  console.log("| metric | median / p90 |\n| --- | ---: |");
  console.log(rows.join("\n"));

  const sequences = new Map();
  for (const run of ok) {
    const sequence = run.steps.flatMap((step) => step.toolCalls.map(classify)).join(" > ");
    sequences.set(sequence, (sequences.get(sequence) ?? 0) + 1);
  }
  console.log("\ntool sequences:");
  for (const [sequence, count] of [...sequences].sort((a, b) => b[1] - a[1])) console.log(`  ${count}x ${sequence}`);

  const byCommand = new Map();
  for (const run of ok) {
    for (const line of run.ledger) {
      if (line.call !== "shell.exec" || line.durationMs === null) continue;
      let input = "";
      try { input = JSON.parse(line.args).input ?? ""; } catch { input = line.args; }
      const key = input.trim().split(/\s+/)[0];
      const list = byCommand.get(key) ?? [];
      list.push(line.durationMs);
      byCommand.set(key, list);
    }
  }
  console.log("\nshell.exec by first word, ledger duration ms (n, median / p90):");
  for (const [key, values] of [...byCommand].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${key}: ${values.length}, ${cell(values)}`);

  const byCall = new Map();
  for (const run of ok) {
    const start = run.steps[0]?.startedAt ?? 0;
    const end = run.steps.at(-1) ? run.steps.at(-1).startedAt + run.steps.at(-1).totalMs + 1000 : 0;
    for (const line of run.ledger) {
      if (line.durationMs === null || !line.pid || line.timestamp < start - 2000 || line.timestamp > end) continue;
      const list = byCall.get(line.call) ?? [];
      list.push(line.durationMs);
      byCall.set(line.call, list);
    }
  }
  console.log("\nprocess syscalls per run, ledger duration ms (n/run, median / p90):");
  for (const [key, values] of [...byCall].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${key}: ${(values.length / (ok.length || 1)).toFixed(1)}, ${cell(values)}`);

  const withRipgit = ok.filter((run) => run.ripgit?.length);
  if (withRipgit.length) {
    const during = withRipgit.map((run) => {
      const start = run.dismissedAt;
      const end = run.steps.at(-1).startedAt + run.steps.at(-1).totalMs;
      return run.ripgit.filter((call) => call.at >= start && call.at <= end);
    });
    console.log(`\nripgit calls, dismiss to last step (n/run median / p90): ${cell(during.map((calls) => calls.length))}, ms each: ${cell(during.flat().map((call) => call.ms))}`);
    const paths = new Map();
    for (const call of during.flat()) {
      const key = `${call.method} ${call.path.replace(/[0-9a-f]{20,}/g, "*")}`;
      paths.set(key, (paths.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...paths].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(count / during.length).toFixed(1)}/run ${key}`);
  }

  console.log("\nfirst messages:");
  for (const run of ok.slice(0, Number(process.env.SHOW_MESSAGES ?? 3))) console.log(`  [${run.lang}] ${JSON.stringify(run.firstMessage)}`);
}
