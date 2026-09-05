import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The syscall reference is written by hand, so this keeps its signatures in
 * step with the SDK's syscall table: every call the SDK declares has a typed
 * entry on the page, and the page names no call the SDK no longer has.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mapPath = join(repositoryRoot, "packages", "gsv", "src", "protocol", "syscalls", "map.ts");
const docsPath = join(repositoryRoot, "docs", "reference", "syscalls.md");

const declared = new Set(
  [...readFileSync(mapPath, "utf8").matchAll(/^ {2}"([a-z0-9.]+)": \{/gm)].map((match) => match[1]),
);
const documented = new Set();
for (const block of readFileSync(docsPath, "utf8").matchAll(/```ts\n([\s\S]*?)```/g)) {
  for (const entry of block[1].matchAll(/^\s*"([a-z0-9.]+)": \{/gm)) documented.add(entry[1]);
}

const missing = [...declared].filter((call) => !documented.has(call)).sort();
const stale = [...documented].filter((call) => !declared.has(call)).sort();
if (missing.length > 0) {
  console.error(`docs/reference/syscalls.md lacks a signature for: ${missing.join(", ")}`);
}
if (stale.length > 0) {
  console.error(`docs/reference/syscalls.md documents calls the SDK no longer declares: ${stale.join(", ")}`);
}
if (missing.length > 0 || stale.length > 0) process.exitCode = 1;
