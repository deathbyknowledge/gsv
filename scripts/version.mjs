#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VERSION_FILE = join(ROOT, "VERSION");
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function fail(message) {
  throw new Error(message);
}

function readVersionFile() {
  const value = readFileSync(VERSION_FILE, "utf8").trim();
  if (!SEMVER_RE.test(value)) {
    fail(`VERSION must contain x.y.z semver, found "${value}"`);
  }
  return value;
}

function writeVersionFile(version) {
  if (!SEMVER_RE.test(version)) {
    fail(`Version must be x.y.z semver, found "${version}"`);
  }
  writeFileSync(VERSION_FILE, `${version}\n`);
}

function listPackageJsonFiles() {
  const files = ["package.json", "gateway/package.json", "web/package.json", "ripgit/package.json"];
  for (const group of ["shared", "adapters", "builtin-packages"]) {
    const groupDir = join(ROOT, group);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const relativePath = `${group}/${entry.name}/package.json`;
      try {
        readFileSync(join(ROOT, relativePath), "utf8");
        files.push(relativePath);
      } catch {
        continue;
      }
    }
  }
  return files;
}

function listStandaloneNpmDirs() {
  const dirs = ["gateway", "web", "ripgit"];
  for (const group of ["adapters", "builtin-packages"]) {
    const groupDir = join(ROOT, group);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const packageJsonPath = join(ROOT, group, entry.name, "package.json");
        try {
          readFileSync(packageJsonPath, "utf8");
        } catch {
          continue;
        }
        dirs.push(`${group}/${entry.name}`);
      }
    }
  }
  return dirs;
}

function writeJsonFile(relativePath, transform) {
  const absolutePath = join(ROOT, relativePath);
  const value = JSON.parse(readFileSync(absolutePath, "utf8"));
  const next = transform(value);
  writeFileSync(absolutePath, `${JSON.stringify(next, null, 2)}\n`);
}

function replaceInFile(relativePath, pattern, replacement) {
  const absolutePath = join(ROOT, relativePath);
  const current = readFileSync(absolutePath, "utf8");
  if (!current.match(pattern)) {
    fail(`No version match found in ${relativePath}`);
  }
  const next = current.replace(pattern, replacement);
  writeFileSync(absolutePath, next);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function syncPackageJsonVersions(version) {
  for (const file of listPackageJsonFiles()) {
    writeJsonFile(file, (value) => ({ ...value, version }));
  }
}

function syncSourceVersions(version) {
  replaceInFile(
    "cli/Cargo.toml",
    /^version = "[^"]+"$/m,
    `version = "${version}"`,
  );
  replaceInFile(
    "ripgit/Cargo.toml",
    /^version = "[^"]+"$/m,
    `version = "${version}"`,
  );
  replaceInFile(
    "gateway/src/kernel/do.ts",
    /const SERVER_VERSION = "[^"]+";/,
    `const SERVER_VERSION = "${version}";`,
  );
  replaceInFile(
    "gateway/src/kernel/config.ts",
    /"config\/server\/version": "[^"]+",/,
    `"config/server/version": "${version}",`,
  );
  replaceInFile(
    "gateway/src/drivers/native/shell.ts",
    /const ver = ctx\.config\.get\("config\/server\/version"\) \?\? "[^"]+";/,
    `const ver = ctx.config.get("config/server/version") ?? "${version}";`,
  );
  replaceInFile(
    "gateway/src/drivers/native/shell.test.ts",
    /if \(key === "config\/server\/version"\) return "[^"]+";/,
    `if (key === "config/server/version") return "${version}";`,
  );
  replaceInFile(
    "gateway/src/drivers/native/shell.test.ts",
    /serverVersion: "[^"]+",/,
    `serverVersion: "${version}",`,
  );
  replaceInFile(
    "web/src/gateway-client.ts",
    /id: "gsv-ui",\n\s+version: "[^"]+",/,
    `id: "gsv-ui",\n          version: "${version}",`,
  );
  replaceInFile(
    "web/src/gateway-client.ts",
    /id: "gsv-ui-setup-probe",\n\s+version: "[^"]+",/,
    `id: "gsv-ui-setup-probe",\n          version: "${version}",`,
  );
  replaceInFile(
    "adapters/whatsapp/src/gateway-client.ts",
    /version: "[^"]+",/,
    `version: "${version}",`,
  );
  replaceInFile(
    "ripgit/src/lib.rs",
    /"name": "ripgit",\n\s+"version": "[^"]+"/,
    `"name": "ripgit",\n        "version": "${version}"`,
  );
}

