export type TerminalMessageCommand =
  | { action: "message"; text: string }
  | { action: "silence"; reason: string };

export type TerminalMessageCommandParseResult =
  | { ok: true; command: TerminalMessageCommand }
  | { ok: false; action: TerminalMessageCommand["action"]; error: string };

export function parseTerminalMessageCommand(
  input: string,
): TerminalMessageCommandParseResult | null {
  const words = tokenizeLiteralShellCommand(input);
  if (!words || words[0] !== "message") return null;
  const action = words[1];
  if (action !== "send" && action !== "silence") return null;
  if (action === "send" && hasAdditionalSendFlag(words.slice(2))) return null;

  return action === "send"
    ? parseMessageSend(words.slice(2))
    : parseMessageSilence(words.slice(2));
}

function hasAdditionalSendFlag(args: string[]): boolean {
  const optionsWithValues = new Set([
    "--message",
    "--to",
    "--attach",
    "--mime",
    "--delivery-id",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--also") return true;
    if (optionsWithValues.has(current)) index += 1;
  }
  return false;
}

function parseMessageSend(args: string[]): TerminalMessageCommandParseResult {
  let text = "";
  let hasMessage = false;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current !== "--message") {
      return {
        ok: false,
        action: "message",
        error: `Terminal message send does not accept ${current}`,
      };
    }
    if (hasMessage) {
      return {
        ok: false,
        action: "message",
        error: "Terminal message send accepts --message once",
      };
    }
    index += 1;
    if (index >= args.length) {
      return {
        ok: false,
        action: "message",
        error: "Terminal message send requires a value after --message",
      };
    }
    text = args[index];
    hasMessage = true;
  }
  return { ok: true, command: { action: "message", text } };
}

function parseMessageSilence(args: string[]): TerminalMessageCommandParseResult {
  let reason = "";
  let hasReason = false;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current !== "--reason") {
      return {
        ok: false,
        action: "silence",
        error: `Terminal message silence does not accept ${current}`,
      };
    }
    if (hasReason) {
      return {
        ok: false,
        action: "silence",
        error: "Terminal message silence accepts --reason once",
      };
    }
    index += 1;
    if (index >= args.length) {
      return {
        ok: false,
        action: "silence",
        error: "Terminal message silence requires a value after --reason",
      };
    }
    reason = args[index];
    hasReason = true;
  }
  return { ok: true, command: { action: "silence", reason } };
}

function tokenizeLiteralShellCommand(input: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "single" | "double" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      else word += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "$" || character === "`") return null;
      if (character === "\\") {
        index += 1;
        if (index >= input.length) return null;
        word += input[index];
        continue;
      }
      word += character;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      wordStarted = true;
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (index >= input.length) return null;
      word += input[index];
      wordStarted = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      if (wordStarted) words.push(word);
      word = "";
      wordStarted = false;
      continue;
    }
    if (
      character === "\n"
      || character === ";"
      || character === "&"
      || character === "|"
      || character === "<"
      || character === ">"
      || character === "("
      || character === ")"
      || character === "$"
      || character === "`"
      || character === "#"
    ) {
      return null;
    }
    word += character;
    wordStarted = true;
  }
  if (quote) return null;
  if (wordStarted) words.push(word);
  return words;
}
