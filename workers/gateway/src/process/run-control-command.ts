import { MESSAGE_CHOICE_LENGTH_LIMIT, MESSAGE_CHOICE_LIMIT } from "@humansandmachines/gsv/protocol";
import { Bash, type SimpleCommandNode, type StatementNode, type WordNode } from "just-bash";

const runControlBash = new Bash({ commands: [] });

export type RunControlCommand =
  | {
    action: "message";
    text: string;
    finish: boolean;
    /** A send with nothing to say: a final message when staged media makes it one, a bare yield otherwise. */
    emptyMeansYield?: true;
    /** Files to send with the message, as the Send tool names them: `path`, `target:path`, or `[target]:path`. */
    attach?: string[];
    /** Short replies the person can tap instead of writing one. */
    choices?: string[];
  }
  | { action: "yield" };

/**
 * Where a file a Send names lives. The same spelling the shell's `cp` reads:
 * `[target]:path` for a path that itself contains a colon, `target:path`, or a
 * bare path on the cloud home.
 */
export type AttachPlace = { target: string; path: string };

export function parseAttachPath(spec: string): AttachPlace {
  const bracket = spec.match(/^\[([^\]]*)]:(.*)$/);
  if (bracket) return { target: bracket[1] || "gsv", path: bracket[2] };
  const qualified = spec.match(/^([A-Za-z0-9_.-]+):(.*)$/);
  if (qualified) return { target: qualified[1], path: qualified[2] };
  return { target: "gsv", path: spec };
}

/**
 * The replies a message offers, as the person will see them: one line each,
 * spacing collapsed, blanks and repeats dropped. They answer the message's
 * question, so a message offering any has text.
 */
export function normalizeMessageChoices(
  text: string,
  raw: readonly string[],
): { ok: true; choices: string[] } | { ok: false; error: string } {
  const choices = [...new Set(raw.map((choice) => choice.replace(/\s+/gu, " ").trim()).filter((choice) => choice !== ""))];
  if (choices.length > 0 && !text.trim()) {
    return { ok: false, error: "choices answer a question: send them with the message that asks it" };
  }
  if (choices.length > MESSAGE_CHOICE_LIMIT) {
    return { ok: false, error: `offer at most ${MESSAGE_CHOICE_LIMIT} choices` };
  }
  if (choices.some((choice) => [...choice].length > MESSAGE_CHOICE_LENGTH_LIMIT)) {
    return { ok: false, error: `each choice is at most ${MESSAGE_CHOICE_LENGTH_LIMIT} characters; keep it to a few words` };
  }
  return { ok: true, choices };
}

/**
 * A choice is offered word for word, so a send offering choices is never read
 * as one opaque message, which would show the person its quoting and flags.
 */
const UNREADABLE_CHOICES: RunControlCommandParseResult = {
  ok: false,
  action: "message",
  error: "quote the message and each choice on their own, as in --message 'Your budget?' "
    + "--choice 'Under $100'; single quotes keep $ and backticks as written",
};

export type RunControlCommandParseResult =
  | { ok: true; command: RunControlCommand }
  | { ok: false; action: RunControlCommand["action"]; error: string };

export function parseRunControlCommand(input: string): RunControlCommandParseResult | null {
  let statements: StatementNode[];
  try {
    statements = runControlBash.transform(input).ast.statements;
  } catch (error) {
    const delimiter = error instanceof Error ? unterminatedMessageDelimiter(input, error) : null;
    if (delimiter) {
      return {
        ok: false,
        action: "message",
        error: `Message block must end with ${delimiter} on its own line`,
      };
    }
    return parseOpaqueMessageSend(input, false);
  }
  if (statements.length !== 1) return parseOpaqueMessageSend(input, false);

  const control = controlCommand(statements[0]);
  if (!control) return parseOpaqueMessageSend(input, false);
  const name = literalWord(control.command.name);
  if (name === "yield") {
    return control.command.args.length === 0 && control.command.redirections.length === 0
      ? { ok: true, command: { action: "yield" } }
      : {
          ok: false,
          action: "yield",
          error: "yield does not accept arguments",
        };
  }
  if (name !== "message" || literalWord(control.command.args[0]) !== "send") return null;
  return parseMessageCommand(input, control.command, control.finish);
}

function controlCommand(
  statement: StatementNode,
): { command: SimpleCommandNode; finish: boolean } | null {
  if (statement.background || statement.pipelines.length > 2) return null;
  const command = simpleCommand(statement, 0);
  if (!command) return null;
  if (statement.pipelines.length === 1) {
    return statement.operators.length === 0 ? { command, finish: false } : null;
  }
  const suffix = simpleCommand(statement, 1);
  return statement.operators.length === 1 &&
    statement.operators[0] === "&&" &&
    suffix !== null &&
    literalWord(suffix.name) === "yield" &&
    suffix.args.length === 0 &&
    suffix.redirections.length === 0
    ? { command, finish: true }
    : null;
}

function simpleCommand(statement: StatementNode, index: number): SimpleCommandNode | null {
  const pipeline = statement.pipelines[index];
  const command = pipeline?.commands[0];
  return pipeline &&
    !pipeline.negated &&
    !pipeline.timed &&
    pipeline.commands.length === 1 &&
    command?.type === "SimpleCommand" &&
    command.assignments.length === 0
    ? command
    : null;
}

