#!/usr/bin/env node
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  DEMO_MAX_DEVICE_COUNT,
  assessSnapshot,
  deviceIdForIndex,
  loadFleetSnapshot,
} from "./fleet-state.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = process.env.DEMO_FLEET_GENERATED_DIR || path.join(scriptDir, ".generated");

const defaults = {
  root: process.env.DEMO_FLEET_DIR || path.join(generatedDir, "fleet"),
  truth: process.env.DEMO_FLEET_GROUND_TRUTH_FILE || path.join(generatedDir, "ground-truth.json"),
  watch: false,
  intervalSeconds: 1,
  noColor: false,
};

function usage() {
  console.log(`Usage: node scripts/demo-fleet/monitor-fleet.mjs [options]

Show a compact fleet-state grid (10x10 at the default 100; 50x20 at 1,000).

Options:
  --watch              Refresh until interrupted (default: one shot)
  --interval SECONDS   Watch refresh interval (default: 1)
  --root PATH           Fleet workspace root
  --truth PATH          Ground-truth JSON file
  --no-color            Disable ANSI color
  -h, --help            Show this help`);
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
    if (arg === "--watch") {
      opts.watch = true;
    } else if (arg === "--no-color") {
      opts.noColor = true;
    } else if (arg === "--interval") {
      opts.intervalSeconds = Number(optionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--root") {
      opts.root = optionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--truth") {
      opts.truth = optionValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.intervalSeconds) || opts.intervalSeconds < 0.1 || opts.intervalSeconds > 60) {
    throw new Error("--interval must be a number from 0.1 to 60 seconds");
  }
  return opts;
}

function colorizer(enabled) {
  const wrap = (code, value) => enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
  return {
    bold: (value) => wrap("1", value),
    dim: (value) => wrap("2", value),
    healthy: (value) => wrap("32", value),
    degraded: (value) => wrap("31;1", value),
    recovered: (value) => wrap("36;1", value),
    pending: (value) => wrap("33", value),
    drift: (value) => wrap("35;1", value),
    unknown: (value) => wrap("90", value),
  };
}

function displayState(device) {
  // These categories use current files and observed recovery evidence. They do
  // not use the manifest's affected list, so the grid never exposes hidden targets.
  if (!device || device.unreadable) return "unknown";
  if (device.drift) return "drift";
  if (device.recovered) return "recovered";
  if (device.configRepaired && !device.configOriginal) return "pending";
  if (device.degraded) return "degraded";
  if (device.healthy) return "healthy";
  return "unknown";
}

function symbolFor(state, colors) {
  if (state === "healthy") return colors.healthy("H");
  if (state === "degraded") return colors.degraded("!");
  if (state === "recovered") return colors.recovered("R");
  if (state === "pending") return colors.pending("P");
  if (state === "drift") return colors.drift("D");
  return colors.unknown("?");
}

function currentCounts(devices) {
  return {
    healthy: devices.filter((device) => device.healthy).length,
    degraded: devices.filter((device) => device.degraded).length,
    recovered: devices.filter((device) => device.recovered).length,
    untouched: devices.filter((device) => device.configOriginal).length,
    drift: devices.filter((device) => device.drift).length,
    pending: devices.filter((device) => displayState(device) === "pending").length,
    unreadable: devices.filter((device) => device.unreadable).length,
  };
}

function gridColumns(deviceCount) {
  return deviceCount <= 100 ? 10 : 50;
}

function renderCells(cells, columns) {
  if (columns === 10) return cells.join("  ");
  const groups = [];
  for (let offset = 0; offset < cells.length; offset += 10) {
    groups.push(cells.slice(offset, offset + 10).join(""));
  }
  return groups.join(" ");
}

