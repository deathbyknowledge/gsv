import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createSatelliteScene } from "./satellite";

// Render once during development; terminal playback only prints cached frames.
function render(cols: number, rows: number) {
  const scene = createSatelliteScene(cols, rows);
  const frames: string[] = [];
  for (let frame = 0; frame < 240; frame++) {
    const { foreground, nebula = "", stars = "" } = scene.frame(frame / 12);
    const layers = [nebula, foreground, stars];
    let output = "", color = -1;
    for (let i = 0; i < foreground.length; i++) {
      if (foreground[i] === "\n") { output += "\n"; continue; }
      const layer = stars[i] !== " " ? 2 : foreground[i] !== " " ? 1 : nebula[i] !== " " ? 0 : -1;
      if (layer !== color && layer !== -1) {
        output += ["\x1b[0;38;5;244m", "\x1b[0;39m", "\x1b[1;39m"][layer];
        color = layer;
      }
      output += layer === -1 ? " " : layers[layer][i];
    }
    frames.push(`${output}\x1b[0m`);
  }
  return { cols, rows, frames };
}
const variants = [render(192, 72), render(96, 36), render(76, 28), render(56, 22)];
const release = variants.flatMap(({ cols, rows, frames }) => frames.map(frame => `${cols} ${rows}\n${frame}\f`)).join("");
writeFileSync(process.argv[2], process.argv.includes("--release") ? gzipSync(release, { level: 9 }) : JSON.stringify(variants));
