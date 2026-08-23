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

  it("does not terminalize compound shell programs", () => {
    expect(parseTerminalMessageCommand(
      "message send --message safe; echo unsafe",
    )).toBeNull();
    expect(parseTerminalMessageCommand(
      "message send --message safe | tee /tmp/copy",
    )).toBeNull();
  });

  it("does not evaluate shell expansions in a terminal command", () => {
    expect(parseTerminalMessageCommand(
      'message send --message "$HOME"',
    )).toBeNull();
    expect(parseTerminalMessageCommand(
      'message send --message "$(cat /root/secret)"',
    )).toBeNull();
  });
});
