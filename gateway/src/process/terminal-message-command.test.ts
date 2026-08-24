import { describe, expect, it } from "vitest";
import { parseTerminalMessageCommand } from "./terminal-message-command";

describe("parseTerminalMessageCommand", () => {
  it("parses quoted send and silence commands", () => {
    expect(parseTerminalMessageCommand(
      `message send --message 'Here is the answer.'`,
    )).toEqual({
      ok: true,
      command: { action: "message", text: "Here is the answer." },
    });
    expect(parseTerminalMessageCommand(
      `message silence --reason "No interruption is useful."`,
    )).toEqual({
      ok: true,
      command: { action: "silence", reason: "No interruption is useful." },
    });
    expect(parseTerminalMessageCommand(
      `message send --message 'that'"'"'s two lines\nfrom GSV'`,
    )).toEqual({
      ok: true,
      command: { action: "message", text: "that's two lines\nfrom GSV" },
    });
    expect(parseTerminalMessageCommand(
      `message send --message 'hey, i'm here. what's up?'`,
    )).toEqual({
      ok: true,
      command: { action: "message", text: "hey, i'm here. what's up?" },
    });
  });

  it("parses opaque terminal message blocks", () => {
    expect(parseTerminalMessageCommand(
      `message send <<'GSV_MESSAGE'
Here's $HOME, \`literal code\`, and "both" quotes.

Nothing is evaluated.
GSV_MESSAGE`,
    )).toEqual({
      ok: true,
      command: {
        action: "message",
        text: `Here's $HOME, \`literal code\`, and "both" quotes.\n\nNothing is evaluated.`,
      },
    });
    expect(parseTerminalMessageCommand(
      `message silence <<'GSV_REASON'
The user's request was only informational.
GSV_REASON`,
    )).toEqual({
      ok: true,
      command: {
        action: "silence",
        reason: "The user's request was only informational.",
      },
    });
  });

  it("rejects an unterminated terminal message block", () => {
    expect(parseTerminalMessageCommand(
      `message send <<'GSV_MESSAGE'
This block never closes.`,
    )).toEqual({
      ok: false,
      action: "message",
      error: "Terminal message block must end with GSV_MESSAGE on its own line",
    });
  });

  it("accepts an attachment-only terminal send", () => {
    expect(parseTerminalMessageCommand("message send")).toEqual({
      ok: true,
      command: { action: "message", text: "" },
    });
    expect(parseTerminalMessageCommand("message send --message --also")).toEqual({
      ok: true,
      command: { action: "message", text: "--also" },
    });
  });

  it("leaves explicit additional sends to the ordinary shell command", () => {
    expect(parseTerminalMessageCommand(
      "message send --to telegram --message 'also there' --also",
    )).toBeNull();
  });

  it("rejects unsupported terminal options without executing them", () => {
    expect(parseTerminalMessageCommand(
      "message send --to telegram --message hi",
    )).toEqual({
      ok: false,
      action: "message",
      error: "Terminal message send does not accept --to",
    });
    expect(parseTerminalMessageCommand("message silence --reason")).toEqual({
      ok: false,
      action: "silence",
      error: "Terminal message silence requires a value after --reason",
    });
  });

  it("treats the message option tail as opaque text", () => {
    expect(parseTerminalMessageCommand(
      "message send --message safe; echo unsafe",
    )).toEqual({
      ok: true,
      command: { action: "message", text: "safe; echo unsafe" },
    });
    expect(parseTerminalMessageCommand(
      "message send --message safe | tee /tmp/copy",
    )).toEqual({
      ok: true,
      command: { action: "message", text: "safe | tee /tmp/copy" },
    });
    expect(parseTerminalMessageCommand(
      'message send --message "$HOME"',
    )).toEqual({
      ok: true,
      command: { action: "message", text: "$HOME" },
    });
    expect(parseTerminalMessageCommand(
      'message send --message "$(cat /root/secret)"',
    )).toEqual({
      ok: true,
      command: { action: "message", text: "$(cat /root/secret)" },
    });
  });
});
