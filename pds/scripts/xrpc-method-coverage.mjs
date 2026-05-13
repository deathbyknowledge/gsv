#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "scripts", "xrpc-method-coverage.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

const official = collectOfficialMethods();
const implemented = collectImplementedMethods();
const tested = collectTestedMethods(official);

const unsupported = sorted(Object.keys(config.unsupported ?? {}));
const implementedUntested = sorted(Object.keys(config.implementedUntested ?? {}));
const extraImplemented = sorted(Object.keys(config.extraImplemented ?? {}));

const officialSet = new Set(official);
const implementedSet = new Set(implemented);
const testedSet = new Set(tested);
const unsupportedSet = new Set(unsupported);
const implementedUntestedSet = new Set(implementedUntested);
const extraImplementedSet = new Set(extraImplemented);

const missing = official.filter((method) => !implementedSet.has(method) && !unsupportedSet.has(method));
const staleUnsupported = unsupported.filter((method) => !officialSet.has(method) || implementedSet.has(method));
const untested = implemented.filter((method) => officialSet.has(method) && !testedSet.has(method));
const unclassifiedUntested = untested.filter((method) => !implementedUntestedSet.has(method));
const staleUntested = implementedUntested.filter(
  (method) => !implementedSet.has(method) || !officialSet.has(method) || testedSet.has(method),
);
const unexpectedExtra = implemented.filter((method) => !officialSet.has(method) && !extraImplementedSet.has(method));
const staleExtra = extraImplemented.filter((method) => !implementedSet.has(method) || officialSet.has(method));

printReport({
  official,
  implemented,
  tested,
  unsupported,
  implementedUntested,
  extraImplemented,
  missing,
  unclassifiedUntested,
  unexpectedExtra,
});

const failures = [
  ["official methods missing implementation/classification", missing],
  ["unsupported classifications that are stale or now implemented", staleUnsupported],
  ["implemented official methods missing smoke coverage/classification", unclassifiedUntested],
  ["untested classifications that are stale or now covered", staleUntested],
  ["implemented non-generated methods missing classification", unexpectedExtra],
  ["extra implemented classifications that are stale or now generated", staleExtra],
].filter(([, values]) => values.length > 0);

if (failures.length > 0) {
  for (const [label, values] of failures) {
    console.error(`\n${label}:`);
    for (const value of values) {
      console.error(`  - ${value}`);
    }
  }
  process.exitCode = 1;
}

function collectOfficialMethods() {
  const typesRoot = join(repoRoot, "node_modules", "@atproto", "api", "dist", "client", "types", "com", "atproto");
  const skipFiles = new Set(["defs.d.ts", "schema.d.ts", "strongRef.d.ts"]);
  if (!existsSync(typesRoot)) {
    throw new Error("node_modules/@atproto/api is not installed; run npm install first");
  }

  const methods = [];
  for (const namespace of readdirSync(typesRoot)) {
    const namespacePath = join(typesRoot, namespace);
    if (!statSync(namespacePath).isDirectory()) {
      continue;
    }
    for (const file of readdirSync(namespacePath)) {
      if (!file.endsWith(".d.ts") || skipFiles.has(file)) {
        continue;
      }
      methods.push(`com.atproto.${namespace}.${file.replace(/\.d\.ts$/, "")}`);
    }
  }
  return sorted(methods);
}

function collectImplementedMethods() {
  const source = readFileSync(join(repoRoot, "src", "xrpc.rs"), "utf8");
  return sorted(unique([...source.matchAll(/"(com\.atproto\.[^"]+)"/g)].map((match) => match[1])));
}

function collectTestedMethods(officialMethods) {
  const officialSet = new Set(officialMethods);
  const scriptsRoot = join(repoRoot, "scripts");
  const content = readdirSync(scriptsRoot)
    .filter((file) => file.endsWith(".mjs") || file.endsWith(".sh"))
    .map((file) => readFileSync(join(scriptsRoot, file), "utf8"))
    .join("\n");
  return sorted(
    unique(
      [...content.matchAll(/com\.atproto\.[A-Za-z0-9_.]+/g)]
        .map((match) => match[0])
        .filter((method) => officialSet.has(method)),
    ),
  );
}

function printReport({
  official,
  implemented,
  tested,
  unsupported,
  implementedUntested,
  extraImplemented,
  missing,
  unclassifiedUntested,
  unexpectedExtra,
}) {
  const implementedOfficial = implemented.filter((method) => official.includes(method));
  const testedImplemented = implementedOfficial.filter((method) => tested.includes(method));
  console.log(
    JSON.stringify(
      {
        ok: missing.length === 0 && unclassifiedUntested.length === 0 && unexpectedExtra.length === 0,
        officialMethods: official.length,
        implementedOfficial: implementedOfficial.length,
        testedImplemented: testedImplemented.length,
        intentionallyUnsupported: unsupported.length,
        implementedUntested: implementedUntested.length,
        extraImplemented: extraImplemented.length,
        missing,
        unclassifiedUntested,
        unexpectedExtra,
      },
      null,
      2,
    ),
  );

  printList("Implemented but explicitly untested", implementedUntested);
  printList("Intentionally unsupported", unsupported);
  printList("Implemented outside current generated client", extraImplemented);
}

function printList(label, values) {
  if (values.length === 0) {
    return;
  }
  console.log(`\n${label}:`);
  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function sorted(values) {
  return unique(values).sort((left, right) => left.localeCompare(right));
}
