import type { Command } from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import { hasCapability } from "../../../kernel/capabilities";
import type { KernelContext } from "../../../kernel/context";
import {
  collectFilesystemSkillDocuments,
  collectKernelSkillDocuments,
} from "../../../kernel/skills";
import { handleSysMcpList } from "../../../kernel/sys/mcp";
import { listAllVisibleTargets } from "../../../kernel/targets";

export type ShellDiscoveryKind = "command" | "integration" | "target" | "workflow";

export type ShellDiscoveryEntry = {
  kind: ShellDiscoveryKind;
  name: string;
  summary: string;
  useWhen: string;
  keywords: string[];
  next: string;
  available: boolean;
  requirements?: string[];
  searchText?: string;
};

type NativeCommandDescriptor = Omit<
  ShellDiscoveryEntry,
  "available" | "kind" | "name" | "next" | "searchText"
> & {
  aliases?: string[];
  synopsis?: string[];
};
type NativeCommandDescriptorMap = { readonly [key: string]: NativeCommandDescriptor };
function defineNativeCommandDescriptors<T extends NativeCommandDescriptorMap>(value: T): NativeCommandDescriptorMap & T {
  return value;
}

const NATIVE_COMMAND_DESCRIPTORS = defineNativeCommandDescriptors({
  whoami: command("Print the current program account name.", "Identify which user or agent account the shell is running as.", ["identity", "account", "username"]),
  id: command("Print the current uid, gid, and supplementary groups.", "Inspect the current program identity and group membership.", ["identity", "permissions", "groups"]),
  hostname: command("Print the native GSV server name.", "Identify the GSV instance running the native shell.", ["server", "instance", "machine"]),
  uname: command("Print native GSV platform and version information.", "Inspect the operating environment or GSV version.", ["version", "platform", "system"]),
  chown: command("Change ownership metadata on GSV files.", "Change which GSV account owns a file or directory.", ["files", "owner", "permissions"]),
  chmod: command("Change permission metadata on GSV files.", "Make a GSV file readable, writable, or executable for the right users.", ["files", "permissions", "mode"]),
  ps: command("List GSV agent processes.", "See which agents or subprocesses currently exist and whether they are running.", ["agents", "processes", "jobs"]),
  man: command("Read or search the live GSV capability manual.", "Discover how to accomplish an unfamiliar task before guessing syntax or saying it is unsupported.", ["help", "discover", "search", "capabilities", "commands", "workflows"], [], ["man --search -- 'plain-language goal'", "man <topic>"]),
  ls: command("List GSV files and virtual directories.", "Inspect files in GSV, including home, process, system, and repository paths.", ["files", "folders", "directories"]),
  stat: command("Inspect GSV file metadata.", "Check whether a path exists and inspect its type, size, ownership, permissions, or content type.", ["files", "metadata", "size", "mime"]),
  cp: command("Copy files locally or between GSV targets.", "Move or copy a file between GSV, a connected machine, or a browser target, including photos and documents.", ["copy", "transfer", "file", "photo", "image", "document", "laptop", "machine", "device", "target"]),
  crontab: command("Manage recurring native shell jobs.", "Run a shell command repeatedly on a cron schedule such as every morning or each weekday.", ["schedule", "recurring", "automation", "cron", "daily", "weekly"], ["sched"]),
  codemode: command("Run a reusable JavaScript GSV tool workflow.", "Combine several shell, filesystem, or connected integration operations in one scripted workflow.", ["script", "workflow", "automation", "tools", "javascript"]),
  contact: command("Manage trusted contacts with other GSV Ships.", "Pair with another Ship, inspect contacts, exchange structured requests, revoke access, or discover a contact destination for messaging.", ["contact", "ship", "federation", "pair", "invite", "request", "revoke"], [], [
    "contact identity",
    "contact list [--all] [--json]",
    "contact invite create [--expires DURATION]",
    "contact invite accept CODE",
    "contact invite list [--all] [--json]",
    "contact invite cancel INVITE_ID",
    "contact revoke CONTACT_ID",
    "contact request list [--contact CONTACT_ID] [--all] [--json]",
    "contact request create --contact CONTACT_ID --kind KIND --title TITLE [--details JSON] [--delivery-id ID]",
    "contact request update REQUEST_ID --state STATE [--revision N] [--details JSON] [--delivery-id ID]",
  ]),
  mcp: command("Discover and call connected MCP integrations.", "Use an external connected service or search its available integration tools.", ["integration", "service", "connector", "api", "tools", "mcp"]),
  proc: command("Inspect, delegate to, message, and control GSV agent processes.", "Create a subagent, delegate a task, contact another agent, or inspect agent history and lifecycle.", ["agent", "subagent", "delegate", "process", "message", "history"]),
  r12y: command("Inspect and maintain durable unresolved responsibilities.", "Record work that must survive the current run, delegate it, defer it to a known wake condition, or close it with a durable outcome.", ["responsibility", "promise", "work", "task", "delegate", "waiting", "deadline", "outcome"], [], [
    "r12y list [--all] [--json]",
    "r12y show ID",
    "r12y sources",
    "r12y source enable|disable SOURCE_ID",
    "r12y create --title TITLE [OPTIONS]",
    "r12y update ID --json PATCH",
    "r12y wait ID [--until ISO] [--blocker TEXT]",
    "r12y resolve ID [--json RESOLUTION]",
  ]),
  message: command("Send messages, attach files, and route conversations.", "Send an update to the current conversation without finishing the run, attach files to the next message, send to an adapter or trusted GSV contact, inspect the directed endpoint, open a private work direct line, or route a group, channel, or thread to a process.", ["chat", "reply", "send", "update", "attachment", "file", "image", "photo", "audio", "document", "route", "conversation", "contact", "ship", "work", "group", "channel", "thread"], [], [
    "message current [--json]",
    "message destinations [--all] [--json]",
    "message route show [--to here|DESTINATION] [--json]",
    "message route list [--json]",
    "message route set --process PID_OR_LABEL [--to here|DESTINATION] [--json]",
    "message route clear [--to here|DESTINATION] [--json]",
    "message attach PATH... [--mime TYPE]",
    "message history --with CONTACT_OR_CONVERSATION [--before SEQUENCE] [--limit N] [--json]",
    "message delivery show DELIVERY_ID [--json]",
    "message send [--message TEXT]",
    "message send --to DESTINATION [--message TEXT] [--attach PATH]... [--mime TYPE] [--delivery-id ID] [--also]",
  ]),
  yield: command("Finish the active agent run.", "Yield control after the current work is complete while keeping the durable Process available for future input.", ["finish", "complete", "done", "stop", "silent"], [], ["yield"]),
  mail: command("Read, send, reply to, and inspect managed email.", "Send email, reply to an inbox message, or check whether a queued email was accepted.", ["email", "inbox", "send", "reply", "status", "delivery"], [], [
    "mail send --to ADDRESS --subject SUBJECT (--message TEXT | --body PATH) [--delivery-id ID]",
    "mail reply MESSAGE_ID [--subject SUBJECT] (--message TEXT | --body PATH) [--delivery-id ID]",
    "mail status DELIVERY_ID",
  ]),
  rgit: command("Inspect and commit staged ripgit repository changes.", "Work with GSV repo-backed source, diffs, history, branches, or commits.", ["git", "repository", "source", "diff", "commit"], ["ripgit"]),
  ripgit: command("Alias for the rgit repository command.", "Work with GSV repo-backed source, diffs, history, branches, or commits.", ["git", "repository", "source", "diff", "commit"], ["rgit"]),
  sched: command("Create and inspect Kernel schedules and delayed prompts.", "Send a prompt later, wake the current process, or inspect scheduled work.", ["schedule", "reminder", "recurring", "automation", "later", "timer"], ["crontab"], [
    "sched list [--all]",
    "sched add --ship --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE",
    "sched add --here --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE",
    "sched add --to DESTINATION --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE",
    "sched add --json JSON",
    "sched enable <id>",
    "sched disable <id>",
    "sched remove <id>",
    "sched run <id> [--force]",
  ]),
  targets: command("Discover connected execution targets.", "Find where work can run, including a laptop, phone, or browser profile.", ["device", "machine", "laptop", "browser", "phone", "hardware", "target"], ["devices"]),
  devices: command("Alias for connected-target discovery.", "Find a connected machine, browser profile, or other execution target.", ["device", "machine", "laptop", "browser", "hardware", "target"], ["targets"]),
  net: command("Make a streamed HTTP request through GSV or another target.", "Fetch a URL or call an HTTP API with explicit request and response control.", ["http", "network", "url", "download", "api", "fetch"]),
  "gsv-fetch": command("Compatibility form of the native streamed HTTP client.", "Fetch a URL or call an HTTP API from GSV.", ["http", "network", "url", "download", "api", "fetch"], ["net"]),
  oauth: command("Inspect and manage OAuth connections.", "Connect, inspect, or forget a provider account used by GSV.", ["login", "account", "provider", "authentication", "oauth"]),
  llm: command("Generate one text response without running an agent loop.", "Perform a one-shot text generation, rewrite, classification, or summarization.", ["ai", "text", "generate", "summarize", "rewrite", "classify"], [], ["llm [OPTIONS] PROMPT..."], ["ai.text.generate"]),
  img2txt: command("Caption, query, OCR, point at, or detect objects in a local or target image with Moondream.", "Understand, inspect, OCR, locate, detect, or describe a photo, picture, screenshot, or image file on GSV or a connected target.", ["image", "photo", "picture", "screenshot", "vision", "ocr", "caption", "query", "point", "detect", "locate", "describe", "read", "device", "target"], [], [
    "img2txt [caption] [OPTIONS] IMAGE",
    "img2txt query --prompt TEXT [OPTIONS] IMAGE",
    "img2txt ocr [OPTIONS] IMAGE",
    "img2txt point --target TEXT [OPTIONS] IMAGE",
    "img2txt detect --target TEXT [OPTIONS] IMAGE",
  ], ["ai.image.read"]),
  txt2img: command("Generate an image file from a text prompt.", "Create, draw, or generate a picture, photo, illustration, or image from words.", ["image", "photo", "picture", "illustration", "draw", "create", "generate"], [], ["txt2img [OPTIONS] -o PATH PROMPT..."], ["ai.image.generate"]),
  stt: command("Transcribe an audio file to text.", "Listen to, understand, or transcribe a voice note, recording, speech, or audio file.", ["audio", "voice", "voice-note", "recording", "speech", "listen", "transcribe"], [], ["stt [OPTIONS] AUDIO"], ["ai.transcription.create"]),
  tts: command("Synthesize spoken audio from text.", "Create a voice message, spoken reply, narration, or audio file from text.", ["audio", "voice", "speak", "speech", "narration", "voice-message"], [], ["tts [OPTIONS] -o PATH TEXT..."], ["ai.speech.create"]),
  skills: command("Inspect and maintain reusable agent workflows stored in skills.d.", "Create, open, or update procedural memory for a workflow that should be repeatable later.", ["workflow", "procedure", "automation", "skill", "instructions", "playbook", "create", "save", "persist", "reuse", "repeat"], [], [
    "skills list [skill]",
    "skills tree [skill]",
    "skills search <query>",
    "skills show <skill>",
    "skills files <skill>",
    "skills read <skill> <file>",
    "skills create <name> --description <text> [--from <body-file>] [--replace]",
    "skills validate <skill-or-path>",
  ]),
  wiki: command("Search and maintain durable repo-backed knowledge.", "Remember, retrieve, organize, or refresh durable notes, facts, decisions, and reference material.", ["knowledge", "memory", "notes", "search", "wiki", "reference", "manual", "refresh"], [], ["wiki refresh gsv-manual"]),
  flynn: command("Print the GSV version banner.", "Inspect the GSV release banner or project easter egg.", ["version", "banner", "gsv"]),
});

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "be", "by", "can", "do", "for", "from", "how", "i", "in", "into",
  "is", "it", "me", "my", "of", "on", "please", "some", "that", "the", "this", "to", "want", "with",
]);

