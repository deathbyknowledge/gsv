import { Bash, type SimpleCommandNode, type StatementNode, type WordNode } from "just-bash";

const runControlBash = new Bash({ commands: [] });

type RunControlCommand =
  | { action: "message"; text: string; finish: boolean }
  | { action: "yield" };

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
  if (hasAdditionalSendFlag(args.slice(1))) return null;
  if (command.redirections.length > 0) {
    return parseMessageHeredoc(input, command, finish);
  }
  if (!args.every((arg): arg is string => arg !== null)) {
    return parseOpaqueMessageSend(messageSource(input, finish), finish);
  }
  const parsed = parseMessageSend(args.slice(1), finish);
  return parsed.ok
    ? parsed
    : (parseOpaqueMessageSend(messageSource(input, finish), finish) ?? parsed);
}

function parseMessageHeredoc(
  input: string,
  command: SimpleCommandNode,
  finish: boolean,
): RunControlCommandParseResult | null {
  if (command.args.length !== 1 || command.redirections.length !== 1) return null;
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
  if (lines.at(-1) === "") lines.pop();
  lines.pop();
  const text = lines
    .slice(1)
    .map((line) => (heredoc.stripTabs ? line.replace(/^\t+/, "") : line))
    .join("\n");
  return { ok: true, command: { action: "message", text, finish } };
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
  const text = rawText.trim();
  const quote = text[0];
  const unwrapped =
    text.length >= 2 && (quote === "'" || quote === '"') && text.at(-1) === quote
      ? text.slice(1, -1)
      : text;
  return { ok: true, command: { action: "message", text: unwrapped, finish } };
}

function hasAdditionalSendFlag(args: Array<string | null>): boolean {
  const optionsWithValues = new Set(["--message", "--to", "--attach", "--mime", "--delivery-id"]);
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--also") return true;
    if (current && optionsWithValues.has(current)) index += 1;
  }
  return false;
}

function parseMessageSend(args: string[], finish: boolean): RunControlCommandParseResult {
  if (args.length === 0) {
    return { ok: true, command: { action: "message", text: "", finish } };
  }
  if (args[0] !== "--message") {
    return {
      ok: false,
      action: "message",
      error: `message send does not accept ${args[0]} for the current conversation`,
    };
  }
  if (args.length === 1) {
    return {
      ok: false,
      action: "message",
      error: "message send requires a value after --message",
    };
  }
  if (args.length > 2) {
    const repeated = args.slice(2).includes("--message");
    return {
      ok: false,
      action: "message",
      error: repeated
        ? "message send accepts --message once"
        : `message send does not accept ${args[2]} for the current conversation`,
    };
  }
  return { ok: true, command: { action: "message", text: args[1], finish } };
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
