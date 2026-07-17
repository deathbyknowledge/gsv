#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  PUBLIC_PACKAGE_DIRECTORIES,
  publicPackageCommandPlan,
} from "./public-package-publication.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const publish = arguments_.includes("--publish");

if (arguments_.some((argument) => argument !== "--publish")) {
  throw new Error("Usage: node scripts/publish-public-packages.mjs [--publish]");
}
if (publish && !process.env.NODE_AUTH_TOKEN) {
  throw new Error("NODE_AUTH_TOKEN is required for publication");
}

const packages = [];
for (const directory of PUBLIC_PACKAGE_DIRECTORIES) {
  const manifest = JSON.parse(
    await readFile(path.join(root, directory, "package.json"), "utf8"),
  );
  if (
    typeof manifest.name !== "string"
    || typeof manifest.version !== "string"
    || manifest.private === true
    || manifest.publishConfig?.access !== "public"
  ) {
    throw new Error(`${directory} is not a publishable public package`);
  }
  packages.push({ directory, manifest });
}

const versions = new Map(
  packages.map(({ manifest }) => [manifest.name, manifest.version]),
);
for (const { directory, manifest } of packages) {
  for (const [dependency, specifier] of Object.entries(manifest.dependencies ?? {})) {
    if (versions.has(dependency) && specifier !== versions.get(dependency)) {
      throw new Error(
        `${directory} must consume ${dependency}@${versions.get(dependency)} exactly`,
      );
    }
  }
}

const temporary = await mkdtemp(path.join(tmpdir(), "gsv-public-packages-"));
try {
  for (const { directory, manifest } of packages) {
    const specifier = `${manifest.name}@${manifest.version}`;
    const commands = publicPackageCommandPlan(root, directory, temporary);
    const local = packLocal(directory, commands.pack);
    const publishedIntegrity = registryIntegrity(specifier);
    if (publishedIntegrity !== null) {
      if (publishedIntegrity !== local.integrity) {
        throw new Error(
          `${specifier} already exists with different package content; bump its version`,
        );
      }
      process.stdout.write(`${specifier}: already published with identical content\n`);
      continue;
    }

    if (!publish) {
      run(
        commands.publishDryRun.command,
        commands.publishDryRun.arguments,
        commands.publishDryRun.cwd,
        `${specifier} publish dry-run`,
      );
      process.stdout.write(`${specifier}: publication dry-run passed\n`);
      continue;
    }

    run(
      commands.publish.command,
      commands.publish.arguments,
      commands.publish.cwd,
      `${specifier} publication`,
    );
    process.stdout.write(`${specifier}: published\n`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function packLocal(directory, command) {
  const result = runJson(
    command.command,
    command.arguments,
    command.cwd,
    `${directory} npm pack`,
  );
  const packed = Array.isArray(result) ? result[0] : null;
  if (!packed || typeof packed.integrity !== "string") {
    throw new Error(`${directory} npm pack did not report an integrity digest`);
  }
  return packed;
}

function registryIntegrity(specifier) {
  const result = spawnSync(
    "npm",
    ["view", specifier, "dist.integrity", "--json"],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
  );
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    if (typeof value !== "string" || !value.startsWith("sha512-")) {
      throw new Error(`${specifier} has an invalid registry integrity digest`);
    }
    return value;
  }
  const failure = `${result.stderr}\n${result.stdout}`;
  if (/\bE404\b|\b404 Not Found\b/.test(failure)) return null;
  throw new Error(`${specifier} registry lookup failed\n${failure.trim()}`);
}

function runJson(command, arguments_, cwd, label) {
  const result = run(command, arguments_, cwd, label, true);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return JSON`, { cause: error });
  }
}

function run(command, arguments_, cwd, label, capture = false) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed${capture ? `\n${result.stderr || result.stdout}` : ""}`,
    );
  }
  return result;
}
