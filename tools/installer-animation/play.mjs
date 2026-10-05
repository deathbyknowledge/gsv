import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const cached = JSON.parse(readFileSync(process.argv[2], "utf8"));
function scale(frame, sourceWidth, sourceHeight, width, height) {
  let color = "\x1b[0m";
  const lines = frame.split("\n").map(line => {
    const cells = [];
    for (const [index, run] of line.split("\x1b[").entries()) {
      let text = run;
      if (index > 0) {
        const end = run.indexOf("m");
        color = "\x1b[" + run.slice(0, end + 1);
        text = run.slice(end + 1);
      }
      for (const glyph of text) cells.push({ glyph, color });
    }
    return cells;
  });
  return Array.from({ length: height }, (_, y) => {
    const row = lines[Math.floor((y + 0.5) * sourceHeight / height)];
    let line = "", previous = "";
    for (let x = 0; x < width; x++) {
      const cell = row[Math.floor((x + 0.5) * sourceWidth / width)];
      if (cell.color !== previous) { line += cell.color; previous = cell.color; }
      line += cell.glyph;
    }
    return line;
  }).join("\n") + "\x1b[0m";
}
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
  let width = Math.min(20, Math.max(0, output.columns - 1)), height = 0, variant;
  if (output.columns > 56 && output.rows > 30) {
    width = output.columns - 1;
    height = Math.floor(width * 36 / 96);
    if (height > output.rows - 9) {
      height = output.rows - 9;
      width = Math.floor(height * 96 / 36);
    }
    variant = cached.reduce((best, candidate) => Math.abs(Math.log(candidate.cols / width)) < Math.abs(Math.log(best.cols / width)) ? candidate : best);
  }
  const step = frame < 75 ? "Downloading GSV" : frame < 165 ? "Installing" : "Ready";
  const left = " ".repeat(Math.max(0, Math.floor((output.columns - width) / 2)));
  const top = "\n".repeat(Math.max(0, Math.floor((output.rows - (height + 6)) / 2)));
  output.write(`\x1b[H${top}${left}${"GSV".slice(0, width)}\x1b[K\n\n`);
  if (variant) {
    const index = frame < 240 ? frame : 48 + (frame - 240) % 192;
    output.write(scale(variant.frames[index], variant.cols, variant.rows, width, height).split("\n").map(line => left + line).join("\n") + "\n\n");
  }
  const available = Math.max(0, output.columns - left.length - 1);
  output.write(`${left}\x1b[97m${step.slice(0, available)}\x1b[0m\x1b[K\n\n${left}\x1b[90m${"Preview · R to replay · Ctrl+C to close".slice(0, available)}\x1b[0m\x1b[J`);
  frame++;
  await delay(1000 / 12);
}
