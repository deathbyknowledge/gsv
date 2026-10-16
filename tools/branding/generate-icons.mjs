import { execFileSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(root, "web/public/brand/gsv-ship.png");

function resize(size, destination) {
  execFileSync("magick", [source, "-filter", "Lanczos", "-resize", `${size}x${size}`,
    "-strip", "-define", "png:color-type=6", resolve(root, destination)], { stdio: "inherit" });
}

for (const size of [192, 512]) {
  const icon = `web/public/icons/gsv-${size}.png`;
  resize(size, icon);
  // The approved square capture keeps the hull inside the central 80% circle.
  await copyFile(resolve(root, icon), resolve(root, `web/public/icons/gsv-maskable-${size}.png`));
}
resize(180, "web/public/icons/apple-touch-icon.png");

for (const size of [16, 24, 32, 48, 64, 96, 128, 256]) {
  resize(size, `extension/public/icons/gsv-${size}.png`);
}

const ico = resolve(root, "web/public/favicon.ico");
execFileSync("magick", [
  ...[16, 32, 48, 64, 128, 256].map((size) => resolve(root, `extension/public/icons/gsv-${size}.png`)),
  ico,
], { stdio: "inherit" });
await copyFile(ico, resolve(root, "host/apps/desktop/icons/icon.ico"));
await copyFile(ico, resolve(root, "docs/public/favicon.ico"));

// Embed the capture so SVG favicons do not depend on external fonts or images.
const png = await readFile(resolve(root, "web/public/icons/gsv-512.png"));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <image width="512" height="512" href="data:image/png;base64,${png.toString("base64")}" />
</svg>
`;
for (const path of ["favicon.svg", "web/public/favicon.svg", "docs/favicon.svg", "docs/public/favicon.svg"]) {
  await writeFile(resolve(root, path), svg);
}

console.log("Generated GSV favicons, Home Screen, desktop and extension icons from the approved ship capture.");
