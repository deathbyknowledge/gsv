#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessSnapshot,
  formatIssue,
  isRecord,
  loadFleetSnapshot,
  semanticEqual,
} from "./fleet-state.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = process.env.DEMO_FLEET_GENERATED_DIR || path.join(scriptDir, ".generated");

const defaults = {
  root: process.env.DEMO_FLEET_DIR || path.join(generatedDir, "fleet"),
  truth: process.env.DEMO_FLEET_GROUND_TRUTH_FILE || path.join(generatedDir, "ground-truth.json"),
  expect: "repaired",
};

function usage() {
  console.log(`Usage: node scripts/demo-fleet/verify-fleet.mjs [options]

Prove the exact state of the incident demo (100 devices by default, up to 1,000).

Options:
  --expect baseline|repaired  State to prove (default: repaired)
  --root PATH                 Fleet workspace root
  --truth PATH                Ground-truth JSON file
  -h, --help                  Show this help`);
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      return null;
    }
    if (arg === "--root") {
      opts.root = optionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--truth") {
      opts.truth = optionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--expect") {
      opts.expect = optionValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (opts.expect !== "baseline" && opts.expect !== "repaired") {
    throw new Error("--expect must be baseline or repaired");
  }
  return opts;
}

function readProblem(result) {
  return result.ok ? null : `${result.message} (${result.file})`;
}

function inputProblems(device, expectation, affected) {
  const problems = [];
  for (const result of [device.config, device.node, device.health, device.metrics, device.serviceStatus]) {
    const problem = readProblem(result);
    if (problem) problems.push(problem);
  }
  if (expectation === "repaired" && affected) {
    const problem = readProblem(device.checkoutLog);
    if (problem) problems.push(problem);
  }
  if (device.config.ok && !isRecord(device.config.value)) problems.push("checkout config must be a JSON object");
  if (device.node.ok && !isRecord(device.node.value)) problems.push("node config must be a JSON object");
  if (device.health.ok && !isRecord(device.health.value)) problems.push("health state must be a JSON object");
  if (device.metrics.ok && !isRecord(device.metrics.value)) problems.push("metrics state must be a JSON object");
  if (!device.nodeValid && device.node.ok && isRecord(device.node.value)) {
    problems.push("node identity or home region differs from ground truth");
  }
  return [...new Set(problems)];
}

function exactSeededStateProblems(device) {
  const problems = [];
  if (isRecord(device.expected?.originalHealth) && device.health.ok) {
    if (!semanticEqual(device.health.value, device.expected.originalHealth)) {
      problems.push("health state differs from the seeded original");
    }
  }
  if (isRecord(device.expected?.originalMetrics) && device.metrics.ok) {
    if (!semanticEqual(device.metrics.value, device.expected.originalMetrics)) {
      problems.push("metrics state differs from the seeded original");
    }
  }
  if (typeof device.expected?.originalServiceStatus === "string" && device.serviceStatus.ok) {
    if (device.serviceStatus.value.trim() !== device.expected.originalServiceStatus) {
      problems.push("service status differs from the seeded original");
    }
  }
  return problems;
}

