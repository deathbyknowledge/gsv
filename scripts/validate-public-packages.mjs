#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const localDependency = /^(?:file|link|workspace):|^(?:\.{1,2}\/|\/)/;

const publicPackages = [
  {
    name: "@humansandmachines/gsv",
    directory: "packages/gsv",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/protocol.js",
      "dist/protocol.d.ts",
      "dist/protocol/data-frame-stream.js",
      "dist/protocol/data-frame-stream.d.ts",
      "dist/protocol/managed-objects.js",
      "dist/protocol/managed-objects.d.ts",
      "dist/client.js",
      "dist/client.d.ts",
    ],
  },
  {
    name: "@humansandmachines/gsv-portable-archive",
    directory: "packages/portable-archive",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/encryption.js",
      "dist/encryption.d.ts",
      "dist/inner.js",
      "dist/inner.d.ts",
      "dist/manifest.js",
      "dist/manifest.d.ts",
      "dist/r2.js",
      "dist/r2.d.ts",
    ],
  },
  {
    name: "@humansandmachines/gsv-worker-runtime",
    directory: "packages/worker-runtime",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/portable-do.js",
      "dist/portable-do.d.ts",
      "dist/schema.js",
      "dist/schema.d.ts",
    ],
  },
  {
    name: "@humansandmachines/gsv-cloudflare-release",
    directory: "packages/cloudflare-release",
    allowedRuntimeFiles: ["scripts/generate-release-descriptor.mjs"],
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/archive.js",
      "dist/archive.d.ts",
      "dist/bundle.js",
      "dist/bundle.d.ts",
      "schema/gsv-cloudflare-release-v1.schema.json",
      "scripts/generate-release-descriptor.mjs",
    ],
  },
];

const requestedNames = new Set(process.argv.slice(2));
const selected = requestedNames.size === 0
  ? publicPackages
  : publicPackages.filter(({ name }) => requestedNames.has(name));

for (const name of requestedNames) {
  if (!selected.some((entry) => entry.name === name)) {
    fail(`Unknown public package: ${name}`);
  }
}

for (const packageDefinition of selected) {
  await validatePackage(packageDefinition);
}

function fail(message) {
  throw new Error(message);
}

async function validatePackage(packageDefinition) {
  const packageRoot = path.join(root, packageDefinition.directory);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const prefix = `${packageDefinition.name}:`;

  if (manifest.name !== packageDefinition.name) {
    fail(`${prefix} package name does not match its release definition`);
  }
  if (manifest.private === true) {
    fail(`${prefix} package is marked private`);
  }
  if (manifest.publishConfig?.access !== "public") {
    fail(`${prefix} publishConfig.access must be public`);
  }
  if (manifest.license !== "MIT") {
    fail(`${prefix} license must be MIT`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
    fail(`${prefix} files must include dist`);
  }
  if (!isDistTarget(manifest.main) || !isDistTarget(manifest.types)) {
    fail(`${prefix} main and types must reference dist`);
  }

  validateDependencyMetadata(manifest, prefix);
  const exportTargets = validateExports(manifest.exports, prefix);

  const pack = runNpmJson(
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    packageRoot,
    `${prefix} npm pack --dry-run`,
  );
  const packResult = Array.isArray(pack) ? pack[0] : pack;
  const publish = runNpmJson(
    ["publish", "--dry-run", "--ignore-scripts", "--force", "--json"],
    packageRoot,
    `${prefix} npm publish --dry-run`,
  );
  const publishResult = publish[packageDefinition.name] ?? publish;

  const packFiles = fileSet(packResult, `${prefix} pack result`);
  const publishFiles = fileSet(publishResult, `${prefix} publish result`);
  assertSameFiles(packFiles, publishFiles, prefix);
  validateTarballFiles(
    packFiles,
    prefix,
    new Set(packageDefinition.allowedRuntimeFiles ?? []),
  );

  for (const requiredFile of [
    "LICENSE",
    "README.md",
    ...packageDefinition.requiredFiles,
    ...exportTargets,
  ]) {
    assertPackedTarget(requiredFile, packFiles, prefix);
  }

  process.stdout.write(
    `${packageDefinition.name}@${manifest.version}: ${packFiles.size} publishable files validated\n`,
  );
}

function validateDependencyMetadata(manifest, prefix) {
  const sections = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ];
  for (const section of sections) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (typeof specifier !== "string" || localDependency.test(specifier)) {
        fail(`${prefix} ${section}.${name} must not use a local dependency specifier`);
      }
      if (
        name.startsWith("@humansandmachines/gsv") &&
        section !== "devDependencies" &&
        !exactSemver.test(specifier)
      ) {
        fail(`${prefix} ${section}.${name} must use an exact published version`);
      }
    }
  }
}

function validateExports(exports, prefix) {
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    fail(`${prefix} exports must be an object`);
  }

  const targets = [];
  for (const [subpath, definition] of Object.entries(exports)) {
    if (subpath === "./package.json") {
      if (definition !== "./package.json") {
        fail(`${prefix} ./package.json must export the package manifest`);
      }
      continue;
    }
    if (
      subpath === "./schema.json"
      && typeof definition === "string"
      && definition.startsWith("./schema/")
      && definition.endsWith(".json")
    ) {
      targets.push(definition.slice(2));
      continue;
    }
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      fail(`${prefix} export ${subpath} must provide types and default conditions`);
    }
    for (const condition of ["types", "default"]) {
      const target = definition[condition];
      if (!isDistTarget(target)) {
        fail(`${prefix} export ${subpath} ${condition} target must reference dist`);
      }
      targets.push(target.slice(2));
    }
  }
  return targets;
}

function isDistTarget(value) {
  return (
    typeof value === "string" &&
    value.startsWith("./dist/") &&
    (!value.endsWith(".ts") || value.endsWith(".d.ts"))
  );
}

function runNpmJson(arguments_, cwd, label) {
  const result = spawnSync("npm", arguments_, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(`${label} failed\n${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`${label} did not return JSON: ${error.message}`);
  }
}

function fileSet(result, label) {
  if (!result || !Array.isArray(result.files)) {
    fail(`${label} is missing its file inventory`);
  }
  return new Set(result.files.map(({ path: filePath }) => filePath));
}

function assertSameFiles(left, right, prefix) {
  const missingFromPublish = [...left].filter((file) => !right.has(file));
  const missingFromPack = [...right].filter((file) => !left.has(file));
  if (missingFromPublish.length > 0 || missingFromPack.length > 0) {
    fail(
      `${prefix} pack and publish dry-runs disagree: ` +
        `publish missing [${missingFromPublish.join(", ")}], ` +
        `pack missing [${missingFromPack.join(", ")}]`,
    );
  }
}

function validateTarballFiles(files, prefix, allowedRuntimeFiles) {
  if (!files.has("package.json")) {
    fail(`${prefix} tarball is missing package.json`);
  }
  for (const file of files) {
    if (/^(?:src|test|scripts)\//.test(file) && !allowedRuntimeFiles.has(file)) {
      fail(`${prefix} tarball contains source-only path ${file}`);
    }
    if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
      fail(`${prefix} tarball contains TypeScript source ${file}`);
    }
  }
}

function assertPackedTarget(target, files, prefix) {
  if (!target.includes("*")) {
    if (!files.has(target)) {
      fail(`${prefix} tarball is missing exported file ${target}`);
    }
    return;
  }

  const pattern = new RegExp(
    `^${target
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+")}$`,
  );
  if (![...files].some((file) => pattern.test(file))) {
    fail(`${prefix} tarball has no files for exported pattern ${target}`);
  }
}
