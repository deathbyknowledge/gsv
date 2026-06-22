import { hasHelpFlag } from "./args";
import type { BrowserCommand, CommandContext, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";

type ClipboardApi = {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
};

type NavigatorWithOptionalClipboard = {
  clipboard?: ClipboardApi;
};

const CLIPBOARD_USAGE = [
  "Usage: clipboard read",
  "       clipboard write <text>",
  "       echo text | clipboard write",
].join("\n");

export const clipboardCommand: BrowserCommand = {
  name: "clipboard",
  summary: "Read or write clipboard text",
  async run(args: string[], ctx: CommandContext): Promise<CommandResult> {
    if (hasHelpFlag(args)) {
      return commandOk(`${CLIPBOARD_USAGE}\n`);
    }

    const subcommand = args[0] ?? "";
    switch (subcommand) {
      case "read":
        return readClipboard();
      case "write":
        return writeClipboard(args.slice(1), ctx);
      default:
        return commandError(CLIPBOARD_USAGE);
    }
  },
};

export default clipboardCommand;

async function readClipboard(): Promise<CommandResult> {
  const clipboard = getClipboardApi();
  if (!clipboard?.readText) {
    return commandError(clipboardUnavailableMessage("read"));
  }

  try {
    const text = await clipboard.readText();
    return commandJson({
      text,
      bytes: byteLength(text),
    });
  } catch (error) {
    return commandError(`clipboard read failed: ${errorMessage(error)}`);
  }
}

async function writeClipboard(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const clipboard = getClipboardApi();
  if (!clipboard?.writeText) {
    return commandError(clipboardUnavailableMessage("write"));
  }

  const text = args.length > 0 ? args.join(" ") : ctx.stdin;
  if (args.length === 0 && text.length === 0) {
    return commandError(CLIPBOARD_USAGE);
  }

  try {
    await clipboard.writeText(text);
    return commandOk(`copied ${byteLength(text)} bytes\n`);
  } catch (error) {
    return commandError(`clipboard write failed: ${errorMessage(error)}`);
  }
}

function getClipboardApi(): ClipboardApi | undefined {
  return (globalThis.navigator as NavigatorWithOptionalClipboard | undefined)?.clipboard;
}

function clipboardUnavailableMessage(action: "read" | "write"): string {
  return [
    `Clipboard ${action} is unavailable in this browser target context.`,
    "MV3 service workers do not expose navigator.clipboard; use an offscreen document bridge to enable this command.",
  ].join(" ");
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
