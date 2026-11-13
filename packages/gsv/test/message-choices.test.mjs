import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { messageChoiceTaken, messageChoicesText } from "../dist/protocol/message-choices.js";

const CHOICES = ["Plan my weekend", "Find the best deal", "Don't let me forget"];

describe("message choices", () => {
  it("finds the choice a reply takes by its words, counted from 1", () => {
    assert.equal(messageChoiceTaken("Plan my weekend", CHOICES), 1);
    assert.equal(messageChoiceTaken("Don't let me forget", CHOICES), 3);
    // a tap arrives as the choice itself; writing it by hand is the same answer
    assert.equal(messageChoiceTaken("  find the  best deal ", CHOICES), 2);
  });

  it("reads a bare number as the position in the written list", () => {
    // a messenger without buttons shows the choices as this numbered list
    assert.equal(messageChoicesText("Where do we start?", CHOICES).split("\n").at(-1), "3. Don't let me forget");
    assert.equal(messageChoiceTaken("3", CHOICES), 3);
    assert.equal(messageChoiceTaken(" 1 ", CHOICES), 1);
    assert.equal(messageChoiceTaken("4", CHOICES), null);
    assert.equal(messageChoiceTaken("0", CHOICES), null);
  });

  it("takes anything else as the person's own answer", () => {
    assert.equal(messageChoiceTaken("Can you book me a dentist?", CHOICES), null);
    assert.equal(messageChoiceTaken("Plan my weekend in Valencia", CHOICES), null);
    assert.equal(messageChoiceTaken("", CHOICES), null);
    assert.equal(messageChoiceTaken("1", []), null);
  });
});
