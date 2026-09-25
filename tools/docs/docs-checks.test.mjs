import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bodyOverride, evaluate, globToRegExp, labelOverride, loadCoverageMap } from "./check-docs-currency.mjs";
import { headingSlugs, slugify } from "./routes.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entries = loadCoverageMap();
const settingsFile = "web/src/app/features/instrument/settings/Preferences.tsx";

test("globs match nested paths and single segments", () => {
  assert.ok(globToRegExp("workers/adapters/**").test("workers/adapters/slack/src/index.ts"));
  assert.ok(globToRegExp("host/apps/cli/**").test("host/apps/cli/src/cli.rs"));
  assert.ok(!globToRegExp("workers/gateway/src/drivers/native/shell/**").test("workers/gateway/src/drivers/native/man-pages.ts"));
  assert.ok(globToRegExp("workers/gateway/src/kernel/config.ts").test("workers/gateway/src/kernel/config.ts"));
  assert.ok(!globToRegExp("workers/gateway/src/kernel/config.ts").test("workers/gateway/src/kernel/config.test.ts"));
});

test("a product change without docs is missing", () => {
  const result = evaluate([settingsFile], "", "", entries);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.entries.map((match) => match.entry.id), ["settings-models"]);
});

test("a change to one settings surface is not covered by another surface's page", () => {
  const result = evaluate(["web/src/app/features/instrument/settings/People.tsx", "docs/how-to/bring-your-own-model.md"], "", "", entries);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.entries.map((match) => match.entry.id), ["settings-people"]);
});

test("timezone, the model resolver, and each Instrument view have their own owners", () => {
  const tz = evaluate(["web/src/app/features/instrument/settings/Timezone.tsx", "docs/how-to/bring-your-own-model.md"], "", "", entries);
  assert.equal(tz.status, "missing");
  assert.deepEqual(tz.entries.map((match) => match.entry.id), ["settings-timezone"]);
  assert.equal(evaluate(["workers/gateway/src/kernel/ai.ts"], "", "", entries).status, "missing");
  const memory = evaluate(["web/src/app/features/instrument/memory/Memory.tsx", "docs/how-to/connect-devices.md"], "", "", entries);
  assert.equal(memory.status, "missing");
  assert.deepEqual(memory.entries.map((match) => match.entry.id), ["instrument-memory"]);
});

test("the desktop app and its native helpers are covered", () => {
  const result = evaluate(["web/src/desktop/DesktopMachineSetup.tsx", "docs/how-to/connect-devices.md"], "", "", entries);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.entries.map((match) => match.entry.id), ["desktop"]);
  assert.equal(evaluate(["host/helpers/gestures/src/control.rs", "docs/how-to/install-host-apps.md"], "", "", entries).status, "documented");
});

test("gateway syscall implementations are covered", () => {
  assert.equal(evaluate(["workers/gateway/src/kernel/sys/mcp.ts"], "", "", entries).status, "missing");
  assert.equal(evaluate(["workers/gateway/src/kernel/people.ts"], "", "", entries).status, "missing");
  assert.equal(evaluate(["workers/gateway/src/syscalls/codemode.ts"], "", "", entries).status, "missing");
});

test("a product change with a change to one of its own pages is documented", () => {
  assert.equal(evaluate([settingsFile, "docs/how-to/bring-your-own-model.md"], "", "", entries).status, "documented");
});

test("an unrelated docs change does not cover a product change", () => {
  const result = evaluate([settingsFile, "docs/architecture/telemetry.md"], "", "", entries);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.entries.map((match) => match.entry.id), ["settings-models"]);
});

test("only the entries left undocumented are reported", () => {
  const result = evaluate([settingsFile, "host/apps/cli/src/cli.rs", "docs/reference/cli-commands.md"], "", "", entries);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.entries.map((match) => match.entry.id), ["settings-models"]);
});

test("an unmapped change is clean", () => {
  assert.equal(evaluate(["workers/gateway/src/kernel/schema/v052_add_ledger_purpose.ts"], "", "", entries).status, "clean");
});

test("the label waives the check", () => {
  assert.equal(labelOverride("bug, docs-not-needed"), "label docs-not-needed");
  assert.equal(labelOverride("bug,documentation"), null);
  assert.equal(evaluate([settingsFile], "docs-not-needed", "", entries).status, "waived");
});

test("a Docs: line with a reason waives the check", () => {
  assert.equal(bodyOverride("Summary\n\nDocs: not needed — pure styling change\n"), "Docs: not needed — pure styling change");
  assert.equal(bodyOverride("Docs: gsv-manual PR https://github.com/deathbyknowledge/gsv-manual/pull/12"), "Docs: gsv-manual PR https://github.com/deathbyknowledge/gsv-manual/pull/12");
  assert.equal(evaluate([settingsFile], "", "Docs: not needed — pure styling change", entries).status, "waived");
});

test("an empty or indented Docs: line does not waive the check", () => {
  assert.equal(bodyOverride("Docs:"), null);
  assert.equal(bodyOverride("Docs: n/a"), null);
  assert.equal(bodyOverride("Docs: tbd"), null);
  assert.equal(bodyOverride("  Docs: not needed — indented"), null);
  assert.equal(bodyOverride(null), null);
  assert.equal(bodyOverride("null"), null);
});

test("the untouched pull request template does not waive the check", () => {
  const template = readFileSync(join(repositoryRoot, ".github", "pull_request_template.md"), "utf8");
  assert.equal(bodyOverride(template), null);
  assert.equal(evaluate([settingsFile], "", template, entries).status, "missing");
});

test("every coverage-map doc page exists", () => {
  for (const entry of entries) {
    for (const doc of entry.docs) {
      assert.doesNotThrow(() => readFileSync(join(repositoryRoot, doc)), `${entry.id} names ${doc}`);
    }
  }
});

test("heading slugs follow VitePress", () => {
  assert.equal(slugify("Context Compaction & Memory"), "context-compaction-memory");
  assert.equal(slugify("Tool Approval Policy"), "tool-approval-policy");
  assert.equal(slugify("`sys.ledger.list`"), "sys-ledger-list");
  const slugs = headingSlugs("# Title\n\n## Tool purpose\n\n```ts\n## not a heading\n```\n\n### Custom {#my-id}\n");
  assert.deepEqual([...slugs], ["title", "tool-purpose", "my-id"]);
});
