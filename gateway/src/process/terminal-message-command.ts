export type TerminalMessageCommand =
  | { action: "message"; text: string }
  | { action: "silence"; reason: string };

export type TerminalMessageCommandParseResult =
  | { ok: true; command: TerminalMessageCommand }
  | { ok: false; action: TerminalMessageCommand["action"]; error: string };

export function parseTerminalMessageCommand(
  input: string,
): TerminalMessageCommandParseResult | null {
  const heredoc = parseTerminalHeredoc(input);
  if (heredoc) return heredoc;

  const words = tokenizeLiteralShellCommand(input);
  if (!words) return parseOpaqueMessageSend(input);
  if (words[0] !== "message") return null;
  const action = words[1];
  if (action !== "send" && action !== "silence") return null;
  if (action === "send" && hasAdditionalSendFlag(words.slice(2))) return null;

  const parsed = action === "send"
    ? parseMessageSend(words.slice(2))
    : parseMessageSilence(words.slice(2));
  if (parsed.ok || action === "silence") return parsed;
  return parseOpaqueMessageSend(input) ?? parsed;
}

function parseTerminalHeredoc(input: string): TerminalMessageCommandParseResult | null {
  const normalized = input.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.length < 2) return null;
  const header = lines.shift() ?? "";
  const match = /^message[ \t]+(send|silence)[ \t]+<<[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))[ \t]*$/.exec(header);
  if (!match) return null;
  const action = match[1] === "send" ? "message" : "silence";
  const delimiter = match[2] ?? match[3] ?? match[4] ?? "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(delimiter)) {
    return {
      ok: false,
      action,
      error: "Terminal message block delimiter is invalid",
    };
  }
  if (lines.at(-1) === "") lines.pop();
  if (lines.pop() !== delimiter) {
    return {
      ok: false,
      action,
      error: `Terminal message block must end with ${delimiter} on its own line`,
    };
  }
  const text = lines.join("\n");
  return action === "message"
    ? { ok: true, command: { action, text } }
    : { ok: true, command: { action, reason: text } };
}

function parseOpaqueMessageSend(input: string): TerminalMessageCommandParseResult | null {
  const match = /^message[ \t]+send[ \t]+--message(?:[ \t]+([\s\S]*))?$/.exec(input);
  if (!match) return null;
  const rawText = match[1];
  if (rawText === undefined) {
    return {
      ok: false,
      action: "message",
      error: "Terminal message send requires a value after --message",
    };
  }
  const text = rawText.trim();
  const first = text[0];
  const last = text.at(-1);
  const unwrapped = text.length >= 2
    && (first === "'" || first === '"')
    && last === first
    ? text.slice(1, -1)
    : text;
  return { ok: true, command: { action: "message", text: unwrapped } };
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
