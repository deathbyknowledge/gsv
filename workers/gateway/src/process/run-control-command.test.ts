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
});
