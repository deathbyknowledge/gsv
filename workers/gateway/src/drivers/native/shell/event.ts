import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type { EventInput, EventSource, EventSourceSecretResult, EventSourceWebhook, NoticeDelivery, ShipOutcome } from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import type { KernelContext } from "../../../kernel/context";
import {
  handleEventEmit,
  handleEventList,
  handleEventSourceAdd,
  handleEventSourceList,
  handleEventSourceRemove,
  handleEventSourceRotate,
  handleEventSourceUpdate,
} from "../../../kernel/event-sources";
import { parseDurationMs, requireCommandCapability, requireShellOptionValue } from "./common";
import { decodeShellStdin } from "./stdin";

const MAX_EVENTS_PER_CALL = 100;

const USAGE = `Usage:
  event sources [--json]
  event source add NAME [--label TEXT] [--notify none|messenger] [--ship none|context|wake]
                        [--webhook none|standard|github|stripe|url] [--expect-every DURATION]
  event source update NAME [--label TEXT] [--notify none|messenger] [--ship none|context|wake]
                        [--pause|--resume] [--expect-every DURATION|never]
  event source rotate NAME
  event source remove NAME
  event emit SOURCE --title TEXT [--id ID] [--preview TEXT] [--body TEXT]
  event emit SOURCE --stdin      One JSON object per line: {"id","title","preview","body"}
  event list [SOURCE] [--limit N] [--json]

An id you repeat is ignored, so a script can re-read the same items without remembering them.
`;

const stdinEvent = z.strictObject({
  id: z.optional(z.string()),
  title: z.string(),
  preview: z.optional(z.string()),
  body: z.optional(z.string()),
});

const result = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

export function buildEventCommand(ctx: KernelContext) {
  return defineCommand("event", async (args, shell): Promise<ExecResult> => {
    try {
      return await runEventCommand(args, shell, ctx);
    } catch (error) {
      return { stdout: "", stderr: `event: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}

/** Splits `--name value` options from positional words; `flags` take no value. */
function parseOptions(args: string[], flags: readonly string[]) {
  const options = new Map<string, string>();
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) words.push(argument);
    else if (flags.includes(argument)) options.set(argument, "");
    else {
      options.set(argument, requireShellOptionValue(args[index + 1], argument));
      index += 1;
    }
  }
  return { options, words };
}

function secretLines({ secret, webhookUrl }: EventSourceSecretResult): string {
  return [
    ...(webhookUrl ? [`Address: ${webhookUrl}`] : []),
    ...(secret ? [`Signing secret: ${secret}`] : []),
    ...(webhookUrl || secret ? ["This is shown once."] : []),
  ].map((line) => `${line}\n`).join("");
}

function sourceLine(source: EventSource): string {
  return [source.name, source.enabled ? "on" : "paused", source.notify, source.ship, source.webhook, source.label].join("\t");
}

function readStdinEvents(shell: CommandContext): EventInput[] {
  return decodeShellStdin(shell.stdin).split("\n").filter((line) => line.trim()).map((line, index) => {
    const parsed = stdinEvent.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`line ${index + 1}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
}

async function runEventCommand(args: string[], shell: CommandContext, ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;
  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return result(USAGE);
    case "sources": {
      requireCommandCapability(ctx, "event.source.list");
      const { sources } = handleEventSourceList(ctx);
      if (rest.includes("--json")) return result(`${JSON.stringify({ sources })}\n`);
      return result(`${["NAME\tSTATE\tTELL\tSHIP\tWEBHOOK\tLABEL", ...sources.map(sourceLine)].join("\n")}\n`);
    }
    case "source":
      return runSourceCommand(rest, ctx);
    case "emit": {
      requireCommandCapability(ctx, "event.emit");
      const { options, words } = parseOptions(rest, ["--stdin"]);
      const [source] = words;
      if (!source || words.length > 1) throw new Error("emit requires: event emit SOURCE");
      const events: EventInput[] = options.has("--stdin") ? readStdinEvents(shell) : [{
        title: requireShellOptionValue(options.get("--title"), "--title"),
        ...(options.has("--id") ? { id: options.get("--id") } : undefined),
        ...(options.has("--preview") ? { preview: options.get("--preview") } : undefined),
        ...(options.has("--body") ? { body: options.get("--body") } : undefined),
      }];
      let accepted = 0;
      let duplicates = 0;
      for (let start = 0; start < events.length; start += MAX_EVENTS_PER_CALL) {
        const emitted = handleEventEmit({ source, events: events.slice(start, start + MAX_EVENTS_PER_CALL) }, ctx);
        accepted += emitted.accepted;
        duplicates += emitted.duplicates;
      }
      return result(`${accepted} accepted, ${duplicates} already seen\n`);
    }
    case "list": {
      requireCommandCapability(ctx, "event.list");
      const { options, words } = parseOptions(rest, ["--json"]);
      const limit = options.has("--limit") ? Number(options.get("--limit")) : undefined;
      const { events } = handleEventList({ ...(words[0] ? { source: words[0] } : undefined), ...(limit === undefined ? undefined : { limit }) }, ctx);
      if (options.has("--json")) return result(`${JSON.stringify({ events })}\n`);
      return result(events.map((event) => `${new Date(event.receivedAtMs).toISOString()}\t${event.emittedBy}\t${event.eventId}\t${event.title}\n`).join(""));
    }
    default:
      throw new Error(`unknown subcommand: ${subcommand}\n${USAGE}`);
  }
}

async function runSourceCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [action, ...rest] = args;
  const { options, words } = parseOptions(rest, ["--pause", "--resume"]);
  const [name] = words;
  if (!name || words.length > 1) throw new Error(`source ${action ?? ""} requires a NAME`);
  // SAFETY: the handlers validate these against their closed sets.
  const notify = options.get("--notify") as NoticeDelivery | undefined;
  // SAFETY: as above.
  const ship = options.get("--ship") as ShipOutcome | undefined;
  const label = options.get("--label");
  const expect = options.get("--expect-every");
  const shared = { name, ...(label ? { label } : undefined), ...(notify ? { notify } : undefined), ...(ship ? { ship } : undefined) };
  switch (action) {
    case "add": {
      requireCommandCapability(ctx, "event.source.add");
      const added = await handleEventSourceAdd({
        ...shared,
        // SAFETY: the handler validates this against its closed set.
        ...(options.has("--webhook") ? { webhook: options.get("--webhook") as EventSourceWebhook } : undefined),
        ...(expect ? { expectEveryMs: parseDurationMs(expect) } : undefined),
      }, ctx);
      return result(`Added ${added.source.name}.\n${secretLines(added)}`);
    }
    case "update": {
      requireCommandCapability(ctx, "event.source.update");
      const { source } = await handleEventSourceUpdate({
        ...shared,
        ...(options.has("--pause") ? { enabled: false } : options.has("--resume") ? { enabled: true } : undefined),
        ...(expect ? { expectEveryMs: expect === "never" ? null : parseDurationMs(expect) } : undefined),
      }, ctx);
      return result(`${sourceLine(source)}\n`);
    }
    case "rotate": {
      requireCommandCapability(ctx, "event.source.rotate");
      return result(secretLines(await handleEventSourceRotate({ name }, ctx)));
    }
    case "remove": {
      requireCommandCapability(ctx, "event.source.remove");
      return result(handleEventSourceRemove({ name }, ctx).removed ? `Removed ${name}.\n` : `No source named ${name}.\n`);
    }
    default:
      throw new Error(`unknown source action: ${action ?? ""}`);
  }
}
