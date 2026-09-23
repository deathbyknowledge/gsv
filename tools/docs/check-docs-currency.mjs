import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Documentation is an output of a product change, not a follow-up. Given the
 * paths a pull request changed, this maps them through coverage-map.json and
 * fails when a documented surface changed but nothing under docs/ did, unless
 * the pull request says why: the docs-not-needed label, or a body line that
 * starts with `Docs:`.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SKIP_LABEL = "docs-not-needed";
const EMPTY_REASONS = new Set(["n/a", "na", "none", "no", "-", "tbd", "todo"]);

export function loadCoverageMap() {
  return JSON.parse(readFileSync(join(repositoryRoot, "tools", "docs", "coverage-map.json"), "utf8")).entries;
}

export function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += pattern[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** The label waiver: the pull request carries docs-not-needed. */
export function labelOverride(labels) {
  const names = (labels ?? "").split(",").map((label) => label.trim());
  return names.includes(SKIP_LABEL) ? `label ${SKIP_LABEL}` : null;
}

/**
 * The body waiver: a line starting at column one with `Docs:` and a reason.
 * Indented lines do not count, so the examples inside the pull request
 * template's comment cannot satisfy the check by accident.
 */
export function bodyOverride(body) {
  const text = body ?? "";
  if (text === "null") return null;
  for (const match of text.matchAll(/^Docs:[ \t]*(.*)$/gm)) {
    const reason = match[1].trim();
    if (reason.length >= 8 && !EMPTY_REASONS.has(reason.toLowerCase())) return `Docs: ${reason}`;
  }
  return null;
}

/** Decide for a set of changed paths. Returns { status, entries, override }. */
export function evaluate(changed, labels, body, entries) {
  const matched = entries
    .map((entry) => ({
      entry,
      files: changed.filter((path) => entry.paths.some((pattern) => globToRegExp(pattern).test(path))),
    }))
    .filter((match) => match.files.length > 0);
  if (matched.length === 0) return { status: "clean", entries: [] };
  if (changed.some((path) => path.startsWith("docs/"))) return { status: "documented", entries: matched };
  const override = labelOverride(labels) ?? bodyOverride(body);
  if (override) return { status: "waived", entries: matched, override };
  return { status: "missing", entries: matched };
}

export function formatMissing(matched) {
  const lines = ["docs currency: these changes touch documented surfaces but no docs/ file changed."];
  for (const { entry, files } of matched) {
    for (const file of files) lines.push(`  ${entry.id.padEnd(18)}${file}`);
    for (const doc of entry.docs) lines.push(`    expects ${doc}`);
    for (const page of entry.manual ?? []) lines.push(`    manual  ${page} (deathbyknowledge/gsv-manual)`);
  }
  lines.push(
    `Update the pages above, or add the ${SKIP_LABEL} label, or put a line in the`,
    "pull request body starting with \"Docs:\" that says why (see",
    ".github/pull_request_template.md).",
  );
  return lines.join("\n");
}

function readChangedPaths(argv) {
  if (argv.includes("--stdin")) {
    return { paths: readFileSync(0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean) };
  }
  const flag = argv.indexOf("--base");
  const base = flag >= 0 ? argv[flag + 1] : process.env.DOCS_BASE_REF;
  if (!base) return { paths: null, reason: "no base ref" };
  const output = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: repositoryRoot, encoding: "utf8" });
  return { paths: output.split("\n").map((line) => line.trim()).filter(Boolean) };
}

function main() {
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_NAME !== "pull_request") {
    console.log("docs currency: not a pull request; skipped.");
    return;
  }
  const changed = readChangedPaths(process.argv.slice(2));
  if (changed.paths === null) {
    console.log(`docs currency: ${changed.reason}; skipped.`);
    return;
  }
  const result = evaluate(changed.paths, process.env.DOCS_PR_LABELS, process.env.DOCS_PR_BODY, loadCoverageMap());
  if (result.status === "missing") {
    console.error(formatMissing(result.entries));
    process.exitCode = 1;
    return;
  }
  if (result.status === "waived") console.log(`docs currency: skipped (${result.override})`);
  else if (result.status === "documented") console.log("docs currency: documented surfaces changed alongside docs/.");
  else console.log("docs currency: no documented surface changed.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