function createReport(assessment, expectation) {
  const truth = assessment.truth;
  const affectedSet = new Set(Array.isArray(truth?.affected) ? truth.affected : []);
  const affectedTotal = affectedSet.size;
  const total = assessment.devices.length;
  const unaffectedTotal = total - affectedTotal;
  const details = [];
  const seenDetails = new Set();

  function addDetail(scope, check, problem) {
    if (!problem) return;
    const key = `${scope}\0${check}\0${problem}`;
    if (seenDetails.has(key)) return;
    seenDetails.add(key);
    details.push({ scope, check, problem });
  }

  for (const entry of [...assessment.truthIssues, ...assessment.workspaceIssues]) {
    addDetail(entry.scope, "proof inputs", formatIssue(entry));
  }

  let readable = 0;
  let originalConfigs = 0;
  let repairedConfigs = 0;
  let affectedDegraded = 0;
  let affectedRecovered = 0;
  let unaffectedHealthy = 0;
  let unaffectedUntouched = 0;
  let running = 0;

  for (const device of assessment.devices) {
    const affected = affectedSet.has(device.deviceId);
    const inputs = inputProblems(device, expectation, affected);
    if (inputs.length === 0) readable += 1;
    for (const problem of inputs) addDetail(device.deviceId, "proof inputs", problem);
    if (device.serviceRunning) running += 1;
    else addDetail(device.deviceId, "checkout running", "checkout service is not running");

    if (expectation === "baseline") {
      if (device.configOriginal) originalConfigs += 1;
      else addDetail(device.deviceId, "configs original", "checkout config differs from the seeded original");

      const exactProblems = exactSeededStateProblems(device);
      if (affected) {
        const problems = [...device.degradedProblems, ...exactProblems];
        if (problems.length === 0) affectedDegraded += 1;
        for (const problem of problems) addDetail(device.deviceId, "incident degraded", problem);
      } else {
        const problems = [...device.healthyProblems, ...exactProblems];
        if (problems.length === 0) unaffectedHealthy += 1;
        for (const problem of problems) addDetail(device.deviceId, "unaffected healthy", problem);
      }
    } else if (affected) {
      if (device.configRepaired && !device.configOriginal) repairedConfigs += 1;
      else addDetail(device.deviceId, "exact repairs", "config is not the original plus exactly the two approved fixes");

      const problems = [
        ...device.healthyProblems,
        ...device.evidenceProblems,
        ...device.repairedStateProblems,
      ];
      if (problems.length === 0 && device.recovered) affectedRecovered += 1;
      for (const problem of problems) addDetail(device.deviceId, "recovered after restart", problem);
    } else {
      if (device.configOriginal) unaffectedUntouched += 1;
      else addDetail(device.deviceId, "unaffected untouched", "checkout config differs from the seeded original");

      const problems = [...device.healthyProblems, ...exactSeededStateProblems(device)];
      if (problems.length === 0) unaffectedHealthy += 1;
      for (const problem of problems) addDetail(device.deviceId, "unaffected healthy", problem);
    }
  }

  const inputTotal = total + assessment.truthIssues.length + assessment.workspaceIssues.length;
  const sections = expectation === "baseline"
    ? [
        { label: "proof inputs", passed: readable, total: inputTotal },
        { label: "configs original", passed: originalConfigs, total },
        { label: "incident degraded", passed: affectedDegraded, total: affectedTotal },
        { label: "unaffected healthy", passed: unaffectedHealthy, total: unaffectedTotal },
        { label: "checkout running", passed: running, total },
      ]
    : [
        { label: "proof inputs", passed: readable, total: inputTotal },
        { label: "exact repairs", passed: repairedConfigs, total: affectedTotal },
        { label: "recovered after restart", passed: affectedRecovered, total: affectedTotal },
        { label: "unaffected untouched", passed: unaffectedUntouched, total: unaffectedTotal },
        { label: "unaffected healthy", passed: unaffectedHealthy, total: unaffectedTotal },
        { label: "checkout running", passed: running, total },
      ];

  const counts = {
    total,
    healthy: assessment.devices.filter((device) => device.healthy).length,
    degraded: assessment.devices.filter((device) => device.degraded).length,
    recovered: assessment.devices.filter((device) => device.recovered).length,
    untouched: assessment.devices.filter((device) => device.configOriginal).length,
    drift: assessment.devices.filter((device) => device.drift).length,
  };
  return {
    expectation,
    sections,
    details,
    counts,
    pass: sections.every((section) => section.passed === section.total),
  };
}

function printReport(report) {
  const countWidth = Math.max(3, ...report.sections.map((section) => String(section.total).length));
  console.log(`Fleet proof · ${report.expectation}`);
  for (const section of report.sections) {
    const status = section.passed === section.total ? "PASS" : "FAIL";
    console.log(
      `${status.padEnd(5)} ${section.label.padEnd(25)} ${String(section.passed).padStart(countWidth)}/${String(section.total).padStart(countWidth)}`,
    );
  }

  if (report.details.length > 0) {
    const limit = 20;
    console.log("");
    console.log(`Problems (${report.details.length}):`);
    for (const detail of report.details.slice(0, limit)) {
      console.log(`- ${detail.scope} [${detail.check}]: ${detail.problem}`);
    }
    if (report.details.length > limit) {
      console.log(`- … ${report.details.length - limit} more problem(s)`);
    }
  }

  const { counts } = report;
  console.log("");
  console.log(
    `${report.pass ? "PASS" : "FAIL"} · ${counts.total} devices · healthy ${counts.healthy} · degraded ${counts.degraded} · recovered ${counts.recovered} · untouched ${counts.untouched} · drift ${counts.drift}`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) return;
  const snapshot = await loadFleetSnapshot({ root: opts.root, truthPath: opts.truth });
  const report = createReport(assessSnapshot(snapshot), opts.expect);
  printReport(report);
  process.exitCode = report.pass ? 0 : 1;
}

main().catch((error) => {
  console.error(`FAIL · verifier error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