function render(assessment, colors, watch) {
  const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const mode = watch ? "live" : "one shot";
  const lines = [colors.bold(`GSV demo fleet · ${now} · ${mode}`)];
  if (assessment.devices.length === 0) {
    lines.push("");
    lines.push(colors.unknown("No fleet data available."));
    lines.push(`Input warnings: ${assessment.truthIssues.length + assessment.workspaceIssues.length}`);
    return lines.join("\n");
  }

  const byId = new Map(assessment.devices.map((device) => [device.deviceId, device]));
  const declaredCount = assessment.truth?.deviceCount;
  const deviceCount = Number.isInteger(declaredCount)
    && declaredCount >= 1
    && declaredCount <= DEMO_MAX_DEVICE_COUNT
    ? declaredCount
    : assessment.devices.length;
  const columns = gridColumns(deviceCount);
  const rowCount = Math.ceil(deviceCount / columns);
  const labelWidth = Math.max(3, String(deviceCount).length);
  lines.push("");
  if (columns === 10) {
    lines.push("          1  2  3  4  5  6  7  8  9 10");
  } else {
    lines.push(`${"range".padEnd(labelWidth * 2 + 1)}  device state left-to-right (groups of 10)`);
  }
  for (let row = 0; row < rowCount; row += 1) {
    const first = row * columns + 1;
    const last = Math.min(first + columns - 1, deviceCount);
    const cells = [];
    for (let index = first; index <= last; index += 1) {
      const deviceId = deviceIdForIndex(index);
      const device = byId.get(deviceId);
      cells.push(symbolFor(displayState(device), colors));
    }
    const range = `${String(first).padStart(labelWidth, "0")}-${String(last).padStart(labelWidth, "0")}`;
    lines.push(`${range}  ${renderCells(cells, columns)}`);
  }

  const counts = currentCounts(assessment.devices);
  lines.push("");
  lines.push(
    `${colors.healthy("healthy")} ${counts.healthy}   ${colors.degraded("degraded")} ${counts.degraded}   ${colors.recovered("recovered")} ${counts.recovered}   untouched ${counts.untouched}   ${colors.drift("drift")} ${counts.drift}`,
  );
  const extras = [];
  if (counts.pending > 0) extras.push(`${colors.pending("pending recovery")} ${counts.pending}`);
  if (counts.unreadable > 0) extras.push(`${colors.unknown("unreadable")} ${counts.unreadable}`);
  const warnings = assessment.truthIssues.length + assessment.workspaceIssues.length;
  if (warnings > 0) extras.push(`${colors.unknown("input warnings")} ${warnings}`);
  if (extras.length > 0) lines.push(extras.join("   "));
  lines.push("");
  lines.push(colors.dim("H healthy   ! degraded   R recovered   P pending recovery   D config drift   ? unreadable"));
  return lines.join("\n");
}

async function snapshot(opts) {
  return assessSnapshot(await loadFleetSnapshot({ root: opts.root, truthPath: opts.truth }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) return;
  const ansi = process.stdout.isTTY === true
    && !opts.noColor
    && process.env.TERM !== "dumb"
    && !Object.hasOwn(process.env, "NO_COLOR");
  const colors = colorizer(ansi);
  let stopped = false;
  const stopController = new AbortController();
  process.once("SIGINT", () => {
    stopped = true;
    stopController.abort();
  });
  process.once("SIGTERM", () => {
    stopped = true;
    stopController.abort();
  });

  let first = true;
  do {
    const assessment = await snapshot(opts);
    const output = render(assessment, colors, opts.watch);
    if (opts.watch && ansi) process.stdout.write("\u001b[2J\u001b[H");
    else if (!first) process.stdout.write("\n");
    process.stdout.write(`${output}\n`);
    first = false;
    if (!opts.watch) {
      const badInput = assessment.devices.length === 0
        || assessment.devices.some((device) => device.unreadable)
        || assessment.truthIssues.length > 0
        || assessment.workspaceIssues.length > 0;
      process.exitCode = badInput ? 1 : 0;
      break;
    }
    try {
      await delay(opts.intervalSeconds * 1000, undefined, { signal: stopController.signal });
    } catch (error) {
      if (!stopped || error?.name !== "AbortError") throw error;
    }
  } while (!stopped);
}

main().catch((error) => {
  console.error(`Monitor error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
