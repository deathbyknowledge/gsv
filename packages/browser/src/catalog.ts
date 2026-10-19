import type { BrowserCommand } from "./types";

export function commandMap(commands: BrowserCommand[]): Map<string, BrowserCommand> {
  return new Map(commands.map((command) => [command.name, command]));
}

export function helpText(commands: BrowserCommand[]): string {
  const rows = commands
    .map((command) => `  ${command.name.padEnd(12)} ${command.summary}`)
    .join("\n");
  return [
    "GSV browser target shell commands",
    "",
    rows,
    "",
    "Run `<command> --help` for command-specific usage.",
    "",
  ].join("\n");
}

export function commandCatalog(commands: BrowserCommand[]): string {
  return `${JSON.stringify({
    commands: commands.map((command) => ({
      name: command.name,
      summary: command.summary,
      help: `${command.name} --help`,
    })),
  })}\n`;
}