function parseMessageCommand(
  input: string,
  command: SimpleCommandNode,
  finish: boolean,
): RunControlCommandParseResult | null {
  const args = command.args.map(literalWord);
  if (hasExplicitSendOption(args.slice(1))) return null;
  if (args.includes("--choice") && args.includes(null)) return UNREADABLE_CHOICES;
  if (command.redirections.length > 0) {
    return parseMessageHeredoc(input, command, finish);
  }
  if (!args.every((arg): arg is string => arg !== null)) {
    return parseOpaqueMessageSend(messageSource(input, finish), finish);
  }
  const parsed = parseMessageSend(args.slice(1), finish);
  // Unquoted words after --message are one opaque message, but a send offering choices is never read that way.
  return parsed.ok || args.includes("--choice")
    ? parsed
    : (parseOpaqueMessageSend(messageSource(input, finish), finish) ?? parsed);
}

function parseMessageHeredoc(
  input: string,
  command: SimpleCommandNode,
  finish: boolean,
): RunControlCommandParseResult | null {
  const raw = choiceOptions(command.args.slice(1).map(literalWord));
  if (!raw || command.redirections.length !== 1) return null;
  const redirection = command.redirections[0];
  if (
    (redirection.operator !== "<<" && redirection.operator !== "<<-") ||
    redirection.target.type !== "HereDoc"
  )
    return null;
  const heredoc = redirection.target;
  if (!heredoc.terminated) {
    return {
      ok: false,
      action: "message",
      error: `Message block must end with ${heredoc.delimiter} on its own line`,
    };
  }
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  const terminatorIndex = lines.findIndex((line, index) =>
    index > 0 &&
    (heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter
  );
  if (terminatorIndex < 0) return null;
  const text = lines
    .slice(1, terminatorIndex)
    .map((line) => (heredoc.stripTabs ? line.replace(/^\t+/, "") : line))
    .join("\n");
  return messageCommand(text, finish, raw);
}

/** The `--choice` values of a message block's header, or null when it has another option. */
function choiceOptions(args: ReadonlyArray<string | null>): string[] | null {
  const choices: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] !== "--choice" || value === null || value === undefined) return null;
    choices.push(value);
  }
  return choices;
}

function messageCommand(text: string, finish: boolean, raw: readonly string[]): RunControlCommandParseResult {
  const offered = normalizeMessageChoices(text, raw);
  if (!offered.ok) return { ok: false, action: "message", error: offered.error };
  return {
    ok: true,
    command: { action: "message", text, finish, ...(offered.choices.length > 0 ? { choices: offered.choices } : undefined) },
  };
}

function messageSource(input: string, finish: boolean): string {
  if (!finish) return input;
  const source = runControlBash.transform(input).ast.statements[0]?.sourceText ?? input;
  return source.replace(/[ \t]+&&[ \t]+yield[ \t]*$/, "");
}

function unterminatedMessageDelimiter(input: string, error: Error): string | null {
  if (!error.message.includes("unterminated here-document")) {
    return null;
  }
  const header = input.split(/\r?\n/, 1)[0];
  const match = /^message[ \t]+send[ \t]+<<-?[ \t]*(?:'([^']+)'|"([^"]+)"|([^ \t]+))/.exec(header);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
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
  if (/(?:^|\s)--choice(?:[\s=]|$)/u.test(rawText)) return UNREADABLE_CHOICES;
  const text = rawText.trim();
  const quote = text[0];
  const unwrapped =
    text.length >= 2 && (quote === "'" || quote === '"') && text.at(-1) === quote
      ? text.slice(1, -1)
      : text;
  return { ok: true, command: { action: "message", text: unwrapped, finish } };
}

function hasExplicitSendOption(args: Array<string | null>): boolean {
  const optionsWithValues = new Set(["--message", "--choice", "--to", "--attach", "--mime", "--delivery-id"]);
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--to" || current === "--also") return true;
    if (current && optionsWithValues.has(current)) index += 1;
  }
  return false;
}

function parseMessageSend(args: string[], finish: boolean): RunControlCommandParseResult {
  let text: string | undefined;
  const choices: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (option !== "--message" && option !== "--choice") {
      return {
        ok: false,
        action: "message",
        error: `message send does not accept ${option} for the current conversation; `
          + "stage files first with `message attach PATH...`, then issue `message send ...` "
          + "as its own direct Shell tool call without --to or --also",
      };
    }
    const value = args[index + 1];
    if (value === undefined) {
      return { ok: false, action: "message", error: `message send requires a value after ${option}` };
    }
    if (option === "--choice") choices.push(value);
    else if (text === undefined) text = value;
    else return { ok: false, action: "message", error: "message send accepts --message once" };
  }
  return messageCommand(text ?? "", finish, choices);
}

function literalWord(word: WordNode | null | undefined): string | null {
  if (!word) return null;
  let value = "";
  for (const part of word.parts) {
    if (part.type === "Literal" || part.type === "SingleQuoted" || part.type === "Escaped") {
      value += part.value;
      continue;
    }
    if (part.type !== "DoubleQuoted") return null;
    const quoted = literalWord({ type: "Word", parts: part.parts });
    if (quoted === null) return null;
    value += quoted;
  }
  return value;
}
