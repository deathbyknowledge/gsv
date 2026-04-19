#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VERSION_FILE = join(ROOT, "VERSION");
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function readVersion() {
  const value = readFileSync(VERSION_FILE, "utf8").trim();
  if (!SEMVER_RE.test(value)) {
    fail(`VERSION must contain x.y.z semver, found "${value}"`);
  }
  return value;
}

function stableTag() {
  return `v${readVersion()}`;
}

function devTag(runNumberRaw) {
  const runNumber = `${runNumberRaw ?? ""}`.trim();
  if (!/^\d+$/.test(runNumber)) {
    fail("Dev tag requires a numeric run number");
  }
  return `${stableTag()}-dev.${runNumber}`;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function ensureCleanWorktree() {
  const result = spawnSync("git", ["status", "--short"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail("Could not inspect git worktree");
  }
  if (result.stdout.trim().length > 0) {
    fail("Worktree is not clean. Commit or stash changes before cutting a stable tag.");
  }
}

function checkStableTag(tag) {
  const expected = stableTag();
  if (tag !== expected) {
    fail(`Stable tag must be ${expected}, got ${tag}`);
  }
}

function cutStableTag() {
  ensureCleanWorktree();
  run("npm", ["run", "version:check"]);
  const tag = stableTag();
  run("git", ["tag", "-a", tag, "-m", `gsv ${tag}`]);
  console.log(tag);
}

function usage() {
  console.log("Usage:");
  console.log("  node scripts/release.mjs stable-tag");
  console.log("  node scripts/release.mjs dev-tag <run-number>");
  console.log("  node scripts/release.mjs check-stable-tag <tag>");
  console.log("  node scripts/release.mjs cut-stable");
}

const [command, value] = process.argv.slice(2);

switch (command) {
  case "stable-tag":
    console.log(stableTag());
    break;
  case "dev-tag":
    console.log(devTag(value));
    break;
  case "check-stable-tag":
    if (!value) {
      usage();
      fail("Missing tag");
    }
    checkStableTag(value);
    console.log(value);
    break;
  case "cut-stable":
    cutStableTag();
    break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}
