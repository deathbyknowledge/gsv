import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(root, "web/public/brand/gsv-ship.png");
const scratch = await mkdtemp(join(tmpdir(), "gsv-icons-"));

const VOID = "#07061a";
const CURSOR = "#cbc7ff";
// The Ship's cursor on a 32 grid: a flat block to the left, leaving the lower-right corner to the tab attention dot.
const CURSOR_BLOCK = { x: 5, y: 9, width: 10, height: 14 };

function resize(size, destination) {
  execFileSync("magick", [source, "-filter", "Lanczos", "-resize", `${size}x${size}`,
    "-strip", "-define", "png:color-type=6", resolve(root, destination)], { stdio: "inherit" });
}

// Favicon-sized surfaces draw the cursor block snapped to whole pixels at each size, so every edge stays crisp.
function cursor(size, destination) {
  const scale = size / 32;
  const x = Math.round(CURSOR_BLOCK.x * scale), y = Math.round(CURSOR_BLOCK.y * scale);
  const width = Math.round(CURSOR_BLOCK.width * scale), height = Math.round(CURSOR_BLOCK.height * scale);
  execFileSync("magick", ["-size", `${size}x${size}`, `xc:${VOID}`, "-fill", CURSOR,
    "-draw", `rectangle ${x},${y} ${x + width - 1},${y + height - 1}`,
    "-strip", "-define", "png:color-type=6", resolve(root, destination)], { stdio: "inherit" });
}

for (const size of [192, 512]) {
  const icon = `web/public/icons/gsv-${size}.png`;
  resize(size, icon);
  // The approved square capture keeps the hull inside the central 80% circle.
  await copyFile(resolve(root, icon), resolve(root, `web/public/icons/gsv-maskable-${size}.png`));
}
resize(180, "web/public/icons/apple-touch-icon.png");

// The extension shows the cursor in the toolbar and the ship wherever the icon is larger.
for (const size of [16, 24, 32]) cursor(size, `extension/public/icons/gsv-${size}.png`);
for (const size of [48, 64, 96, 128, 256]) resize(size, `extension/public/icons/gsv-${size}.png`);

const favicon = resolve(root, "web/public/favicon.ico");
for (const size of [16, 32, 48]) cursor(size, join(scratch, `cursor-${size}.png`));
execFileSync("magick", [...[16, 32, 48].map((size) => join(scratch, `cursor-${size}.png`)), favicon], { stdio: "inherit" });
await copyFile(favicon, resolve(root, "docs/public/favicon.ico"));

// The desktop app icon is the ship at every size Windows asks for.
for (const size of [16, 32]) resize(size, join(scratch, `ship-${size}.png`));
execFileSync("magick", [
  join(scratch, "ship-16.png"), join(scratch, "ship-32.png"),
  ...[48, 64, 128, 256].map((size) => resolve(root, `extension/public/icons/gsv-${size}.png`)),
  resolve(root, "host/apps/desktop/icons/icon.ico"),
], { stdio: "inherit" });

// Embed the capture so SVG favicons do not depend on external fonts or images.
// The line above predates the cursor favicon and is kept for maintainer direction: the SVG now draws the cursor on its 32 grid, which has no font or image dependencies either.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" fill="${VOID}"/>
  <rect x="${CURSOR_BLOCK.x}" y="${CURSOR_BLOCK.y}" width="${CURSOR_BLOCK.width}" height="${CURSOR_BLOCK.height}" fill="${CURSOR}" shape-rendering="crispEdges"/>
</svg>
`;
for (const path of ["favicon.svg", "web/public/favicon.svg", "docs/favicon.svg", "docs/public/favicon.svg"]) {
  await writeFile(resolve(root, path), svg);
}

console.log("Generated the cursor favicons and the ship's Home Screen, desktop and extension icons from the approved capture.");
