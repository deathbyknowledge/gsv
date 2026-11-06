import { describe, expect, it } from "vitest";
import { parseRunControlCommand } from "./run-control-command";

describe("parseRunControlCommand", () => {
  it("parses sends that continue the run", () => {
    expect(parseRunControlCommand(`message send --message 'Here is an update.'`)).toEqual({
      ok: true,
      command: { action: "message", text: "Here is an update.", finish: false },
    });
    expect(parseRunControlCommand(`message send --message 'hey, i'm here. what's up?'`)).toEqual({
      ok: true,
      command: {
        action: "message",
        text: "hey, i'm here. what's up?",
        finish: false,
      },
    });
  });

  it("parses opaque message blocks with optional yield composition", () => {
    expect(
      parseRunControlCommand(
        `message send <<'GSV_MESSAGE'
Here's $HOME, \`literal code\`, and "both" quotes.

Nothing is evaluated.
GSV_MESSAGE`,
      ),
    ).toEqual({
      ok: true,
      command: {
        action: "message",
        text: `Here's $HOME, \`literal code\`, and "both" quotes.\n\nNothing is evaluated.`,
        finish: false,
      },
    });
    expect(
      parseRunControlCommand(
        `message send <<'GSV_MESSAGE' && yield
Finished.
GSV_MESSAGE`,
      ),
    ).toEqual({
      ok: true,
      command: { action: "message", text: "Finished.", finish: true },
    });
    expect(
      parseRunControlCommand(
        `message send <<'GSV_MESSAGE'
Finished.

GSV_MESSAGE

`,
      ),
    ).toEqual({
      ok: true,
      command: { action: "message", text: "Finished.\n", finish: false },
    });
  });

  it("parses standalone and one-line composed yield", () => {
    expect(parseRunControlCommand("yield")).toEqual({
      ok: true,
      command: { action: "yield" },
    });
    expect(parseRunControlCommand("yield now")).toEqual({
      ok: false,
      action: "yield",
      error: "yield does not accept arguments",
    });
    expect(parseRunControlCommand(`message send --message 'Finished.' && yield`)).toEqual({
      ok: true,
      command: { action: "message", text: "Finished.", finish: true },
    });
  });

  it("rejects an unterminated message block", () => {
    expect(
      parseRunControlCommand(
        `message send <<'GSV_MESSAGE'
This block never closes.`,
      ),
    ).toEqual({
      ok: false,
      action: "message",
      error: "Message block must end with GSV_MESSAGE on its own line",
    });
  });

  it("accepts an attachment-only current-conversation send", () => {
    expect(parseRunControlCommand("message send")).toEqual({
      ok: true,
      command: { action: "message", text: "", finish: false },
    });
    expect(parseRunControlCommand("message send && yield")).toEqual({
      ok: true,
      command: { action: "message", text: "", finish: true },
    });
  });

  it.each([
    "message send --to telegram --message 'also there' --also",
    "message send --to telegram --message 'also there'",
    "message send --message 'also there' --to telegram",
    "message send --message 'also there' --to telegram --also",
    "message send --to contact:friend --message hello",
    "message send --to message-destination:opaque --message hello && yield",
    "message send --to \"$DESTINATION\" --message hello",
    "message send --to",
    "message send --message 'Coming?' --choice --to --to telegram --also",
  ])("leaves an explicit destination to the ordinary shell: %s", (input) => {
    expect(parseRunControlCommand(input)).toBeNull();
  });

  it("rejects unsupported current-conversation options", () => {
    expect(parseRunControlCommand("message send --attach /tmp/file")).toEqual({
      ok: false,
      action: "message",
      error: "message send does not accept --attach for the current conversation; "
        + "stage files first with `message attach PATH...`, then issue `message send ...` "
        + "as its own direct Shell tool call without --to or --also",
    });
  });

  it.each(["--to", "--also", "Use --to telegram for a reminder."])(
    "keeps option-like message text in the current conversation: %s",
    (text) => {
      expect(parseRunControlCommand(`message send --message '${text}'`)).toEqual({
        ok: true,
        command: { action: "message", text, finish: false },
      });
    },
  );

  it("treats the message option tail as opaque text", () => {
    expect(parseRunControlCommand("message send --message safe; echo unsafe")).toEqual({
      ok: true,
      command: { action: "message", text: "safe; echo unsafe", finish: false },
    });
    expect(parseRunControlCommand('message send --message "$(cat /root/secret)"')).toEqual({
      ok: true,
      command: {
        action: "message",
        text: "$(cat /root/secret)",
        finish: false,
      },
    });
  });

  it("offers choices from either current-conversation form", () => {
    expect(parseRunControlCommand(
      "message send --message 'Mornings or nights?' --choice Mornings --choice 'Night  owl ' --choice Mornings",
    )).toEqual({
      ok: true,
      command: { action: "message", text: "Mornings or nights?", finish: false, choices: ["Mornings", "Night owl"] },
    });
    expect(parseRunControlCommand(`message send --choice Yes --choice 'Somewhere else' <<'GSV_MESSAGE' && yield
Is Lisbon home?
GSV_MESSAGE`)).toEqual({
      ok: true,
      command: { action: "message", text: "Is Lisbon home?", finish: true, choices: ["Yes", "Somewhere else"] },
    });
    expect(parseRunControlCommand("message send --message 'Your budget?' --choice 'Under $100'")).toEqual({
      ok: true,
      command: { action: "message", text: "Your budget?", finish: false, choices: ["Under $100"] },
    });
  });

  it.each([
    'message send --message "What\'s your budget?" --choice "Under $100"',
    "message send --message What's your budget? --choice Low",
    "message send --message 'Pick one' --choice A; echo B",
    "message send --choice \"Under $100\" <<'GSV_MESSAGE'\nYour budget?\nGSV_MESSAGE",
  ])("never sends a command offering choices as its text: %s", (input) => {
    expect(parseRunControlCommand(input)).toEqual({
      ok: false,
      action: "message",
      error: "quote the message and each choice on their own, as in --message 'Your budget?' "
        + "--choice 'Under $100'; single quotes keep $ and backticks as written",
    });
  });

  it("refuses choices it cannot offer rather than sending the command as text", () => {
    expect(parseRunControlCommand("message send --choice Yes")).toEqual({
      ok: false,
      action: "message",
      error: "choices answer a question: send them with the message that asks it",
    });
    const eleven = Array.from({ length: 11 }, (_, index) => `--choice ${index}`).join(" ");
    expect(parseRunControlCommand(`message send --message Pick ${eleven}`)).toEqual({
      ok: false,
      action: "message",
      error: "offer at most 10 choices",
    });
    expect(parseRunControlCommand(`message send --message Pick --choice '${"x".repeat(81)}'`)).toEqual({
      ok: false,
      action: "message",
      error: "each choice is at most 80 characters; keep it to a few words",
    });
    expect(parseRunControlCommand("message send --message Pick --choice")).toEqual({
      ok: false,
      action: "message",
      error: "message send requires a value after --choice",
    });
  });
});
