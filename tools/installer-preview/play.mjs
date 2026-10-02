import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const cached = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!process.stdout.isTTY) throw new Error("Open the preview in a terminal.");
const output = process.stdout;
const clean = () => output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
process.on("exit", clean);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
// The labels simulate progress for this visual preview; no software is installed.
let frame = 0, previousSize = "";
while (true) {
  const size = `${output.columns}x${output.rows}`;
  if (size !== previousSize) { output.write("\x1b[2J"); previousSize = size; }
  const wide = output.columns >= 80 && output.rows >= 36;
  const frames = wide ? cached.wide : cached.narrow;
  const index = frame % frames.length;
  const step = index < 65 ? "Downloading GSV" : index < 145 ? "Installing" : "Ready";
  const width = wide ? 76 : 52;
  const left = " ".repeat(Math.max(0, Math.floor((output.columns - width) / 2)));
  const top = "\n".repeat(Math.max(0, Math.floor((output.rows - (wide ? 34 : 30)) / 2)));
  output.write(`\x1b[H${top}${left}GSV\x1b[K\n\n`);
  if (output.columns >= 52 && output.rows >= 30) {
    output.write(frames[index].split("\n").map(line => left + line).join("\n") + "\n\n");
  }
  output.write(`${left}\x1b[97m${step}\x1b[0m\x1b[K\n\n${left}\x1b[90mInstaller preview · Ctrl+C to close\x1b[0m\x1b[J`);
  frame++;
  await delay(1000 / 12);
}
