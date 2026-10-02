import { writeFileSync } from "node:fs";
import { createShipScene } from "../../web/src/app/features/session/backgrounds/ship/shipScene";

// Generated from the UI's Voyager. Installation playback will only print cached frames.
function render(cols: number, rows: number) {
const scene = createShipScene({ cols, rows, aspect: 2 });
scene.prepare();
const frames: string[] = [];
for (let frame = 0; frame < 180; frame++) {
  const { foreground, nebula = "", stars = "" } = scene.frame(frame / 12, true, "dark");
  const layers = [nebula, foreground, stars];
  let output = "", color = -1;
  for (let i = 0; i < foreground.length; i++) {
    if (foreground[i] === "\n") { output += "\n"; continue; }
    const layer = stars[i] !== " " ? 2 : foreground[i] !== " " ? 1 : nebula[i] !== " " ? 0 : -1;
    if (layer !== color && layer !== -1) {
      output += `\x1b[38;5;${[240, 250, 255][layer]}m`;
      color = layer;
    }
    output += layer === -1 ? " " : layers[layer][i];
  }
  frames.push(`${output}\x1b[0m`);
}
return frames;
}
writeFileSync(process.argv[2], JSON.stringify({ wide: render(76, 28), narrow: render(52, 24) }));
