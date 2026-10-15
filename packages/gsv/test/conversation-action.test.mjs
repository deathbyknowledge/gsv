import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationActionSchema, conversationActionText, validateConversationAction } from "../dist/protocol.js";

test("action requests retain user notes in the readable projection", () => {
  const action = { kind: "profile.discuss", name: "Ada", url: "https://ada.gsv.space/profile", note: "Help us plan a trip." };
  const text = conversationActionText(action);
  assert.ok(text.includes(action.url));
  assert.ok(text.endsWith(action.note));
  assert.deepEqual(validateConversationAction(action, text), action);
  assert.throws(() => validateConversationAction(action, "Send Ada a message"), /does not match/);
});

test("action metadata has bounded fields and cannot contain executable URLs or unknown controls", () => {
  for (const action of [
    { kind: "profile.discuss", name: "Ada", url: "javascript:alert(1)" },
    { kind: "file.discuss", target: "gsv", path: "" },
    { kind: "machine.connect", note: "x".repeat(32_769) },
    { kind: "browser.start", authorize: true },
    { kind: "unknown" },
  ]) assert.equal(conversationActionSchema.safeParse(action).success, false);
});