function syncCargoLocks(version) {
  replaceInFile(
    "cli/Cargo.lock",
    /(name = "gsv"\nversion = ")[^"]+(")/,
    `$1${version}$2`,
  );
  replaceInFile(
    "ripgit/Cargo.lock",
    /(name = "ripgit"\nversion = ")[^"]+(")/,
    `$1${version}$2`,
  );
}

function refreshNpmLocks() {
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"], ROOT);
  for (const dir of listStandaloneNpmDirs()) {
    run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--workspaces=false"], join(ROOT, dir));
  }
}

function stripLockfileLibcMetadata(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      stripLockfileLibcMetadata(entry);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  delete value.libc;
  for (const entry of Object.values(value)) {
    stripLockfileLibcMetadata(entry);
  }
}

function normalizeNpmLocks() {
  const lockfiles = ["package-lock.json", ...listStandaloneNpmDirs().map((dir) => `${dir}/package-lock.json`)];
  for (const relativePath of lockfiles) {
    writeJsonFile(relativePath, (value) => {
      stripLockfileLibcMetadata(value);
      return value;
    });
  }
}

function managedFiles() {
  const files = new Set([
    "VERSION",
    "package.json",
    "package-lock.json",
    "cli/Cargo.toml",
    "cli/Cargo.lock",
    "ripgit/Cargo.toml",
    "ripgit/Cargo.lock",
    "gateway/src/kernel/do.ts",
    "gateway/src/kernel/config.ts",
    "gateway/src/drivers/native/shell.ts",
    "gateway/src/drivers/native/shell.test.ts",
    "web/src/gateway-client.ts",
    "adapters/whatsapp/src/gateway-client.ts",
    "ripgit/src/lib.rs",
  ]);
  for (const file of listPackageJsonFiles()) {
    files.add(file);
  }
  for (const dir of listStandaloneNpmDirs()) {
    files.add(`${dir}/package-lock.json`);
  }
  return [...files];
}

function syncAll(version) {
  writeVersionFile(version);
  syncPackageJsonVersions(version);
  syncSourceVersions(version);
  syncCargoLocks(version);
  refreshNpmLocks();
  normalizeNpmLocks();
}

function checkAll(version) {
  const snapshot = new Map(
    managedFiles().map((relativePath) => [
      relativePath,
      readFileSync(join(ROOT, relativePath), "utf8"),
    ]),
  );

  let errorMessage = null;
  try {
    syncAll(version);
    const changed = managedFiles().filter((relativePath) => {
      const current = readFileSync(join(ROOT, relativePath), "utf8");
      return current !== snapshot.get(relativePath);
    });
    if (changed.length > 0) {
      errorMessage = [
        "Versioned files are out of sync. Run `npm run version:sync` and commit the result.",
        "",
        ...changed.map((relativePath) => `- ${relativePath}`),
      ].join("\n");
    }
  } finally {
    for (const [relativePath, contents] of snapshot) {
      writeFileSync(join(ROOT, relativePath), contents);
    }
  }

  if (errorMessage) {
    fail(errorMessage);
  }
}

function bumpVersion(current, kind) {
  const parts = current.split(".").map((value) => Number.parseInt(value, 10));
  const [major, minor, patch] = parts;
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      fail(`Unsupported bump kind "${kind}". Use major, minor, or patch.`);
  }
}

function usage() {
  console.log("Usage:");
  console.log("  node scripts/version.mjs show");
  console.log("  node scripts/version.mjs check");
  console.log("  node scripts/version.mjs sync");
  console.log("  node scripts/version.mjs set <x.y.z>");
  console.log("  node scripts/version.mjs bump <major|minor|patch>");
}

try {
  const [command, value] = process.argv.slice(2);
  const currentVersion = readVersionFile();

  switch (command) {
    case "show":
      console.log(currentVersion);
      break;
    case "check":
      checkAll(currentVersion);
      console.log(`Checked version ${currentVersion}`);
      break;
    case "sync":
      syncAll(currentVersion);
      console.log(`Synced version ${currentVersion}`);
      break;
    case "set":
      if (!value) {
        usage();
        fail("Missing version value");
      }
      syncAll(value);
      console.log(`Set version to ${value}`);
      break;
    case "bump": {
      if (!value) {
        usage();
        fail("Missing bump kind");
      }
      const nextVersion = bumpVersion(currentVersion, value);
      syncAll(nextVersion);
      console.log(`Bumped version ${currentVersion} -> ${nextVersion}`);
      break;
    }
    default:
      usage();
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
