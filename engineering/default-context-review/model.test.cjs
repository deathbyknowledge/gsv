const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const reviewDir = __dirname;
const sandbox = { window: {}, globalThis: {}, TextEncoder };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(reviewDir, "snapshot.js"), "utf8"), sandbox);
const model = require("./model.js");
const snapshot = sandbox.window.GSV_CONTEXT_REVIEW_SNAPSHOT;

test("composes the fresh personal-agent prompt in runtime order", () => {
  const scenario = {
    ...snapshot.defaultScenario,
    currentDate: "2026-07-26",
  };
  const result = model.composePrompt(snapshot, {}, scenario);

  assert.equal(result.activeBlocks, 10);
  assert.match(result.text, /^<system path="\/sys\/config\/ai\/context\.d\/">\n<00-runtime\.md>/);
  assert.ok(result.text.indexOf("<00-runtime.md>") < result.text.indexOf("<01-gsv.md>"));
  assert.ok(result.text.indexOf("<01-gsv.md>") < result.text.indexOf("<30-process-orchestration.md>"));
  assert.ok(result.text.indexOf("<program path=\"/home/friday/context.d/\">") > result.text.indexOf("</system>"));
  assert.ok(result.text.indexOf("<00-boot.md>") < result.text.indexOf("<00-style.md>"));
  assert.ok(result.text.indexOf("<available_skills>") > result.text.indexOf("</program>"));
  assert.match(result.text, /User: alex\nUser home: \/home\/alex/);
  assert.match(result.text, /Current program: friday\nProgram home: \/home\/friday/);
  assert.match(result.text, /Current date: 2026-07-26\nCurrent timezone: Europe\/Amsterdam/);
  assert.doesNotMatch(result.text, /<user path=/);
  assert.doesNotMatch(result.text, /<process path=/);
});

test("excluding boot removes the file and preserves the surrounding serialization", () => {
  const states = {
    "program:00-boot.md": {
      template: snapshot.blocks.find((block) => block.id === "program:00-boot.md").template,
      included: false,
    },
  };
  const result = model.composePrompt(snapshot, states, {
    ...snapshot.defaultScenario,
    currentDate: "2026-07-26",
  });

  assert.equal(result.activeBlocks, 9);
  assert.doesNotMatch(result.text, /<00-boot.md>/);
  assert.match(result.text, /<program path="\/home\/friday\/context\.d\/">\n<00-style.md>/);
  assert.ok(result.text.endsWith("</available_skills>"));
});

test("the adjacent first message is not folded into systemPrompt", () => {
  const scenario = { ...snapshot.defaultScenario, currentDate: "2026-07-26", firstMessage: "Hi Friday" };
  const result = model.composePrompt(snapshot, {}, scenario);
  const message = model.firstUserMessage(snapshot, scenario);

  assert.equal(message, [
    "[From: GSV Web Desktop]",
    "[Reply destination: automatic to this GSV client.]",
    "Hi Friday",
  ].join("\n"));
  assert.equal(result.text.includes("Hi Friday"), false);
});
