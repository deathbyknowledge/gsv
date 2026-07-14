import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyBrowserError,
  createBrowserStepRunner,
  recordBrowserEvent,
} from "../../lib/browser-diagnostics.mjs";

test("classifies browser failures without retaining error content", () => {
  assert.equal(
    classifyBrowserError({ matcherResult: {}, message: "private page text" }),
    "assertion",
  );
  assert.equal(classifyBrowserError({ name: "TimeoutError", message: "private URL" }), "timeout");
  assert.equal(classifyBrowserError({ name: "TargetClosedError" }), "browser-closed");
  assert.equal(classifyBrowserError({ name: "AbortError" }), "aborted");
  assert.equal(classifyBrowserError(new Error("private credential")), "unexpected");
  assert.equal(classifyBrowserError({
    get name() {
      throw new Error("private getter content");
    },
  }), "unexpected");
});

test("retained browser events contain only the fixed schema", () => {
  const root = mkdtempSync(join(tmpdir(), "gsv-e2e-browser-diagnostic-"));
  const output = join(root, "browser.ndjson");
  try {
    recordBrowserEvent(output, {
      step: "open-setup",
      outcome: "failed",
      error_class: "unexpected",
      url: "https://private.example/credential",
      selector: "[data-private-selector]",
      message: "private page text",
      dom: "<main>private DOM</main>",
    });

    const encoded = readFileSync(output, "utf8");
    assert.deepEqual(JSON.parse(encoded), {
      step: "open-setup",
      outcome: "failed",
      error_class: "unexpected",
    });
    assert.doesNotMatch(encoded, /private|credential|selector|message|dom|https/iu);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(
      () => recordBrowserEvent(output, {
        step: "arbitrary-private-step",
        outcome: "failed",
        error_class: "unexpected",
      }),
      /step is invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("step runner records progress and rethrows the original failure", async () => {
  const events = [];
  const runStep = createBrowserStepRunner("unused", (_path, event) => events.push(event));
  assert.equal(await runStep("open-setup", async () => "result"), "result");

  const failure = Object.assign(new Error("private assertion details"), { matcherResult: {} });
  let caught;
  try {
    await runStep("enter-account", async () => {
      throw failure;
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, failure);
  assert.deepEqual(events, [
    { step: "open-setup", outcome: "started", error_class: "none" },
    { step: "open-setup", outcome: "passed", error_class: "none" },
    { step: "enter-account", outcome: "started", error_class: "none" },
    { step: "enter-account", outcome: "failed", error_class: "assertion" },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private|assertion details/);
});

test("diagnostic write failures do not change browser actions", async () => {
  const runStep = createBrowserStepRunner("unused", () => {
    throw new Error("diagnostic storage failed");
  });
  let actionRan = false;
  const result = await runStep("open-setup", async () => {
    actionRan = true;
    return "unchanged";
  });
  assert.equal(actionRan, true);
  assert.equal(result, "unchanged");
});
