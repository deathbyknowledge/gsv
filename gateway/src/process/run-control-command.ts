export type RunControlCommand =
  | { action: "message"; text: string; finish: boolean }
  | { action: "yield" };

export type RunControlCommandParseResult =
  | { ok: true; command: RunControlCommand }
  | { ok: false; action: RunControlCommand["action"]; error: string };

export function parseRunControlCommand(
  input: string,
): RunControlCommandParseResult | null {
  const heredoc = parseMessageHeredoc(input);
  if (heredoc) return heredoc;

  const composed = splitYieldSuffix(input);
  if (composed) {
    const message = parseMessageCommand(composed);
    if (!message) return null;
    if (!message.ok) return message;
    if (message.command.action !== "message") return null;
    return {
      ok: true,
      command: { ...message.command, finish: true },
    };
  }

  const words = tokenizeLiteralShellCommand(input);
  if (!words) return parseOpaqueMessageSend(input, false);
  if (words[0] === "yield") {
    return words.length === 1
      ? { ok: true, command: { action: "yield" } }
      : { ok: false, action: "yield", error: "yield does not accept arguments" };
  }
  return parseMessageWords(input, words, false);
}

function parseMessageHeredoc(input: string): RunControlCommandParseResult | null {
  const normalized = input.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.length < 2) return null;
  const header = lines.shift() ?? "";
  const match = /^message[ \t]+send[ \t]+<<[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:[ \t]+&&[ \t]+yield)?[ \t]*$/.exec(header);
  if (!match) return null;
  const finish = /&&[ \t]+yield[ \t]*$/.test(header);
  const delimiter = match[1] ?? match[2] ?? match[3] ?? "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(delimiter)) {
    return {
      ok: false,
      action: "message",
      error: "Message block delimiter is invalid",
    };
  }
  if (lines.at(-1) === "") lines.pop();
  if (lines.pop() !== delimiter) {
    return {
      ok: false,
      action: "message",
      error: `Message block must end with ${delimiter} on its own line`,
    };
  }
  return {
    ok: true,
    command: { action: "message", text: lines.join("\n"), finish },
  };
}

function splitYieldSuffix(input: string): string | null {
  const match = /^([\s\S]*\S)[ \t]+&&[ \t]+yield[ \t]*$/.exec(input);
  return match?.[1] ?? null;
}

function parseMessageCommand(input: string): RunControlCommandParseResult | null {
  const words = tokenizeLiteralShellCommand(input);
  if (!words) return parseOpaqueMessageSend(input, false);
  return parseMessageWords(input, words, false);
}

function parseMessageWords(
  input: string,
  words: string[],
  finish: boolean,
): RunControlCommandParseResult | null {
  if (words[0] !== "message" || words[1] !== "send") return null;
  if (hasAdditionalSendFlag(words.slice(2))) return null;
  const parsed = parseMessageSend(words.slice(2), finish);
  if (parsed.ok) return parsed;
  return parseOpaqueMessageSend(input, finish) ?? parsed;
}

function parseOpaqueMessageSend(
  input: string,
  finish: boolean,
): RunControlCommandParseResult | null {
  const match = /^message[ \t]+send[ \t]+--message(?:[ \t]+([\s\S]*))?$/.exec(input);
  if (!match) return null;
  const rawText = match[1];
  if (rawText === undefined) {
    return {
      ok: false,
      action: "message",
      error: "message send requires a value after --message",
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
  return { ok: true, command: { action: "message", text: unwrapped, finish } };
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

function parseMessageSend(
  args: string[],
  finish: boolean,
): RunControlCommandParseResult {
  let text = "";
  let hasMessage = false;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current !== "--message") {
      return {
        ok: false,
        action: "message",
        error: `message send does not accept ${current} for the current conversation`,
      };
    }
    if (hasMessage) {
      return {
        ok: false,
        action: "message",
        error: "message send accepts --message once",
      };
    }
    index += 1;
    if (index >= args.length) {
      return {
        ok: false,
        action: "message",
        error: "message send requires a value after --message",
      };
    }
    text = args[index];
    hasMessage = true;
  }
  return { ok: true, command: { action: "message", text, finish } };
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
