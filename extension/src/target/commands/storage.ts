import { hasHelpFlag } from "./args";
import type { BrowserCommand, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const STORAGE_USAGE = [
  "Usage: storage local get [key]",
  "       storage local set <key> <json-or-string>",
  "       storage local delete <key>",
].join("\n");

export const storageCommand: BrowserCommand = {
  name: "storage",
  summary: "Read or write chrome.storage.local values",
  async run(args: string[]): Promise<CommandResult> {
    if (hasHelpFlag(args)) {
      return commandOk(`${STORAGE_USAGE}\n`);
    }

    const area = args[0] ?? "";
    if (area !== "local") {
      return commandError(STORAGE_USAGE);
    }

    const subcommand = args[1] ?? "";
    try {
      switch (subcommand) {
        case "get":
          return storageGet(args.slice(2));
        case "set":
          return storageSet(args.slice(2));
        case "delete":
        case "rm":
          return storageDelete(args.slice(2));
        default:
          return commandError(STORAGE_USAGE);
      }
    } catch (error) {
      return commandError(errorMessage(error));
    }
  },
};

export default storageCommand;

async function storageGet(args: string[]): Promise<CommandResult> {
  if (args.length > 1) {
    return commandError(STORAGE_USAGE);
  }

  const key = args[0];
  if (key !== undefined) {
    const parsed = validateStorageKey(key);
    if (!parsed.ok) {
      return commandError(parsed.error);
    }
  }

  const items = await requireLocalStorage().get<Record<string, unknown>>(key ?? null);
  return commandJson(items);
}

async function storageSet(args: string[]): Promise<CommandResult> {
  if (args.length < 2) {
    return commandError(STORAGE_USAGE);
  }

  const key = validateStorageKey(args[0]);
  if (!key.ok) {
    return commandError(key.error);
  }

  const value = parseJsonOrString(args.slice(1).join(" "));
  await requireLocalStorage().set<Record<string, unknown>>({ [key.value]: value });
  return commandOk(`stored ${key.value}\n`);
}

async function storageDelete(args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    return commandError(STORAGE_USAGE);
  }

  const key = validateStorageKey(args[0]);
  if (!key.ok) {
    return commandError(key.error);
  }

  await requireLocalStorage().remove<Record<string, unknown>>(key.value);
  return commandOk(`deleted ${key.value}\n`);
}

function requireLocalStorage(): typeof chrome.storage.local {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    throw new Error("chrome.storage.local is unavailable; check the storage permission.");
  }
  return chrome.storage.local;
}

function validateStorageKey(input: string | undefined): ParseResult<string> {
  const key = input ?? "";
  if (!key) {
    return { ok: false, error: "missing storage key" };
  }
  if (/[\x00-\x1f\x7f]/.test(key)) {
    return { ok: false, error: "storage key must not contain control characters" };
  }
  return { ok: true, value: key };
}

function parseJsonOrString(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