export class ShellDiscoveryCatalog {
  private readonly commands = new Map<string, ShellDiscoveryEntry>();

  constructor(
    private readonly fs: GsvFs,
    private readonly identity: ProcessIdentity,
    private readonly ctx: KernelContext,
  ) {}

  registerCommands(commands: readonly Command[]): void {
    for (const registered of commands) {
      if (this.commands.has(registered.name)) continue;
      const metadata = NATIVE_COMMAND_DESCRIPTORS[registered.name]
        ?? command(
          `Run the ${registered.name} shell command.`,
          `Use the ${registered.name} command for the requested workflow.`,
          [registered.name, "command"],
        );
      const requirements = metadata.requirements ?? [];
      const missing = requirements.filter((capability) =>
        !hasCapability(this.ctx.identity?.capabilities ?? [], capability)
      );
      const entry: ShellDiscoveryEntry = {
        kind: "command",
        name: registered.name,
        summary: metadata.summary,
        useWhen: metadata.useWhen,
        keywords: [...metadata.keywords, ...(metadata.aliases ?? [])],
        next: `man ${quoteShellWord(registered.name)}`,
        available: missing.length === 0,
      };
      if (missing.length > 0) entry.requirements = missing;
      this.commands.set(registered.name, entry);
    }
  }

  renderIndex(): string {
    const lines = [
      "GSV live capability manual",
      "",
      "Start from what you want to accomplish:",
      "  man --search -- 'plain-language goal'",
      "  man -k 'plain-language goal'",
      "",
      "Registered native commands:",
    ];
    for (const entry of [...this.commands.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(`  ${entry.name.padEnd(12)} ${entry.summary}`);
    }
    lines.push("", "Open exact command guidance with `man <command>`.", "");
    return lines.join("\n");
  }

  renderCommandManual(topic: string): string | null {
    const entry = this.commands.get(topic.trim().toLowerCase());
    if (!entry) return null;
    const synopsis = nativeCommandSynopsis(entry.name) ?? [`${entry.name} --help`];
    return [
      `${entry.name.toUpperCase()}(1)`,
      "",
      "NAME",
      `  ${entry.name} - ${entry.summary}`,
      "",
      "WHEN TO USE",
      `  ${entry.useWhen}`,
      "",
      "SYNOPSIS",
      ...synopsis.map((line) => `  ${line}`),
      ...(entry.requirements?.length
        ? ["", "CURRENT AVAILABILITY", `  Missing capabilities: ${entry.requirements.join(", ")}`]
        : []),
      "",
      "DISCOVERY",
      "  Use `man --search -- 'plain-language goal'` to find related commands and workflows.",
      "",
    ].join("\n");
  }

  async search(query: string): Promise<ShellDiscoveryEntry[]> {
    const entries = [
      ...this.commands.values(),
      ...await this.skillEntries(),
      ...await this.targetEntries(),
      ...this.integrationEntries(),
    ];
    return rankShellDiscoveryEntries(entries, query).map(stripSearchText);
  }

  private async skillEntries(): Promise<ShellDiscoveryEntry[]> {
    try {
      const filesystemDocs = await collectFilesystemSkillDocuments(this.fs, this.ctx, this.identity);
      // Fall back to the same persisted registry used for prompt assembly when
      // a caller has no materialized home mount yet.
      const docs = filesystemDocs.length > 0
        ? filesystemDocs
        : await collectKernelSkillDocuments(this.ctx);
      return docs.map((doc) => ({
        kind: "workflow" as const,
        name: doc.id,
        summary: doc.description || `Reusable workflow ${doc.name}.`,
        useWhen: doc.description || `Use the ${doc.name} reusable workflow.`,
        keywords: nonEmptyStrings([...doc.aliases, doc.name, doc.parentId]),
        searchText: doc.content,
        next: `skills show ${quoteShellWord(doc.id)}`,
        available: true,
      }));
    } catch {
      return [];
    }
  }

  private async targetEntries(): Promise<ShellDiscoveryEntry[]> {
    if (!hasCapability(this.ctx.identity?.capabilities ?? [], "sys.device.list")) {
      return [];
    }
    try {
      return (await listAllVisibleTargets(this.ctx)).map((target) => {
        const entry: ShellDiscoveryEntry = {
        kind: "target" as const,
        name: target.targetId,
        summary: target.description || target.label || `${target.platform || "Connected"} target.`,
        useWhen: `Run work on ${target.label || target.targetId}, a connected ${target.platform || "device"} target.`,
        keywords: nonEmptyStrings([target.label, target.platform, "device", ...target.implements]),
        next: `targets show ${quoteShellWord(target.targetId)}`,
        available: target.online,
        };
        if (!target.online) entry.requirements = ["target online"];
        return entry;
      });
    } catch {
      return [];
    }
  }

  private integrationEntries(): ShellDiscoveryEntry[] {
    if (!hasCapability(this.ctx.identity?.capabilities ?? [], "sys.mcp.list")) {
      return [];
    }
    try {
      return handleSysMcpList({}, this.ctx).servers.flatMap((server) => {
        if (server.state !== "ready") return [];
        return server.tools.map((tool) => ({
          kind: "integration" as const,
          name: `${server.name}/${tool.name}`,
          summary: tool.description || `${tool.name} from the ${server.name} integration.`,
          useWhen: tool.description || `Use the ${server.name} integration to run ${tool.name}.`,
          keywords: [server.name, server.serverId, tool.name],
          next: `mcp describe ${quoteShellWord(server.name)} ${quoteShellWord(tool.name)}`,
          available: true,
        }));
      });
    } catch {
      return [];
    }
  }
}

export function rankShellDiscoveryEntries(
  entries: Iterable<ShellDiscoveryEntry>,
  query: string,
  limit = 10,
): ShellDiscoveryEntry[] {
  const normalizedQuery = normalizeText(query);
  const queryTokens = significantTokens(normalizedQuery);
  if (!normalizedQuery || queryTokens.length === 0) return [];

  return [...entries]
    .map((entry) => ({ entry, score: discoveryScore(entry, normalizedQuery, queryTokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || Number(right.entry.available) - Number(left.entry.available)
      || left.entry.name.localeCompare(right.entry.name)
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function nativeCommandSynopsis(name: string): readonly string[] | null {
  const synopsis = NATIVE_COMMAND_DESCRIPTORS[name.trim().toLowerCase()]?.synopsis;
  return synopsis?.length ? synopsis : null;
}

export function formatShellDiscoveryResults(
  query: string,
  entries: readonly ShellDiscoveryEntry[],
): string {
  if (entries.length === 0) {
    return [
      `No live GSV capability matched: ${query}`,
      "Try a shorter goal using its main action and object, such as `man --search -- 'send image'`.",
      "",
    ].join("\n");
  }
  const lines = [
    `Matches for: ${query}`,
    "TYPE\tNAME\tAVAILABLE\tWHY\tNEXT",
  ];
  for (const entry of entries) {
    const availability = entry.available
      ? "yes"
      : `no${entry.requirements?.length ? ` (${entry.requirements.join(", ")})` : ""}`;
    lines.push([
      entry.kind,
      entry.name,
      availability,
      singleLine(entry.summary),
      entry.next,
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function discoveryScore(
  entry: ShellDiscoveryEntry,
  normalizedQuery: string,
  queryTokens: string[],
): number {
  const name = normalizeText(entry.name);
  const summary = normalizeText(entry.summary);
  const useWhen = normalizeText(entry.useWhen);
  const keywords = normalizeText(entry.keywords.join(" "));
  const body = normalizeText(entry.searchText ?? "");
  const nameTokens = significantTokens(name);
  const primaryTokens = new Set(significantTokens(`${name} ${summary} ${useWhen} ${keywords}`));
  const bodyTokens = new Set(significantTokens(body));

  let score = name === normalizedQuery ? 120 : 0;
  let matched = 0;
  for (const token of queryTokens) {
    if (nameTokens.includes(token)) {
      score += 18;
      matched += 1;
    } else if (primaryTokens.has(token)) {
      score += 10;
      matched += 1;
    } else if ([...primaryTokens].some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))) {
      score += 5;
      matched += 1;
    } else if (bodyTokens.has(token)) {
      score += 2;
      matched += 1;
    }
  }
  score += matched * matched * 2;
  if (matched === queryTokens.length) score += 12;
  return score;
}

function significantTokens(value: string): string[] {
  return [...new Set(value.split(/\s+/).map(normalizeToken).filter((token) => token && !STOP_WORDS.has(token)))];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripSearchText(entry: ShellDiscoveryEntry): ShellDiscoveryEntry {
  const result = { ...entry };
  delete result.searchText;
  return result;
}

function quoteShellWord(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function command(
  summary: string,
  useWhen: string,
  keywords: string[],
  aliases: string[] = [],
  synopsis?: string[],
  requirements?: string[],
): NativeCommandDescriptor {
  const descriptor: NativeCommandDescriptor = {
    summary,
    useWhen,
    keywords,
  };
  if (aliases.length > 0) descriptor.aliases = aliases;
  if (synopsis) descriptor.synopsis = synopsis;
  if (requirements) descriptor.requirements = requirements;
  return descriptor;
}

function nonEmptyStrings(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}
