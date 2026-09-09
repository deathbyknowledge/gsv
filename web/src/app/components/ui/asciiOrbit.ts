import type { AsciiAnimationScene } from "./AsciiAnimation";

const ROTATION_RATE = 0.18;
export const ASCII_ORBIT_PERIOD = Math.PI / (6 * ROTATION_RATE);

/** A rotating wire sphere: a second scene using the same glyph host, with no galaxy particles or text targets. */
export function createAsciiOrbit({ cols = 200, rows = 72 }: { cols?: number; rows?: number } = {}): AsciiAnimationScene {
  const ramp = " ·:+*#@";
  const radius = Math.min(rows * 0.28, cols / 4);
  const latitudeSteps = Math.max(24, Math.ceil(radius * 12));
  const longitudeSteps = Math.max(12, Math.ceil(radius * 6));
  return {
    stillAt: 4,
    frame(seconds) {
      const cells = new Float32Array(cols * rows);
      const turn = seconds * ROTATION_RATE;
      const plot = (latitude: number, longitude: number) => {
        const x = Math.cos(latitude) * Math.cos(longitude + turn);
        const y = Math.sin(latitude);
        const z = Math.cos(latitude) * Math.sin(longitude + turn);
        const tiltX = x * Math.cos(0.35) - y * Math.sin(0.35);
        const tiltY = x * Math.sin(0.35) + y * Math.cos(0.35);
        const column = Math.round((cols - 1) / 2 + tiltX * radius * 1.65);
        const row = Math.round((rows - 1) / 2 + tiltY * radius);
        if (column < 0 || column >= cols || row < 0 || row >= rows) return;
        const index = row * cols + column;
        cells[index] = Math.max(cells[index], 0.25 + (z + 1) * 0.36);
      };
      for (let latitude = -2; latitude <= 2; latitude += 1) {
        for (let step = 0; step < latitudeSteps; step += 1) plot(latitude * Math.PI / 6, step * Math.PI * 2 / latitudeSteps);
      }
      for (let longitude = 0; longitude < 12; longitude += 1) {
        for (let step = 0; step <= longitudeSteps; step += 1) plot(-Math.PI / 2 + step * Math.PI / longitudeSteps, longitude * Math.PI / 6);
      }
      const lines: string[] = [];
      for (let row = 0; row < rows; row += 1) {
        let line = "";
        for (let column = 0; column < cols; column += 1) {
          const level = cells[row * cols + column];
          line += level === 0 ? " " : ramp[Math.max(1, Math.min(ramp.length - 1, Math.floor(level * ramp.length)))];
        }
        lines.push(line);
      }
      return { foreground: lines.join("\n") };
    },
  };
}
