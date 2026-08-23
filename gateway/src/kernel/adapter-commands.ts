import type { ProcListEntry } from "@humansandmachines/gsv/protocol";

export type AdapterCommandName = "help" | "list" | "where" | "home";

export type ParsedAdapterCommand = {
  name: AdapterCommandName | null;
  rawName: string;
  args: string[];
};

const COMMANDS: ReadonlyArray<{
  name: AdapterCommandName;
  description: string;
}> = [
  { name: "help", description: "show available commands" },
  { name: "list", description: "list personal home and work processes" },
  { name: "where", description: "show personal home or the selected work session" },
  { name: "home", description: "leave the work session and return to personal home" },
];

export function parseAdapterCommand(text: string): ParsedAdapterCommand | null {
  const parts = text.trim().split(/\s+/);
  const rawName = parts[0]?.toLowerCase() ?? "";
  if (!rawName.startsWith("/")) return null;
  const candidate = rawName.slice(1);
  const command = COMMANDS.find((entry) => entry.name === candidate);
  return {
    name: command?.name ?? null,
    rawName,
    args: parts.slice(1),
  };
}

export function renderAdapterCommandHelp(): string {
  return [
    "Commands:",
    ...COMMANDS.map((command) => `/${command.name} - ${command.description}`),
    "",
    "When approval is pending, reply approve, deny, or approve always.",
  ].join("\n");
}

export function renderAdapterProcessList(processes: ProcListEntry[]): string {
  const visible = processes.slice(0, 20);
  const personal = visible.find((process) => process.personal);
  const work = visible.filter((process) => !process.personal);
  const lines = [
    personal
      ? `[PERSONAL HOME] ${describeProcess(personal)}`
      : "[PERSONAL HOME] unavailable",
  ];
  if (work.length === 0) {
    lines.push("", "WORK: none");
  } else {
    lines.push("", "WORK:", ...work.map((process) => `- ${describeProcess(process)}`));
  }
  if (processes.length > visible.length) {
    lines.push(`…and ${processes.length - visible.length} more.`);
  }
  return lines.join("\n");
}

function describeProcess(process: ProcListEntry): string {
  const name = process.label?.trim() || process.username || process.pid;
  return `${name} [${process.state}] (${process.pid})`;
}
