import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const cached = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error("Open the preview in a terminal.");
const output = process.stdout;
const clean = () => {
  process.stdin.setRawMode(false);
  output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
};
process.on("exit", clean);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
let frame = 0, previousSize = "";
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", key => {
  if (key.toString() === "\x03") process.exit(0);
  if (key.toString().toLowerCase() === "r") frame = 0;
});
// These stages are simulated; this visual preview does not install software.
while (true) {
  const size = `${output.columns}x${output.rows}`;
  if (size !== previousSize) { output.write("\x1b[2J"); previousSize = size; }
  const variant = cached.find(({ cols, rows }) => cols < output.columns && rows + 8 < output.rows);
  const step = frame < 75 ? "Downloading GSV" : frame < 165 ? "Installing" : "Ready";
  const width = variant?.cols ?? 44;
  const left = " ".repeat(Math.max(0, Math.floor((output.columns - width) / 2)));
  const top = "\n".repeat(Math.max(0, Math.floor((output.rows - ((variant?.rows ?? 0) + 8)) / 2)));
  output.write(`\x1b[H${top}${left}GSV\x1b[K\n\n`);
  if (variant) {
    const index = frame < 240 ? frame : 48 + (frame - 240) % 192;
    output.write(variant.frames[index].split("\n").map(line => left + line).join("\n") + "\n\n");
  }
  output.write(`${left}\x1b[97m${step}\x1b[0m\x1b[K\n\n${left}\x1b[90mPreview · R to replay · Ctrl+C to close\x1b[0m\x1b[J`);
  frame++;
  await delay(1000 / 12);
}
